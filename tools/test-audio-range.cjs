// Real Electron renderer, AudioWorklet markers, ASR worker and localhost services.
// Synthetic silent capture / PCM only. No real recording, keys or desktop input.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 90_000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
void run().catch(error => { console.error(error); require('electron').app.exit(1); });

async function run() {
  const { app, safeStorage, BrowserWindow, Menu, globalShortcut, ipcMain } = require('electron');
  const { createServer } = require('node:http');
  const { WebSocketServer } = require('ws');
  const qa = path.resolve(root, '..', 'range-qa'); fs.mkdirSync(qa, { recursive: true });
  const profile = fs.mkdtempSync(path.join(qa, 'profile-'));
  process.env.MC_USERDATA = profile; app.setPath('userData', profile); app.setAppPath(root);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label) {
    for (let i=0;i<300;i++) { if(await fn()) return; await pause(20); }
    throw Error('Timed out: '+label);
  }
  const timer = setTimeout(()=>app.exit(1),80_000);
  const keys = new Map();
  globalShortcut.unregisterAll=()=>keys.clear(); globalShortcut.isRegistered=key=>keys.has(key);
  globalShortcut.register=(key,callback)=>{keys.set(key,callback);return true};
  let win, template, focus=0;
  const buildMenu=Menu.buildFromTemplate;Menu.buildFromTemplate=items=>{template=items;return buildMenu.call(Menu,items)};
  app.on('browser-window-created',(_event,window)=>{if(!win){win=window;window.on('focus',()=>focus++)}});
  await app.whenReady();
  const answers=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(body.stream){
      answers.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'模拟回答'+answers.length}}]})+'\n\ndata: [DONE]\n\n');
    }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'测试摘要'}}]}))}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const wsServer=new WebSocketServer({server});const streams=[];let releasePrefix;
  const labels=new Map([[3276,'起点前的闲聊'],[6553,'区间内的问题'],[9830,'终点后的闲聊'],[13106,'下一轮区间问题'],[16383,'切换会话时的区间'],[19660,'停止时的区间']]);
  wsServer.on('connection',ws=>{
    const audio=[];
    const send=(event,text)=>ws.send(JSON.stringify({header:{event},payload:text?{output:{sentence:{text,sentence_end:true,begin_time:0,end_time:100}}}:{}}));
    ws.on('message',(data,binary)=>{
      if(binary){const b=Buffer.from(data);for(let i=0;i<b.length;i+=2)if(b.readInt16LE(i))audio.push(b.readInt16LE(i));return}
      const action=JSON.parse(data.toString()).header.action;
      if(action==='run-task'){streams.push(audio);send('task-started');}
      if(action==='finish-task'){
        if(audio[0]===22936){ws.terminate();return;}
        const reply=()=>{send('result-generated',labels.get(audio[0])||'');send('task-finished')};
        if(audio[0]===3276)releasePrefix=reply;else reply();
      }
    });
  });
  const port=server.address().port;
  const apiKeyEnc=safeStorage.isEncryptionAvailable()?safeStorage.encryptString('fake-range-only').toString('base64'):'plain:'+Buffer.from('fake-range-only').toString('base64');
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({version:2,onboarding:{schemaVersion:1,completed:true},
    llm:{baseUrl:`http://127.0.0.1:${port}/v1`,model:'fake',apiKeyEnc,answerLang:'english'},
    asr:{backend:'cloud-realtime',realtime:{baseUrl:`ws://127.0.0.1:${port}/asr`,model:'fake',apiKeyEnc}},
    audio:{micEnabled:true},
    ui:{lang:'en',theme:'dark',stealth:false,hotkeyToggle:'',hotkeyShot:'',hotkeyConfirm:'Right'}}));
  fs.writeFileSync(path.join(profile,'sessions.json'),JSON.stringify({currentId:'range',sessions:[{id:'range',name:'Range QA',titled:true,createdAt:1,questionQueueVersion:1,
    segments:[{id:1,speaker:'them',text:'起点前的旧字幕',startTs:1,endTs:2}],pendingQuestion:[{id:'old',segmentId:1,text:'起点前的旧字幕'}],turns:[]}]}));
  require('../out/main/index.js');
  const js=code=>win.webContents.executeJavaScript(code,true);
  await until(async()=>win&&await js('!!window.__mcAutoStart && document.querySelector(".session-picker > button")?.textContent.includes("Range QA")'),'app ready');
  await until(()=>js('window.mc.asrReplay().then(x=>!!x.ready)'),'ASR ready');
  await until(()=>keys.has('Right'),'custom Right binding');
  const cuts=[];ipcMain.on('asr:cut',(_event,id)=>cuts.push(id));
  const hit=()=>keys.get('Right')();
  const button=()=>js('document.querySelector(".range-action").click()');
  assert.equal(await js('document.querySelector(".range-action")?.textContent'),'开始截取');
  assert.equal(await js('document.querySelector(".range-action").disabled'),true);
  assert.equal(await js('Array.from(document.querySelectorAll(".titlebar-actions button")).some(b=>b.title.includes("AI 回答语言"))'),false);
  assert.equal(await js('window.mc.getSettings().then(s=>s.ui.lang==="zh"&&s.llm.answerLang==="chinese"&&!s.audio.micEnabled)'),true);
  assert.equal(await js('document.querySelector(".titlebar-actions").textContent.includes("麦克风")'),false);
  const menu=label=>{const item=template.find(i=>i.label===label);assert(item?.click,'Missing '+label+' in '+template.map(i=>i.label).join(' / '));item.click()};
  const send=async(value,count=4)=>js(`(()=>{for(let i=0;i<${count};i++)window.mc.sendPcm(new Float32Array(1600).fill(${value}).buffer,Date.now(),'them')})()`);
  hit();await until(()=>js('document.body.textContent.includes("等待采集就绪")'),'start capture notice');
  assert.equal(cuts.length,0);
  // Override only this isolated renderer's capture source. The real capture
  // implementation and worklet still create / flush every ordered marker.
  await js(`window.__captureRequests=0;window.__ownMicRequests=0;navigator.mediaDevices.getUserMedia=async()=>{window.__ownMicRequests++;throw Error('own mic must stay off')};navigator.mediaDevices.getDisplayMedia=async()=>{window.__captureRequests++;window.__silentContext=new AudioContext({sampleRate:16000});await window.__silentContext.resume();return window.__silentContext.createMediaStreamDestination().stream};void 0`);
  await js('window.__mcAutoStart()');
  await until(()=>js('document.querySelector("[data-range-stage=ready]")!==null'),'capture ready');
  assert.equal(await js('document.body.textContent.includes("等待采集就绪")'),false);
  assert.equal(await js('window.__captureRequests'),1);
  assert.equal(await js('document.querySelector(".range-action").disabled'),false);
  await send(0.1);await until(()=>streams[0]?.length>0,'prefix audio');
  await until(()=>template.some(i=>i.label==='隐藏窗口'),'initial inactive window shown');
  if(process.env.MC_RANGE_PREVIEW==='1')fs.writeFileSync(path.join(qa,'range-button-preview.png'),(await win.webContents.capturePage()).toPNG());
  menu('隐藏窗口');await button();
  await until(()=>cuts.length===1&&!!releasePrefix,'start boundary issued');
  assert.equal(await js('document.querySelector(".range-action").getAttribute("aria-pressed")'),'true');
  await send(0.2,2);await button();await until(()=>cuts.length===2,'end boundary issued while prefix ASR pending');
  assert.equal(await js('document.querySelector(".range-action").disabled'),true);
  await send(0.3);hit();await button(); // finishing ignores both a third key press and a disabled click
  assert.equal(answers.length,0);assert.equal(cuts.length,2);
  releasePrefix();
  await until(()=>answers.length===1,'selected question submitted');
  await until(()=>js('document.body.textContent.includes("模拟回答1") && !Array.from(document.querySelectorAll(".turn-head button")).some(b=>b.textContent==="停")'),'first answer complete');
  assert(JSON.stringify(answers[0].messages).includes('区间内的问题'));
  assert(!JSON.stringify(answers[0].messages).includes('起点前'));
  assert(!JSON.stringify(answers[0].messages).includes('终点后'));
  assert.equal(win.getOpacity(),0);assert.equal(win.isFocusable(),false);assert.equal(focus,0);
  await until(()=>streams.some(a=>a[0]===9830),'post-range audio continues');
  await button();await until(()=>cuts.length===3,'next range start');await send(0.4,2);hit();
  await until(()=>cuts.length===4,'next range end');
  await until(()=>answers.length===2,'next range submitted');
  assert(JSON.stringify(answers[1].messages).includes('下一轮区间问题'));
  assert(!JSON.stringify(answers[1].messages).includes('终点后'));
  await until(()=>js('!Array.from(document.querySelectorAll(".turn-head button")).some(b=>b.textContent==="停")'),'second answer complete');
  hit();await until(()=>cuts.length===5,'empty start');await button();
  await until(()=>cuts.length===6,'empty end');
  await until(()=>js('document.body.textContent.includes("所选区间没有识别到可用的问题")'),'empty range notice');
  assert.equal(answers.length,2);
  await js('window.mc.setSettings({ui:{hotkeyConfirm:""}})');assert.equal(keys.has('Right'),false);
  await button();await until(()=>cuts.length===7,'session-switch range start with hotkey disabled');await send(0.5);
  menu('新建会话');
  await until(()=>cuts.length===8,'session switch seals the cancelled range');
  await until(()=>js('window.mc.loadSessions().then(f=>f.sessions.some(s=>s.id==="range"&&s.segments.some(x=>x.text==="切换会话时的区间")))'),'cancelled transcript stays in its original session');
  assert.equal(await js('window.mc.loadSessions().then(f=>f.sessions.filter(s=>s.id!=="range").some(s=>s.segments.some(x=>x.text==="切换会话时的区间")))'),false);
  assert.equal(answers.length,2);
  await button();await until(()=>cuts.length===9,'stop-cancel range start');await send(0.6);
  await js('document.querySelector(".titlebar-actions button:first-child").click()');
  await until(()=>cuts.length===10,'stop seals cancelled range');
  await until(()=>js('!document.querySelector("[data-range-stage]")'),'capture stopped');
  await pause(150);assert.equal(answers.length,2);
  assert.equal(await js('window.__captureRequests'),1,'marking ranges must not restart the device');
  await js('window.__mcAutoStart()');
  await until(()=>js('!!document.querySelector("[data-range-stage=ready]")'),'restart capture explicitly');
  await button();await until(()=>cuts.length===11,'error range start');await send(0.7);await button();
  await until(()=>cuts.length===12,'error range end');
  await until(()=>js(`!!document.querySelector('[title*="问题截断未完成"]')`),'ASR failure surfaced inline');
  await pause(100);assert.equal(answers.length,2,'ASR failure must not answer an incomplete selection');
  for(const audio of streams)assert(audio.length&&audio.every(v=>v===audio[0]),'no stream may mix PCM from different regions');
  assert.equal(focus,0);assert.equal(win.isFocusable(),false);
  assert.equal(await js('window.__ownMicRequests'),0,'starting capture and selecting ranges must never request the own-mic channel');
  fs.writeFileSync(path.join(qa,'result.json'),JSON.stringify({passed:true,modelRequests:answers.length,captureStarts:2,focusEvents:focus,nativeInput:'not tested'},null,2));
  console.log('[audio-range] button/button and mixed hotkey ranges; disabled-hotkey button operation; exact PCM boundaries; Chinese old-profile reset; zero own-mic requests; cancellation, errors and no window activation');
  clearTimeout(timer);for(const ws of wsServer.clients)ws.terminate();await new Promise(r=>wsServer.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));app.quit();
}
