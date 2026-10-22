// Programmatic Electron regression, NOT native Edge/Chrome focus acceptance.
// Uses an isolated profile, synthetic screenshots and a localhost model only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 180_000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
void run().catch(e => { console.error(e); require('electron').app.exit(1); });

async function run() {
  const { app, safeStorage, Menu, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron');
  const { createServer } = require('node:http');
  const qa = path.resolve(root, '..', 'window-qa'); fs.mkdirSync(qa, { recursive: true });
  const profile = fs.mkdtempSync(path.join(qa, 'profile-'));
  process.env.MC_USERDATA = profile; app.setPath('userData', profile); app.setAppPath(root);
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, label) {
    for (let n = 0; n < 160; n++) { if (await fn()) return; await pause(40); }
    throw Error('Timed out: ' + label);
  }
  let win, template, requests = 0, aborted = 0, encodes = 0;
  const originalMenu = Menu.buildFromTemplate;
  Menu.buildFromTemplate = function(items) { template = items; return originalMenu.call(this, items); };
  const timer = setTimeout(() => app.exit(1), 165_000);
  await app.whenReady();
  const server = createServer(async (req, res) => {
    for await (const _part of req) { /* synthetic request body intentionally not logged */ }
    requests++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': waiting for synthetic cancellation\n\n');
    res.on('close', () => aborted++);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const key = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString('fake-window-qa').toString('base64') : 'plain:' + Buffer.from('fake-window-qa').toString('base64');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ version: 2, onboarding: { schemaVersion: 1, completed: true },
    llm: { baseUrl: url, model: 'fake', apiKeyEnc: key }, vision: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', apiKeyEnc: key, verification: {lastTestOk:false,lastTestCode:'UNKNOWN_ERROR'} },
    asr: { backend: 'cloud', cloud: { baseUrl: url, model: 'fake', apiKeyEnc: key } },
    ui: { lang: 'zh', theme: 'dark', stealth: true, hotkeyToggle: '', hotkeyShot: '' } }));
  fs.writeFileSync(path.join(profile, 'sessions.json'), JSON.stringify({ currentId: 'qa', sessions: [{ id: 'qa', name: 'Window QA', createdAt: 1, questionQueueVersion: 1,
    segments: [], pendingQuestion: [{ id: 'heard-1', segmentId: 1, text: 'synthetic pending question' }], turns: [
      { id: 'previous', kind: 'vision', label: 'synthetic screenshot', text: '', status: 'streaming' },
    ] }] }));
  const display = screen.getPrimaryDisplay(); const width = Math.round(display.size.width * display.scaleFactor), height = Math.round(display.size.height * display.scaleFactor);
  const image = nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 180), { width, height });
  const encode = image.toDataURL.bind(image); image.toDataURL = () => { encodes++; return encode(); };
  desktopCapturer.getSources = async () => [{ id: 'screen:qa:0', name: 'synthetic', display_id: String(display.id), thumbnail: image }];
  app.on('browser-window-created', (_e, w) => { if (!win) win = w; });
  require('../out/main/index.js');
  const js = code => {
    let timeout;
    return Promise.race([win.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Renderer IPC timeout')), 4000); })])
      .finally(() => clearTimeout(timeout));
  };
  await until(async () => win && await js('document.querySelector(".session-picker > button")?.textContent.includes("Window QA") && !!window.__mcOpenSettings'), 'loaded session');
  const menu = label => { const item = template.find(i => i.label === label); assert(item?.click, 'Menu entry ' + label); item.click(); };
  assert.equal(await js('window.mc.getWindowMode()'), 'browse'); assert.equal(win.isFocusable(), false);
  assert.equal(await js('window.mc.getSettings().then(s=>s.vision.model)'), 'mimo-v2.6-flash');
  assert.equal(await js('document.body.textContent.includes("V2.6")'), true, 'model migration must be visible to the user');
  assert.equal(await js('document.querySelectorAll(".turn-error").length || document.body.textContent.includes("中断")'), true);
  let styleWrites = 0, focusEvents = 0, nativeHides = 0;
  win.on('hide', () => nativeHides++);
  const setFocusable = win.setFocusable.bind(win); win.setFocusable = value => { styleWrites++; return setFocusable(value); };
  win.on('focus', () => focusEvents++);
  for (let i = 0; i < 20; i++) {
    menu('隐藏窗口'); await pause(10);
    assert.equal(win.getOpacity(), 0); assert(win.isVisible(), 'parked render widget stays mapped');
    menu('显示窗口'); assert.equal(win.getOpacity(), 1);
    assert.equal(await js('window.mc.getWindowMode()'), 'browse');
  }
  menu('隐藏窗口');
  const idleMs = Number(process.env.MC_IDLE_QA_MS || 1500);
  console.log('[window-lifecycle] waiting hidden for ' + idleMs + 'ms');
  await pause(idleMs); menu('显示窗口');
  assert.equal(await js('document.querySelector(".brand").textContent'), 'MeetingBot');
  assert.equal(styleWrites, 0, 'browse wakes must not repeat native activation-style writes');
  assert.equal(focusEvents, 0, 'programmatic browse display must not emit window focus');
  assert.equal(nativeHides, 0, 'Windows tray hiding must not unmap the render widget');
  // Dispatch Chromium mouse events instead of calling the button's callback.
  // This tests renderer event delivery, not native Windows hit-testing.
  const point = await js('(()=>{const r=document.querySelector(".session-picker > button").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await until(() => js('!!document.querySelector(".session-menu")'), 'mouse input after tray wake');
  await js('document.querySelector(".session-option").click()');
  console.log('[window-lifecycle] repeated hide/show and hidden-idle IPC passed');
  await js('window.__qaShot="pending"; void window.mc.pickRegion().then(x => window.__qaShot = x === null ? "cancelled" : "selected");');
  let region;
  await until(async () => { region = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'MeetingBot Region'); return region && !region.webContents.isLoading() && await region.webContents.executeJavaScript('!!document.querySelector("#cancel")'); }, 'region overlay');
  assert.equal(region.isFocusable(), false); assert.equal(region.getOpacity(), 0.99); assert(region.isContentProtected());
  for (let i = 0; i < 3; i++) await region.webContents.executeJavaScript('window.mc.regionImage()');
  assert.equal(encodes, 1, 'synthetic screenshot must encode once');
  await region.webContents.executeJavaScript('window.mc.regionCancel()');
  await until(() => js('window.__qaShot === "cancelled"'), 'region cancelled');
  assert(region.isDestroyed()); assert.equal(focusEvents, 0);
  console.log('[window-lifecycle] translucent region, cached image and destroy-on-cancel passed');
  await js('window.mc.captureStarted(); window.mc.llmAsk({requestId:"window-qa-stream",mode:"free",freeQuestion:"synthetic",recentTranscript:[]});');
  await until(() => requests > 0, 'local model received request');
  const oldPid = win.webContents.getOSProcessId(); win.emit('unresponsive');
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Recovered renderer did not finish loading')), 20_000);
    win.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
  });
  menu('恢复界面（停止录音和生成）');
  await loaded;
  await until(async () => win.webContents.getOSProcessId() !== oldPid && !win.webContents.isLoading() && await js('document.body.textContent.includes("界面已恢复")'), 'interface recovery');
  await until(() => aborted > 0, 'generation aborted');
  assert.equal(win.isFocusable(), false); assert.equal(focusEvents, 0);
  assert(template.some(i => i.label === '开始转写'), 'recovery must stop capture state');
  assert.equal(await js('document.querySelector(".session-picker > button").textContent.includes("Window QA")'), true);
  await until(() => fs.existsSync(path.join(profile, 'window-faults.json')), 'fault log written');
  const faults = fs.readFileSync(path.join(profile, 'window-faults.json'), 'utf8');
  assert(faults.includes('unresponsive')); assert(!faults.includes('fake-window-qa')); assert(!faults.includes('synthetic pending question'));
  console.log('[window-lifecycle] recovery, generation abort, capture reset, saved session and sanitized fault log passed');
  fs.writeFileSync(path.join(qa, 'result.json'), JSON.stringify({ passed: true, idleMs, styleWrites, focusEvents, nativeHides, chromiumMouseInput: true, nativeBrowserAcceptance: 'not tested' }, null, 2));
  clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); app.quit();
}
