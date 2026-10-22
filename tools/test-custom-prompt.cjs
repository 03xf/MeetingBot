// Isolated Electron UI -> saved settings -> actual HTTP request verification.
// Uses only fake credentials, localhost and synthetic questions, never real audio.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const qa = path.resolve(root, '..', 'prompt-qa');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  fs.mkdirSync(qa, { recursive: true });
  const profile = path.join(qa, 'profile-' + Date.now(), 'MeetingCopilot');
  const env = { ...process.env, MC_PROMPT_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const phase of ['save', 'restart']) {
    const result = spawnSync(require('electron'), [__filename, phase], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 60_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log('[custom-prompt] UI save, real model requests and restart passed; transparency preview, rollback, both themes and persistence passed; browse/edit IPC and renderer state passed (programmatic, not native focus acceptance)');
} else {
  void run().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function run() {
  const { app, safeStorage } = require('electron');
  const { createServer } = require('node:http');
  const profile = process.env.MC_PROMPT_TEST_PROFILE;
  assert(profile && path.dirname(path.dirname(profile)) === qa);
  fs.mkdirSync(profile, { recursive: true });
  // Restart uses the old directory under an isolated appData root WITHOUT the
  // override: prove that the renamed application still loads existing data.
  app.setPath('appData', path.dirname(profile));
  if (process.argv[2] === 'restart') delete process.env.MC_USERDATA;
  else { process.env.MC_USERDATA = profile; app.setPath('userData', profile); }
  app.setAppPath(root);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(fn, label) {
    for (let n = 0; n < 200; n++) { if (await fn()) return; await pause(40); }
    throw Error('Timed out: ' + label);
  }
  const requests = [];
  const prompt = '用自然口语详细回答，不限制字数。\n代码使用 Java。测试标记：PROMPT_SAVE_中文';
  const edited = '修改后立即生效：PROMPT_EDIT。\n不要用第一人称，逐步解释。';
  const timer = setTimeout(() => app.exit(1), 45_000);
  await app.whenReady();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '本地测试回答' } }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '本地测试回答' } }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const settingsFile = path.join(profile, 'settings.json');
  const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  if (process.argv[2] === 'restart') assert.equal(saved.llm.customPrompt, prompt);
  const apiKeyEnc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString('fake-test-only').toString('base64') : 'plain:' + Buffer.from('fake-test-only').toString('base64');
  fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, version: 2, onboarding: { schemaVersion: 1, completed: true },
    llm: { ...saved.llm, baseUrl: url, model: 'fake', apiKeyEnc },
    vision: { baseUrl: url, model: 'fake-vision', apiKeyEnc },
    asr: { backend: 'cloud', cloud: { baseUrl: url, model: 'fake', apiKeyEnc } },
    ui: { ...saved.ui, lang: 'zh', theme: 'dark', stealth: false, hotkeyToggle: '', hotkeyShot: '' },
  }));
  const sessionsFile = path.join(profile, 'sessions.json');
  if (!fs.existsSync(sessionsFile)) fs.writeFileSync(sessionsFile, JSON.stringify({ currentId: 'opacity-qa', sessions: [{
    id: 'opacity-qa', name: '界面验证', createdAt: 1, titled: true, segments: [], pendingQuestion: [], questionQueueVersion: 1,
    turns: [{ id: 'preview-answer', kind: 'free', label: '示例回答', status: 'done', text: '## 回答示例\n\n背景可以透明，文字保持清晰。\n\n```java\nclass Solution {\n    int answer = 42;\n}\n```' }],
  }] }));
  app.on('browser-window-created', (_event, window) => { if (!win) win = window; });
  require('../out/main/index.js');
  await until(async () => win && await js('typeof window.__mcOpenSettings === "function" && !!document.querySelector(".answer-code-block") && document.querySelector(".session-picker > button").textContent.includes("界面验证")'), 'main UI and loaded sessions');
  assert.equal(app.getName(), 'MeetingBot');
  assert.equal(app.getPath('userData'), profile);
  assert.equal(await js('document.title'), 'MeetingBot');
  assert.equal(await js('document.querySelector(".brand").textContent'), 'MeetingBot');
  if (process.platform === 'win32') {
    assert.equal(await js('window.mc.getWindowMode()'), 'browse', 'every launch must default to browse');
    assert.equal(win.isFocusable(), false);
    await until(() => js('document.querySelector(".answer-input input").disabled'), 'browse input disabled');
    await assert.rejects(js('window.mc.setWindowMode("invalid")'), /Invalid window mode/);
    await js('document.querySelector(".session-picker > button").click()');
    try { await until(() => js('!!document.querySelector(".session-menu")'), 'in-page session menu'); }
    catch (error) {
      console.error('[mode-state]', await js('JSON.stringify({picker:document.querySelector(".session-picker").outerHTML,mode:document.querySelector(".interaction-mode").textContent,visibility:document.visibilityState})'));
      throw error;
    }
    assert.equal(win.isFocusable(), false, 'opening the menu must not enable focus');
    await js('document.querySelector(".session-option").click()');
    await until(() => js('!document.querySelector(".session-menu")'), 'session selection');
    await js('document.querySelector(".interaction-mode").click()');
    await until(() => js('window.mc.getWindowMode().then(m=>m==="edit")'), 'explicit edit switch');
    await js('window.__mcOpenSettings()');
    await until(() => js('!!document.querySelector("#custom-answer-prompt")'), 'explicit settings editing');
    assert.equal(await js('window.mc.getWindowMode()'), 'edit');
    assert.equal(win.isFocusable(), true);
    await js('document.querySelector(".interaction-mode").click()');
    await until(() => js('!document.querySelector("#custom-answer-prompt") && document.querySelector(".answer-input input").disabled'), 'return to browse');
    assert.equal(await js('window.mc.getWindowMode()'), 'browse');
    assert.equal(win.isFocusable(), false);
  }

  async function open() {
    if (process.platform === 'win32') {
      await js('window.mc.setWindowMode("edit")');
    }
    await js('window.__mcOpenSettings()');
    await until(() => js('!!document.querySelector("#custom-answer-prompt")'), 'prompt editor');
  }
  async function save(value) {
    await open();
    await js(`(()=>{const e=document.querySelector('#custom-answer-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await pause(50);
    await js(`document.querySelector('.settings-actions .btn-primary').click()`);
    await until(() => js('!document.querySelector("#custom-answer-prompt")'), 'saved');
    if (process.platform === 'win32') assert.equal(await js('window.mc.getWindowMode()'), 'browse', 'saving settings restores browse');
    assert.equal(await js('window.mc.getSettings().then(s=>s.llm.customPrompt)'), value);
  }
  async function slider(transparency) {
    await js(`(()=>{const e=document.querySelector('#background-transparency');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(transparency))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => js(`Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue('--background-opacity'))-${1 - transparency / 100})<0.001`), 'live alpha');
  }
  const cancelPanel = () => js(`Array.from(document.querySelectorAll('.settings-actions button')).find(e=>e.textContent==='取消').click()`);
  async function savePanel() {
    await js(`document.querySelector('.settings-actions .btn-primary').click()`);
    await until(() => js('!document.querySelector("#background-transparency")'), 'panel saved');
    if (process.platform === 'win32') assert.equal(await js('window.mc.getWindowMode()'), 'browse', 'saving appearance restores browse');
  }
  async function checkAppearance(alpha) {
    await until(() => js(`Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue('--background-opacity'))-${alpha})<0.001`), 'saved alpha');
    assert.equal(win.getOpacity(), 1, 'native window opacity must not dim content');
    const style = await js(`(()=>{const css=s=>getComputedStyle(document.querySelector(s));return {background:css('.app').backgroundColor,app:css('.app').opacity,text:css('.answer-markdown').opacity,button:css('.titlebar .btn').opacity,code:css('.answer-code-block').backgroundColor}})()`);
    const rgba = style.background.match(/[\d.]+/g).map(Number);
    assert(Math.abs((rgba[3] ?? 1) - alpha) < 0.001, 'background alpha follows the setting');
    assert.equal(style.app, '1'); assert.equal(style.text, '1'); assert.equal(style.button, '1');
    assert(style.code.startsWith('rgb('), 'code background remains opaque');
  }
  async function ask(mode, expected, vision = false) {
    const requestId = 'test-' + requests.length;
    const start = requests.length;
    await js(`new Promise((resolve,reject)=>{const off=window.mc.onLlmEvent(e=>{if(e.requestId!==${JSON.stringify(requestId)})return;if(e.kind==='done'){off();resolve(e.text)}else if(e.kind==='error'){off();reject(Error(e.message))}});window.mc.${vision ? 'shotAsk' : 'llmAsk'}(${JSON.stringify({ requestId, mode, question: '请解释缓存', freeQuestion: '请解释缓存', recentTranscript: [], ...(vision ? { imageDataUrl: 'data:image/png;base64,AAA' } : {}) })});})`);
    const request = requests[start];
    assert(request, 'a real HTTP request must reach the local model');
    const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    if (expected) assert(system.includes(expected), 'saved custom instructions must be sent to the model');
    else { assert(!system.includes('PROMPT_')); if (mode === 'continuous') assert(system.includes('150-350')); }
    return request;
  }
  if (process.argv[2] === 'restart') {
    await checkAppearance(0.25);
    await open();
    assert.equal(await js('document.querySelector("#background-transparency").value'), '75');
    assert.equal(await js('document.querySelector("#custom-answer-prompt").value'), prompt);
    await js(`Array.from(document.querySelectorAll('.settings-actions button')).find(e=>e.textContent==='取消').click()`);
    await ask('free', prompt);
  } else {
    await save(prompt);
    for (const mode of ['continuous', 'segment', 'free']) await ask(mode, prompt);
    await ask('free', prompt, true);
    await js('window.mc.setSettings({llm:{answerWithVision:true}})');
    const multimodal = await ask('continuous', prompt);
    assert.equal(multimodal.model, 'fake-vision');
    await js('window.mc.setSettings({llm:{answerWithVision:false}})');
    await ask('translate', null);
    await save(edited);
    const updated = await ask('free', edited);
    assert(!JSON.stringify(updated.messages).includes('PROMPT_SAVE'));
    await save('');
    await ask('continuous', null);
    await save(prompt);
    await open();
    const originalAlpha = await js('window.mc.getSettings().then(s=>s.ui.opacity)');
    await slider(0); await checkAppearance(1);
    await slider(95); await checkAppearance(0.05);
    await slider(75);
    await checkAppearance(0.25);
    assert.equal(await js('window.mc.getSettings().then(s=>s.ui.opacity)'), originalAlpha, 'preview must not write settings');
    await cancelPanel();
    await checkAppearance(originalAlpha);
    await open(); await slider(75); await savePanel();
    await checkAppearance(0.25);
    assert.equal(await js('window.mc.getSettings().then(s=>s.ui.opacity)'), 0.25);
    // Both themes use the same alpha while keeping the code panel solid.
    await open();
    await js(`(()=>{const e=Array.from(document.querySelectorAll('.settings select')).find(e=>e.querySelector('option[value="dark"]'));e.value='light';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await savePanel();
    await checkAppearance(0.25);
    assert.equal(await js('document.documentElement.dataset.theme'), 'light');
    await open();
    await js(`(()=>{const e=Array.from(document.querySelectorAll('.settings select')).find(e=>e.querySelector('option[value="dark"]'));e.value='dark';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await savePanel();
    await checkAppearance(0.25);
    await open();
    win.setSize(1180, 900);
    await js(`document.querySelector('#custom-answer-prompt').scrollIntoView({block:'center'})`);
    await pause(250);
    fs.writeFileSync(path.join(qa, 'settings-preview.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#background-transparency').scrollIntoView({block:'center'})`);
    await pause(250);
    fs.writeFileSync(path.join(qa, 'transparency-settings.png'), (await win.webContents.capturePage()).toPNG());
    await cancelPanel(); await pause(150);
    const capture = await win.webContents.capturePage();
    fs.writeFileSync(path.join(qa, 'transparency-main.png'), capture.toPNG());
    // Check actual rendered alpha, not just CSS: the blank background is
    // translucent while the code frame stays opaque in the native capture.
    const size = capture.getSize();
    const bitmap = capture.getBitmap();
    const alphaAt = (x, y) => bitmap[(Math.floor(y) * size.width + Math.floor(x)) * 4 + 3];
    const blankAlpha = alphaAt(size.width * 0.2, size.height * 0.8);
    assert(Math.abs(blankAlpha - 64) <= 2, 'rendered background really has 25% alpha');
    const code = await js(`(()=>{const r=document.querySelector('.answer-code-block').getBoundingClientRect();return {x:(r.left+r.width/2)/innerWidth,y:(r.top+r.height/2)/innerHeight}})()`);
    assert.equal(alphaAt(code.x * size.width, code.y * size.height), 255, 'rendered code frame remains opaque');
  }
  clearTimeout(timer);
  await new Promise(resolve => server.close(resolve));
  app.quit();
}
