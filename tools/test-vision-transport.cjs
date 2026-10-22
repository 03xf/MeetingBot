// Actual Electron net transport, isolated profile and localhost fixtures only.
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {cwd:root,env,stdio:'inherit',windowsHide:true,timeout:30000});
  if(result.error) throw result.error;
  process.exit(result.status??1);
}
run().catch(e=>{console.error(e);require('electron').app.exit(1);});
async function run(){
  const {app} = require('electron');
  const qa=path.join(root,'..','vision-qa');fs.mkdirSync(qa,{recursive:true});
  app.setPath('userData',fs.mkdtempSync(path.join(qa,'profile-')));
  const guard=setTimeout(()=>app.exit(2),25000);
  await app.whenReady();
  const compiled=require('esbuild').buildSync({entryPoints:[path.join(root,'electron/llm/vision.ts')],platform:'node',bundle:true,format:'cjs',external:['electron'],write:false});
  const bundle=path.join(qa,'vision.cjs');fs.writeFileSync(bundle,compiled.outputFiles[0].contents);
  const {visionChat}=require(bundle);
  let mode='ok'; const requests=[];
  const server=require('node:http').createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    requests.push({auth:req.headers.authorization,body:JSON.parse(body)});
    if(mode==='stall')return;
    if(mode==='gone'){res.writeHead(410,{'Content-Type':'application/json'});res.end('{"error":{"code":"model_retired"}}');return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    if(mode==='reset'){res.write('{"choices":[');setTimeout(()=>res.destroy(),25);return;}
    const b=Buffer.from(JSON.stringify({choices:[{message:{content:'截图中文回归通过'}}]}));
    const split=b.indexOf(Buffer.from('中'))+1;res.write(b.subarray(0,split));setTimeout(()=>res.end(b.subarray(split)),15);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fake-vision',apiKey:'fake-vision-transport'};
  const messages=[{role:'user',content:[{type:'text',text:'synthetic fixture'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]}];
  assert.equal(await visionChat(config,messages),'截图中文回归通过');
  assert.equal(requests[0].auth,'Bearer fake-vision-transport');assert.deepEqual(requests[0].body.messages,messages);
  mode='gone';await assert.rejects(visionChat(config,messages),/HTTP 410/);
  mode='stall';const ac=new AbortController();const started=Date.now();
  const aborted=visionChat(config,messages,ac.signal);setTimeout(()=>ac.abort(),80);
  await assert.rejects(aborted,e=>e.name==='AbortError');assert(Date.now()-started<3000,'abort must settle the waiting promise');
  mode='reset';await assert.rejects(visionChat(config,messages),/ECONNRESET|aborted|closed|ERR_/i);
  clearTimeout(guard);server.closeAllConnections();await new Promise(r=>server.close(r));
  console.log('[vision-transport] actual HTTP, UTF-8 chunks, retired model, cancellation and interrupted response passed');
  app.exit(0);
}
