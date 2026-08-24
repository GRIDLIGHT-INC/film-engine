import fs from 'node:fs';

const tabs = await (await fetch('http://127.0.0.1:9228/json')).json();
const tab = tabs.find(t => t.type === 'page');
if (!tab) throw new Error('no Chrome page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');
await new Promise(r => setTimeout(r, 1200));

const expression = `(async () => {
  openProject('69568dd0-878a-4c5e-8c8d-2d13f23f4c51');
  await new Promise(r => setTimeout(r, 800));
  navigateTo('previs');
  await new Promise(r => setTimeout(r, 1800));
  const dragon = PREVIS.models.find(m => /dragon/i.test(m.label)) || PREVIS.models[0];
  if (!dragon) throw new Error('DRAGON model missing from live catalogue');
  PREVIS.objects = [{
    kind: 'mesh', assetId: dragon.id, name: 'DRAGON', isTarget: true,
    position: [0, 0, 0], sizeM: [15, dragon.declaredHeightM || 20, 15],
    rotationDeg: [0, 0, 0], src: ''
  }];
  PREVIS.selected = 0;
  document.getElementById('previsCameraX').value = 0;
  document.getElementById('previsHeight').value = 8;
  document.getElementById('previsDistance').value = 30;
  document.getElementById('previsCameraYaw').value = 0;
  document.getElementById('previsCameraPitch').value = 0;
  document.getElementById('previsCameraRoll').value = 0;
  document.getElementById('previsFocal').value = 35;
  previsRenderObjects();
  previsRefresh();
  await new Promise(r => setTimeout(r, 3500));
  previsRefresh();
  await new Promise(r => setTimeout(r, 500));
  const canvas = document.getElementById('previsCameraSolid');
  const rect = canvas.parentElement.getBoundingClientRect();
  return {
    dragon, ready: !!CAMERA3D.assets.get(dragon.id), instances: CAMERA3D.instances.children.length,
    renderer: !!CAMERA3D.renderer, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    webgl: canvas.getContext('webgl2') || canvas.getContext('webgl') ? true : false
  };
})()`;
const evaluated = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const value = evaluated.result.value;
const shot = await send('Page.captureScreenshot', {
  format: 'png', captureBeyondViewport: false,
  clip: { ...value.rect, scale: 1 },
});
fs.writeFileSync('/tmp/previs-dragon-camera.png', Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify(value));
ws.close();
