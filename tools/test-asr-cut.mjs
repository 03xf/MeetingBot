// Exercises the actual built worker with synthetic PCM and local ASR services.
// No API keys, real recording, models, or external network are used.
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await pause(20); }
  throw Error('Timed out: ' + label);
}
function worker(backend, baseUrl) {
  const process = new Worker(new URL('../out/main/asrWorker.js', import.meta.url), { stdout: true, stderr: true });
  const events = [];
  process.on('message', e => events.push(e));
  process.on('error', e => events.push({ type: 'crash', error: e.stack }));
  process.postMessage({ type: 'init', backend, modelsDir: '', modelId: 'fake', ep: ['cpu'], language: 'chinese', cloud: { baseUrl, model: 'fake', apiKey: 'local-test-only' } });
  const send = (value, count = 1, channel = 'them') => {
    for (let i = 0; i < count; i++) process.postMessage({ type: 'pcm', pcm: new Float32Array(1600).fill(value), captureTs: Date.now(), channel });
  };
  return { process, events, send };
}

async function streaming() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  const connections = [];
  let releaseFirst;
  server.on('connection', ws => {
    const record = { audio: [] }; connections.push(record);
    const index = connections.length;
    const send = (event, sentence) => ws.send(JSON.stringify({ header: { event }, payload: sentence ? { output: { sentence: { text: sentence, sentence_end: true, begin_time: 0, end_time: 100 } } } : {} }));
    ws.on('message', (data, binary) => {
      if (binary) { record.audio.push(Buffer.from(data)); return; }
      const msg = JSON.parse(data.toString());
      if (msg.header.action === 'run-task') send('task-started');
      if (msg.header.action === 'finish-task') {
        if (index === 1) releaseFirst = () => { send('result-generated', '第二句截断前的半句'); send('task-finished'); };
        else { send('result-generated', '截断后继续说的内容'); send('task-finished'); }
      }
    });
  });
  const w = worker('cloud-realtime', `ws://127.0.0.1:${server.address().port}`);
  try {
    await until(() => w.events.some(e => e.type === 'ready'), 'stream ready');
    w.send(0.1, 4);
    await until(() => connections[0]?.audio.length === 4, 'first audio');
    w.process.postMessage({ type: 'cut', requestId: 'cut-1' });
    w.send(0.2, 4);
    w.process.postMessage({ type: 'flush' }); // stop capture while finalization is pending
    await until(() => releaseFirst, 'finish-task');
    assert.equal(connections.length, 1, 'post-cut audio waits while prior session finalizes');
    assert(!w.events.some(e => e.type === 'cut'));
    releaseFirst();
    await until(() => w.events.some(e => e.type === 'cut'), 'cut completed');
    const cut = w.events.findIndex(e => e.type === 'cut');
    assert.equal(w.events[cut - 1].type, 'segment');
    assert.equal(w.events[cut - 1].text, '第二句截断前的半句');
    assert(!w.events[cut].error);
    await until(() => connections[1]?.audio.length === 4, 'buffered audio resumed');
    assert(connections[0].audio.every(b => b.readInt16LE(0) === 3276));
    assert(connections[1].audio.every(b => b.readInt16LE(0) === 6553));
    await until(() => w.events.filter(e => e.type === 'segment').length === 2, 'stopped continuation finalized');
    w.process.postMessage({ type: 'cut', requestId: 'cut-2' });
    await until(() => w.events.some(e => e.type === 'cut' && e.requestId === 'cut-2'), 'second cut');
    assert.deepEqual(w.events.filter(e => e.type === 'segment').map(e => e.text), ['第二句截断前的半句', '截断后继续说的内容']);
    assert(!w.events.some(e => e.type === 'error' || e.type === 'crash'));
    console.log('[asr-cut] streaming: forced final, ordered marker, buffered continuation, no duplicated PCM');
  } finally {
    await w.process.terminate();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

async function segmented() {
  const requests = [];
  let releaseFirst;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const wav = Buffer.from(body.messages[0].content[0].input_audio.data, 'base64');
    const voice = [];
    for (let i = 44; i < wav.length; i += 2) if (wav.readInt16LE(i)) voice.push(wav.readInt16LE(i));
    requests.push(voice);
    const text = requests.length === 1 ? '第一句' : requests.length === 2 ? '第二句的半句' : '下一轮内容';
    const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text } }] })); };
    if (requests.length === 1) releaseFirst = reply; else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const w = worker('cloud', `http://127.0.0.1:${server.address().port}/v1`);
  try {
    await until(() => w.events.some(e => e.type === 'ready'), 'segment ready');
    w.send(0.1, 4); w.send(0, 4);
    await until(() => releaseFirst, 'first inference in flight');
    w.send(0.2, 2); // deliberately shorter than normal minSpeechMs
    w.process.postMessage({ type: 'cut', requestId: 'cut-1' });
    w.send(0.3, 4);
    w.process.postMessage({ type: 'flush' }); // no trailing silence; buffered tail must still finalize
    await pause(60);
    assert.equal(requests.length, 1);
    releaseFirst();
    await until(() => w.events.filter(e => e.type === 'segment').length === 3, 'all segments');
    const cut = w.events.findIndex(e => e.type === 'cut');
    assert.deepEqual(w.events.slice(0, cut).filter(e => e.type === 'segment').map(e => e.text), ['第一句', '第二句的半句']);
    assert(!w.events[cut].error);
    assert.deepEqual(w.events.slice(cut + 1).filter(e => e.type === 'segment').map(e => e.text), ['下一轮内容']);
    assert.equal(requests[1].length, 3200, 'short forced segment is retained');
    assert(requests[1].every(v => v === 6553));
    assert(requests[2].every(v => v === 9830));
    assert(!w.events.some(e => e.type === 'error' || e.type === 'crash'));
    console.log('[asr-cut] segmented: drains old inference, keeps short tail, resumes subsequent audio');
  } finally {
    await w.process.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function selectedRange(backend) {
  const audio = [];
  let releaseBefore;
  const texts = ['before range', 'inside range', 'after range'];
  const streaming = backend === 'cloud-realtime';
  const server = streaming ? new WebSocketServer({ host: '127.0.0.1', port: 0 }) : createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const wav = Buffer.from(body.messages[0].content[0].input_audio.data, 'base64');
    const values=[];for(let i=44;i<wav.length;i+=2)if(wav.readInt16LE(i))values.push(wav.readInt16LE(i));
    const index=audio.length;audio.push(values);
    const reply=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:texts[index]}}]}))};
    if(index===0)releaseBefore=reply;else reply();
  });
  if(streaming){
    await new Promise(resolve=>server.on('listening',resolve));
    server.on('connection',ws=>{
      const index=audio.length;const values=[];audio.push(values);
      const send=(event,text)=>ws.send(JSON.stringify({header:{event},payload:text?{output:{sentence:{text,sentence_end:true,begin_time:0,end_time:100}}}:{}}));
      ws.on('message',(data,binary)=>{
        if(binary){const b=Buffer.from(data);for(let i=0;i<b.length;i+=2)if(b.readInt16LE(i))values.push(b.readInt16LE(i));return}
        const action=JSON.parse(data.toString()).header.action;
        if(action==='run-task')send('task-started');
        if(action==='finish-task'){
          const reply=()=>{send('result-generated',texts[index]);send('task-finished')};
          if(index===0)releaseBefore=reply;else reply();
        }
      });
    });
  }else await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const w=worker(backend,`${streaming?'ws':'http'}://127.0.0.1:${server.address().port}`);
  try{
    await until(()=>w.events.some(e=>e.type==='ready'),'range engine ready');
    w.send(0.1,4);
    w.process.postMessage({type:'cut',requestId:'range-start'});
    w.send(0.2,2);
    w.process.postMessage({type:'cut',requestId:'range-end'});
    w.send(0.3,4);
    w.process.postMessage({type:'flush'});
    await until(()=>releaseBefore,'prefix recognition held');
    assert(!w.events.some(e=>e.type==='cut'),'both clicks occur before first ASR finalization');
    releaseBefore();
    await until(()=>w.events.filter(e=>e.type==='segment').length===3,'all three regions finalized');
    const ordered=w.events.filter(e=>e.type==='cut'||e.type==='segment').map(e=>e.type==='cut'?e.requestId:e.text);
    assert.deepEqual(ordered,['before range','range-start','inside range','range-end','after range']);
    assert.equal(audio.length,3);
    for(const [index,value] of [3276,6553,9830].entries())assert(audio[index].length>0&&audio[index].every(v=>v===value),'PCM must stay inside its own boundary');
    assert(!w.events.some(e=>e.type==='error'||e.type==='crash'));
    console.log(`[asr-range] ${backend}: two queued boundaries isolate the selected PCM, including a short tail and deferred stop`);
  }finally{
    await w.process.terminate();
    if(streaming)for(const client of server.clients)client.terminate();else server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}

await streaming();
await segmented();

await selectedRange('cloud-realtime');
await selectedRange('cloud');
