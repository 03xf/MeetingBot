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
  const { app, safeStorage, Menu, BrowserWindow, desktopCapturer, nativeImage, screen, dialog, shell, globalShortcut, clipboard, ipcMain } = require('electron');
  const { createServer } = require('node:http');
  const qa = path.resolve(root, '..', 'window-qa'); fs.mkdirSync(qa, { recursive: true });
  const profile = fs.mkdtempSync(path.join(qa, 'profile-'));
  process.env.MC_USERDATA = profile; app.setPath('userData', profile); app.setAppPath(root);
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, label) {
    for (let n = 0; n < 160; n++) { if (await fn()) return; await pause(40); }
    throw Error('Timed out: ' + label);
  }
  let win, template, requests = 0, aborted = 0, encodes = 0, visionRequests = 0;
  let copied;
  clipboard.writeText = text => { copied = text; }; // never replace the user's clipboard
  const shortcuts = new Map();
  globalShortcut.unregisterAll = () => shortcuts.clear();
  globalShortcut.isRegistered = key => shortcuts.has(key);
  globalShortcut.register = (key, callback) => { if (key === 'occupied') return false; if (key === 'invalid') throw Error('synthetic accelerator error'); shortcuts.set(key, callback); return true; };
  let fileDialogs = 0, shellCalls = 0, selection = [];
  dialog.showOpenDialog = async () => { fileDialogs++; return { canceled: !selection.length, filePaths: selection }; };
  shell.openExternal = async () => { shellCalls++; };
  shell.openPath = async () => { shellCalls++; return ''; };
  const originalMenu = Menu.buildFromTemplate;
  Menu.buildFromTemplate = function(items) { template = items; return originalMenu.call(this, items); };
  const timer = setTimeout(() => app.exit(1), 165_000);
  await app.whenReady();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (body.model === 'fake-shot') {
      visionRequests++;
      assert(body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,'))));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '截图按钮回归通过' } }] }));
      return;
    }
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
    ui: { lang: 'zh', theme: 'dark', stealth: true, hotkeyToggle: '', hotkeyShot: 'Control+Alt+F10', hotkeyConfirm: 'Control+Alt+Enter' } }));
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
    return Promise.race([win.webContents.executeJavaScript(code, true).catch(error=>{console.error('[fixture-script]',code);throw error}),
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
  await js('window.__blocked=[];window.mc.onInteractionBlocked(e=>window.__blocked.push(e.action));window.__mcOpenSettings();document.querySelector("button[title=重命名当前会话]").click();document.querySelector(".answer-input button").click();');
  await until(() => js('document.body.textContent.includes("请手动切换到编辑模式")'), 'locked hint');
  assert.equal(await js('!!document.querySelector("#custom-answer-prompt") || !!document.querySelector("input.session-select")'), false);
  assert.equal(await js('window.mc.rerunOnboarding()'), false);
  assert.equal(await js('window.mc.openExternal("https://github.com/03xf/MeetingBot/releases")'), false);
  assert.equal(await js('window.mc.openLogsFolder()'), false);
  assert.equal(await js('window.mc.pickKnowledge("resume")'), null);
  assert.equal((await js('window.mc.importKnowledge()')).documents.length, 0);
  menu('设置'); menu('检查更新');
  assert.equal(fileDialogs, 0); assert.equal(shellCalls, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(await js('window.mc.getWindowMode()'), 'browse'); assert.equal(win.isFocusable(), false);
  await until(()=>js('["setup","external","data-folder","import","settings"].every(a=>window.__blocked.includes(a))'),'blocked action notifications');
  assert.equal(focusEvents,0); assert.equal(styleWrites,0);
  await pause(100); // let the compositor paint the notice before the preview
  fs.writeFileSync(path.join(qa,'browse-lock.png'),(await win.webContents.capturePage()).toPNG());
  console.log('[window-lifecycle] UI, direct IPC, tray and external actions respect browse lock');
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
  menu('隐藏窗口');
  const confirmKey = 'Control+Alt+Enter';
  assert(shortcuts.has(confirmKey));
  shortcuts.get(confirmKey)();
  await until(()=>js('document.body.textContent.includes("等待采集就绪")'),'range requires running capture');
  assert.equal(requests,0);
  await js('document.querySelector(".titlebar-actions button:nth-child(2)").click()');

  await until(()=>requests>0,'manual confirmation reaches local model');
  await until(()=>js('Array.from(document.querySelectorAll(".turn-head button")).some(b=>b.textContent==="停")'),'stop generation available');
  assert.equal(requests,1,'manual confirmation submits once');
  assert.equal(win.getOpacity(),0,'answer shortcut must leave the window hidden');
  menu('显示窗口');
  await js('Array.from(document.querySelectorAll(".turn-head button")).find(b=>b.textContent==="停").click()');
  await until(()=>aborted>0,'stop button aborts generation');
  // Hold only the finalization marker, to exercise cancellation while ASR is pending.
  const cutHandler=ipcMain.listeners('asr:cut')[0];let heldCut;
  ipcMain.removeListener('asr:cut',cutHandler);
  ipcMain.once('asr:cut',(_event,id)=>{heldCut=id});
  await js('document.querySelector(".titlebar-actions button:nth-child(2)").click()');await until(()=>!!heldCut,'cut waiting');
  await until(()=>js('document.body.textContent.includes("正在整理截断前的问题")'),'waiting indicator');
  const requestCount=requests;await js('document.querySelector(".titlebar-actions button:nth-child(2)").click()');
  await until(()=>js('!document.body.textContent.includes("正在整理截断前的问题")'),'waiting submission cancelled');
  win.webContents.send('asr:event',{kind:'cut',requestId:heldCut});
  await pause(100);assert.equal(requests,requestCount,'late finalization must not submit after stop');
  ipcMain.on('asr:cut',cutHandler);
  await js('document.querySelector(".turn-head button").click();document.querySelector(".session").scrollTop=0');
  await until(()=>copied!==undefined,'copy through main clipboard interface');
  assert.equal(focusEvents,0);assert.equal(win.isFocusable(),false);
  await js('window.__qaShot="pending"; void window.mc.pickRegion().then(x => window.__qaShot = x === null ? "cancelled" : "selected");');
  let region;
  await until(async () => { region = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'MeetingBot Region'); return region && !region.webContents.isLoading() && await region.webContents.executeJavaScript('!!document.querySelector("#cancel")'); }, 'region overlay');
  assert.equal(region.isFocusable(), false); assert.equal(region.getOpacity(), 0.99); assert(region.isContentProtected());
  for (let i = 0; i < 3; i++) await region.webContents.executeJavaScript('window.mc.regionImage()');
  assert.equal(encodes, 1, 'synthetic screenshot must encode once');
  await region.webContents.executeJavaScript('window.mc.regionCancel()');
  await until(() => js('window.__qaShot === "cancelled"'), 'region cancelled');
  assert(region.isDestroyed()); assert.equal(focusEvents, 0);
  async function selectionCase(action) {
    await js('window.__qaShot="pending";void window.mc.pickRegion().then(x=>window.__qaShot=x?"selected":"cancelled")');
    let overlay;
    await until(async()=>{overlay=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='MeetingBot Region');return overlay&&!overlay.webContents.isLoading()&&await overlay.webContents.executeJavaScript('!!document.querySelector("#cancel")')},'selection case');
    await action(overlay);
    await until(()=>js('window.__qaShot!=="pending"'),'selection settled');
    assert(overlay.isDestroyed()); assert.equal(focusEvents,0);
  }
  await selectionCase(ov=>ov.webContents.executeJavaScript('document.querySelector("#cancel").click()'));
  await selectionCase(ov=>ov.webContents.executeJavaScript('dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))'));
  await selectionCase(()=>js('window.mc.pickRegion()'));
  await selectionCase(()=>shortcuts.get('Control+Alt+F10')());
  await selectionCase(ov=>ov.webContents.executeJavaScript('window.mc.regionRect({x:1,y:1,width:1,height:1})'));
  await selectionCase(ov=>ov.webContents.executeJavaScript('window.mc.regionRect({x:20,y:20,width:80,height:60})'));
  assert.equal(await js('window.__qaShot'), 'selected');
  await selectionCase(ov=>ov.webContents.forcefullyCrashRenderer());
  const capture = desktopCapturer.getSources;
  desktopCapturer.getSources = async()=>{throw Error('synthetic capture failure')};
  assert.equal(await js('window.mc.pickRegion()'),null);desktopCapturer.getSources=capture;
  await js('window.__displayMedia=navigator.mediaDevices.getDisplayMedia;navigator.mediaDevices.getDisplayMedia=async()=>{throw new DOMException("synthetic denial","NotAllowedError")};document.querySelector(".titlebar-actions button").click()');
  await pause(100);
  await js('navigator.mediaDevices.getDisplayMedia=window.__displayMedia;void 0');
  assert.equal(await js('window.mc.getWindowMode()'),'browse');assert.equal(focusEvents,0);
  assert.equal(await js('!!document.querySelector("#custom-answer-prompt")'),false);
  console.log('[window-lifecycle] translucent region, cached image and destroy-on-cancel passed');
  // Click the visible toolbar button via Chromium mouse events. This tests
  // renderer delivery, not native Windows hit-testing or third-party pages.
  async function clickScreenshot() {
    await until(()=>js('!!document.querySelector(".screenshot-action")&&!document.querySelector(".screenshot-action").disabled'),'screenshot button ready');
    const point = await js('(()=>{const r=document.querySelector(".screenshot-action").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  async function screenshotOverlay() {
    let overlay;
    await until(async()=>{overlay=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='MeetingBot Region');return overlay&&!overlay.webContents.isLoading()&&await overlay.webContents.executeJavaScript('!!document.querySelector("#cancel")')},'button screenshot overlay');
    return overlay;
  }
  assert.equal(await js('window.mc.getSettings().then(s=>s.llm.answerWithVision)'),false);
  assert.equal(await js('document.querySelector(".screenshot-action").textContent.includes("截图提问")'),true);
  await js(`window.mc.setSettings({vision:{baseUrl:${JSON.stringify(url)},model:'fake-shot',apiKey:'fake-shot-only'}})`);
  await clickScreenshot();const cancelledShot=await screenshotOverlay();
  await cancelledShot.webContents.executeJavaScript('window.mc.regionCancel()');
  await until(()=>cancelledShot.isDestroyed(),'button screenshot cancel');assert.equal(visionRequests,0);
  await clickScreenshot();const selectedShot=await screenshotOverlay();
  await selectedShot.webContents.executeJavaScript('window.mc.regionRect({x:20,y:20,width:80,height:60})');
  await until(()=>js('document.body.textContent.includes("截图按钮回归通过")'),'button screenshot answered');
  assert.equal(visionRequests,1);assert.equal(focusEvents,0);assert.equal(win.isFocusable(),false);
  assert.equal(await js('window.mc.getSettings().then(s=>s.llm.answerWithVision)'),false);
  for (const width of [640, 940]) {
    win.setSize(width,700);await pause(100);
    assert.equal(await js('Array.from(document.querySelectorAll(".titlebar button")).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})'),true,'toolbar buttons fit the window');
  }
  win.webContents.invalidate();await pause(100);
  fs.writeFileSync(path.join(qa,'screenshot-button.png'),(await win.webContents.capturePage()).toPNG());
  // The recovery below reloads the renderer with this unconfigured vision slot.
  await js('window.mc.setSettings({vision:{apiKey:""}})');
  const requestsBeforeRecovery=requests,abortedBeforeRecovery=aborted;
  const retainedSessionName=await js('document.querySelector(".session-picker > button").textContent');
  await js('window.mc.captureStarted(); window.mc.llmAsk({requestId:"window-qa-stream",mode:"free",freeQuestion:"synthetic",recentTranscript:[]});');
  await until(() => requests > requestsBeforeRecovery, 'local model received request');
  const oldPid = win.webContents.getOSProcessId(); win.emit('unresponsive');
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Recovered renderer did not finish loading')), 20_000);
    win.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
  });
  menu('恢复界面（停止录音和生成）');
  await loaded;
  await until(async () => win.webContents.getOSProcessId() !== oldPid && !win.webContents.isLoading() && await js('document.body.textContent.includes("界面已恢复")'), 'interface recovery');
  await until(() => aborted > abortedBeforeRecovery, 'generation aborted');
  assert.equal(win.isFocusable(), false); assert.equal(focusEvents, 0);
  assert(template.some(i => i.label === '开始转写'), 'recovery must stop capture state');
  assert.equal(await js('document.querySelector(".session-picker > button").textContent'), retainedSessionName);
  await until(() => fs.existsSync(path.join(profile, 'window-faults.json')), 'fault log written');
  const faults = fs.readFileSync(path.join(profile, 'window-faults.json'), 'utf8');
  assert(faults.includes('unresponsive')); assert(!faults.includes('fake-window-qa')); assert(!faults.includes('synthetic pending question'));
  console.log('[window-lifecycle] recovery, generation abort, capture reset, saved session and sanitized fault log passed');
  const beforeMissingShot=encodes;await clickScreenshot();
  await until(()=>js('document.body.textContent.includes("再点击截图提问")'),'missing vision setup hint');
  assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(encodes,beforeMissingShot);assert.equal(visionRequests,1);
  assert.equal(await js('!!document.querySelector("#custom-answer-prompt")'),false);
  assert.equal(focusEvents,0);assert.equal(win.isFocusable(),false);
  console.log('[window-lifecycle] screenshot toolbar button: text mode, cancel, actual vision request, missing-config hint and browse mode passed');
  await js('window.mc.setSettings({ui:{hotkeyConfirm:"occupied"}})');
  assert.deepEqual(await js('window.mc.getHotkeyFailures()'),['occupied']);
  await until(()=>js('document.body.textContent.includes("快捷键注册失败")'),'registration error visible');
  await js('window.mc.setSettings({ui:{hotkeyConfirm:"invalid"}})');
  assert.deepEqual(await js('window.mc.getHotkeyFailures()'),['invalid']);
  await js('window.mc.setSettings({ui:{hotkeyConfirm:"Control+Alt+F9"}})');
  assert.equal(shortcuts.has(confirmKey),false);assert(shortcuts.has('Control+Alt+F9'));
  assert.deepEqual(await js('window.mc.getHotkeyFailures()'),[]);
  await until(()=>js('!document.body.textContent.includes("快捷键注册失败")'),'registration error cleared');
  await js('window.mc.setSettings({ui:{hotkeyConfirm:""}})');assert.equal(shortcuts.has('Control+Alt+F9'),false);
  assert.equal(focusEvents,0);assert.equal(win.isFocusable(),false);
  console.log('[window-lifecycle] manual confirmation, range readiness, rebind, disable and registration failures passed');
  const browseFocusEvents=focusEvents,browseStyleWrites=styleWrites;
  await js('document.querySelector(".interaction-mode").click()');
  await until(()=>js('window.mc.getWindowMode().then(m=>m==="edit")'),'explicit edit');
  await js('window.__mcOpenSettings()');
  await until(()=>js('!!document.querySelector("#custom-answer-prompt")'),'settings in edit');
  await js('Array.from(document.querySelectorAll(".settings-actions button")).find(b=>b.textContent==="取消").click()');
  await until(()=>js('window.mc.getWindowMode().then(m=>m==="browse")'),'settings cancel returns browse');
  await js('window.mc.setWindowMode("edit")'); assert.equal(await js('window.mc.pickKnowledge("resume")'),null);
  assert.equal(await js('window.mc.getWindowMode()'),'browse');assert.equal(fileDialogs,1);
  const fixture=path.join(profile,'fixture.txt');fs.writeFileSync(fixture,'synthetic library import');selection=[fixture];
  await js('window.mc.setWindowMode("edit")');assert.equal((await js('window.mc.importKnowledge()')).documents.length,1);
  assert.equal(await js('window.mc.getWindowMode()'),'browse');selection=[];
  for (const key of ['Escape','Enter']) {
    await js('window.mc.setWindowMode("edit")');await js('document.querySelector("button[title=重命名当前会话]").click()');
    await until(()=>js('!!document.querySelector("input.session-select")'),'rename in edit');
    await js(`document.querySelector("input.session-select").dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(key)},bubbles:true}))`);
    await until(()=>js('window.mc.getWindowMode().then(m=>m==="browse")'),'rename finish returns browse');
  }
  await js('window.mc.setWindowMode("edit")'); assert.equal(await js('window.mc.rerunOnboarding()'),true);
  await until(()=>BrowserWindow.getAllWindows().some(w=>w!==win),'setup opened');
  BrowserWindow.getAllWindows().find(w=>w!==win).close();
  await until(()=>js('window.mc.getWindowMode().then(m=>m==="browse")'),'setup close returns browse');
  console.log('[window-lifecycle] explicit editing, settings cancel, file cancel/import, rename and setup return to browse');
  fs.writeFileSync(path.join(qa, 'result.json'), JSON.stringify({ passed: true, idleMs, styleWrites:browseStyleWrites, focusEvents:browseFocusEvents, nativeHides, chromiumMouseInput: true, browseLock:true, editCompletion:true, nativeBrowserAcceptance: 'not tested' }, null, 2));
  clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); app.quit();
}
