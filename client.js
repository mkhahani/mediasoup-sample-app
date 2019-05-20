const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;
let producer;

const $ = document.querySelector.bind(document);
const btnConnect = $('#btn_connect');
const btnPublish = $('#btn_publish');
const btnSubscribe = $('#btn_subscribe');
const txtConnection = $('#connection_status');
const txtPublish = $('#pub_status');
const txtSubscription = $('#sub_status');

btnConnect.addEventListener('click', connect);
btnPublish.addEventListener('click', publish);
btnSubscribe.addEventListener('click', subscribe);

async function connect() {
  btnConnect.disabled = true;
  txtConnection.innerHTML = 'Connecting...';

  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    txtConnection.innerHTML = 'Connected';
    btnPublish.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    txtConnection.innerHTML = 'Disconnected';
    btnConnect.disabled = false;
    btnPublish.disabled = true;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    txtConnection.innerHTML = 'Connection failed';
    btnConnect.disabled = false;
  });

  socket.on('newProducer', () => {
    btnSubscribe.disabled = false;
  });
}

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish() {
  txtPublish.innerHTML = 'publishing...';
  btnPublish.disabled = true;
  const data = await socket.request('createProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  const transport = device.createSendTransport(data);

  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const { id } = await socket.request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  try {
    await startWebcam(transport);
  } catch (err) {
    txtPublish.innerHTML = 'failed';
    return;
  }
  txtPublish.innerHTML = 'published';
  btnSubscribe.disabled = false;
}

async function startWebcam(transport) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    console.error('starting webcam failed,', err.message);
    throw err;
  }
  const track = stream.getVideoTracks()[0];
  document.querySelector('#local_video').srcObject = stream;
  producer = await transport.produce({ track });
}

async function subscribe() {
  txtSubscription.innerHTML = 'subscribing...';
  btnSubscribe.disabled = true;

  const data = await socket.request('createConsumerTransport', {
    forceTcp: false,
  });

  const transport = device.createRecvTransport(data);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.request('connectConsumerTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  await consume(transport);
  txtSubscription.innerHTML = 'subscribed';
}

async function consume(transport) {
  const { rtpCapabilities } = device;
  const data = await socket.request('consume', { rtpCapabilities });
  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });
  const stream = new MediaStream();
  stream.addTrack(consumer.track);
  document.querySelector('#remote_video').srcObject = stream;
}
