const mediasoup = require('mediasoup');
const https = require('https');
const fs = require('fs');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');

// Global variables
let worker;
let httpsServer;
let socketServer;
let expressApp;
let producer;
let consumer;
let producerTransport;
let consumerTransport;
let mediasoupRouter;

(async () => {
  try {
    await runExpressApp();
    await runHttpsServer();
    await runWebSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp () {
  console.info('creating Express app...');

  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runHttpsServer () {
  console.info('running HTTPS server...');

  // HTTPS server for the WebSocket server
  const tls = {
    cert: fs.readFileSync(config.sslCrt),
    key: fs.readFileSync(config.sslKey),
  };
  httpsServer = https.createServer(tls, expressApp);
  httpsServer.on('error', (err) => {
    console.error('starting HTTPS server failed,', err.message);
  });

  await new Promise((resolve) => {
    httpsServer.listen(config.listenPort, config.listenIp, () => {
      console.log(`server is running and listening on ${config.listenIp}:${config.listenPort}`);
      resolve();
    });
  });
}

async function runWebSocketServer () {
  console.info('running web socket server...');

  socketServer = socketIO(httpsServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  socketServer.on('connection', (socket) => {
    console.log('client connected');

    // inform the client about existence of producer
    if (producer) {
      socket.emit('newProducer');
    }

    socket.on('disconnect', () => {
      console.log('client disconnected');
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      console.log('getRouterRtpCapabilities');
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on('createProducerTransport', async (data, callback) => {
      console.log('createProducerTransport');
      const { transport, params } = await createWebRtcTransport();
      producerTransport = transport;
      callback(params);
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      console.log('createConsumerTransport');
      const { transport, params } = await createWebRtcTransport();
      consumerTransport = transport;
      callback(params);
    });

    socket.on('connectProducerTransport', async (data, callback) => {
      console.log('connectProducerTransport');
      await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      console.log('connectConsumerTransport');
      await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('produce', async (data, callback) => {
      console.log('produce');
      const {kind, rtpParameters} = data;
      producer = await producerTransport.produce({ kind, rtpParameters });
      callback({ id: producer.id });

      // inform clients about new producer
      socket.broadcast.emit('newProducer');
    });

    socket.on('consume', async (data, callback) => {
      console.log('consume');
      callback(await createConsumer(producer, data.rtpCapabilities));
    });

    socket.on('newConsumer', async () => {
      console.log('newConsumer');
      // if is video, resume the Consumer to ask for an efficient key frame
      if (producer.kind === 'video') {
        await consumer.resume();
      }
    });
  });
}

async function runMediasoupWorker () {
  worker = await mediasoup.createWorker({
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup Worker died, exiting in 2 seconds... [pid:%d]', worker.pid);

    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport () {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

async function createConsumer (producer, rtpCapabilities) {
  if (!mediasoupRouter.canConsume(
    {
      producerId: producer.id,
      rtpCapabilities,
    })
  ) {
    console.warn('can not consume');
    return;
  }
  try {
    consumer = await consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities: rtpCapabilities,
      paused: producer.kind === 'video',
    });
  } catch (error) {
    console.warn('createConsumer() | transport.consume():%o', error);
    return;
  }

  return {
    producerId: producer.id,
    id: consumer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused
  };
}
