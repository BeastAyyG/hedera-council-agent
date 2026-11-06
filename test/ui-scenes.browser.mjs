import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const origin = process.env.UI_ORIGIN || "http://localhost:3000";
const debuggerOrigin = process.env.UI_BROWSER || "http://127.0.0.1:9222";
const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const errors = [];
let sequence = 0;
socket.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
  const request = pending.get(event.id);
  if (!request) return;
  pending.delete(event.id);
  event.error ? request.reject(new Error(event.error.message)) : request.resolve(event.result);
};
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = (expression) => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();function check(){if(${expression}) return resolve(true);if(Date.now()-start>10000) return reject(new Error('UI state timeout'));setTimeout(check,40)}check()})`);
const navigate = async (path, ready) => {
  await send("Page.navigate", { url: origin + path });
  await waitFor(`location.pathname===${JSON.stringify(path.split("?")[0])} && document.readyState==='complete' && (${ready})`);
};
const viewport = (width) => send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
const check = (condition, message) => { assert.ok(condition, message); console.log(`PASS ${message}`); };

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await viewport(1440);
  await navigate("/verify.html", "document.getElementById('demo')");
  const shared = await evaluate(`(async()=>{
    const {mountJourney,renderTransfer}=await import('/assets/council-scene.js');
    const host=document.createElement('section');document.body.prepend(host);
    const proposal={id:'BROWSER-FIXTURE',description:{payee:'0.0.1001',amountTinybars:1,token:'HBAR'},transfer:{payee:'<img src=x onerror=alert(1)>',amountTinybars:2,token:'HBAR'}};
    const signed={proposal,check:{matches:true},large:false,lastOutcome:{decision:'SIGNED'}};
    const refused={...signed,check:{matches:false},lastOutcome:{decision:'REFUSED'}};
    const guide=mountJourney(host);
    guide.update(signed,{animate:false});guide.replay();
    guide.update(refused,{animate:false});
    const staleSafe=host.dataset.decision==='REFUSED' && host.querySelector('.cj-courier').dataset.pose==='refused' && host.getAnimations({subtree:true}).every(a=>a.effect?.target!==host.querySelector('.cj-courier'));
    guide.setActivity('working');guide.update(refused,{animate:false});
    const resetActivity=host.querySelector('.cj-activity').textContent==='' && !host.querySelector('button').disabled;
    const art=document.createElement('div');document.body.prepend(art);renderTransfer(art,proposal);
    const safeText=!art.querySelector('img') && art.textContent.includes('<img src=x onerror=alert(1)>') && art.textContent.includes('0.00000001 HBAR');
    guide.destroy();
    const destroyed=host.dataset.moving==='false';
    host.remove();art.remove();
    return {staleSafe,resetActivity,safeText,destroyed};
  })()`);
  for (const [name, result] of Object.entries(shared)) check(result, `shared journey: ${name}`);
  const cleanup = await evaluate(`(async()=>{
    const {whileWorking}=await import('/assets/motion.js');
    const bar=document.createElement('ol');bar.innerHTML='<li>Read</li><li>Check</li>';document.body.append(bar);
    let rejected=false;try{await whileWorking(bar,async()=>{throw new Error('offline')},20)}catch{rejected=true}
    const clean=!bar.classList.contains('on') && !bar.querySelector('.now,.done');bar.remove();return {rejected,clean};
  })()`);
  check(cleanup.rejected && cleanup.clean, "working indicator cleans up rejected requests");
  await evaluate(`(async()=>{
    const {mountJourney}=await import('/assets/council-scene.js');
    window.activityHost=document.createElement('section');document.body.prepend(window.activityHost);
    window.activityGuide=mountJourney(window.activityHost);
    window.activityGuide.update({proposal:{id:'ACTIVITY'},check:{matches:true},large:false,lastOutcome:{decision:'SIGNED'}},{animate:false});
    window.activityGuide.setActivity('waiting');
    window.motionSettled=false;
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{window.motionSettled=true},{once:true});
  })()`);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await waitFor("window.motionSettled && matchMedia('(prefers-reduced-motion: reduce)').matches");
  check(await evaluate("window.activityHost.querySelector('.cj-courier').dataset.pose==='wait'"), "reduced-motion change preserves pending approval pose");
  await evaluate("window.activityGuide.destroy();window.activityHost.remove()");
  await send("Emulation.setEmulatedMedia", { features: [] });
  const neutral = await evaluate(`(async()=>{
    const {whileWorking}=await import('/assets/motion.js');
    const bar=document.createElement('ol');bar.innerHTML='<li>Read</li><li>Check</li>';document.body.append(bar);
    let done;const work=new Promise(resolve=>done=resolve);const pending=whileWorking(bar,()=>work,20);
    await new Promise(resolve=>setTimeout(resolve,120));const neutral=!bar.querySelector('.now,.done');done();await pending;bar.remove();return neutral;
  })()`);
  check(neutral, "in-flight requests never fabricate individual stage progress");
  if (process.argv.includes("--shared")) {
    console.log("Shared browser behavior checks passed.");
  } else {
    for (const width of [375, 768, 1440]) {
      await viewport(width);
      for (const [path, ready] of [
        ["/", "window.COUNCIL_ATLAS"],
        ["/console.html?proposal=P-002", "document.querySelector('.council-journey[data-decision=REFUSED]')"],
        ["/report.html?proposal=P-003", "document.querySelector('.council-journey[data-decision=SIGNED]')"],
        ["/verify.html", "!document.getElementById('demo').hidden"],
      ]) {
        await navigate(path, ready);
        check(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `${width}px ${path}: no horizontal overflow`);
        check(await evaluate("!!document.querySelector('.council-pet')"), `${width}px ${path}: pixel agent present`);
        if (process.env.UI_CAPTURE_DIR && width !== 768) {
          if (path === '/verify.html') {
            await evaluate("document.getElementById('demo').click()");
            await waitFor("!document.getElementById('demo').disabled");
          }
          await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().endTime<5000).map(a=>a.finished.catch(()=>{})))");
          const pageName = path.split('?')[0].replaceAll('/', '').replace('.html', '') || 'atlas';
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          await writeFile(`${process.env.UI_CAPTURE_DIR}/council-${pageName}-${width}.png`, Buffer.from(shot.data, 'base64'));
          if (path.startsWith('/report') || path.startsWith('/console')) {
            await evaluate("document.querySelector('.council-journey').scrollIntoView({block:'center',behavior:'instant'})");
            await waitFor("document.querySelector('.council-journey').dataset.moving==='false'");
            const journeyShot = await send('Page.captureScreenshot', { format: 'png' });
            await writeFile(`${process.env.UI_CAPTURE_DIR}/council-${pageName}-journey-${width}.png`, Buffer.from(journeyShot.data, 'base64'));
          }
        }
      }
    }
    await navigate("/verify.html", "!document.getElementById('demo').hidden");
    await evaluate("document.getElementById('demo').click()");
    await waitFor("!document.getElementById('demo').disabled && document.getElementById('rows').children.length>0");
    check(await evaluate("document.getElementById('tResult').textContent.toLowerCase().includes('verified') || document.getElementById('tResult').textContent.toLowerCase().includes('valid')"), "simulated audit checks actual chain entries");
    await evaluate(`window.originalAuditFetch=window.fetch; window.fetch=async(...args)=>{
      if(args[0]==='/audit') {const response=await window.originalAuditFetch(...args);const body=await response.json();body.entries=body.entries.map((entry,index)=>index===0?{...entry,detail:entry.detail+' altered'}:entry);return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})}
      return window.originalAuditFetch(...args);
    };document.getElementById('demo').click()`);
    await waitFor("!document.getElementById('demo').disabled");
    check(await evaluate("document.querySelectorAll('#rows [data-state=invalid]').length===1 && !document.querySelector('#rows [data-state=valid]') && document.querySelectorAll('#rows [data-state=skipped]').length>0"), "altered audit stops at first broken receipt and skips later entries");
    await evaluate(`window.fetch=async(...args)=>args[0]==='/audit'?new Response(JSON.stringify({entries:[],topicId:'simulated'}),{status:200}):window.originalAuditFetch(...args);document.getElementById('demo').click()`);
    await waitFor("!document.getElementById('demo').disabled");
    check(await evaluate("document.getElementById('rows').children.length===0 && !document.getElementById('verdictTitle').textContent.toLowerCase().includes('verified')"), "empty audit never claims verified receipts");
    await evaluate(`window.fetch=async(...args)=>args[0]==='/audit'?new Response('Unavailable',{status:503}):window.originalAuditFetch(...args);document.getElementById('demo').click()`);
    await waitFor("!document.getElementById('demo').disabled");
    check(await evaluate("document.getElementById('tResult').textContent==='Error' && !document.getElementById('go').disabled"), "audit fetch failure restores retry controls");
    await evaluate("window.fetch=window.originalAuditFetch");
    await navigate("/console.html?proposal=P-002", "document.querySelector('.council-journey[data-decision=REFUSED]')");
    await evaluate(`window.replayPosts=0;window.replayFetch=window.fetch;window.fetch=(url,options)=>{if(options?.method==='POST')window.replayPosts++;return window.replayFetch(url,options)};document.querySelector('.cj-replay').click()`);
    await waitFor("document.querySelector('.council-journey').dataset.moving==='false'");
    check(await evaluate("window.replayPosts===0 && document.querySelector('.council-journey').dataset.decision==='REFUSED'"), "decision replay sends no transaction or API write");
    await evaluate("document.querySelector('#proposals [data-proposal=\"P-003\"]').click();document.querySelector('#proposals [data-proposal=\"P-002\"]').click()");
    await waitFor("document.getElementById('mId').textContent==='P-002' && document.querySelector('.council-journey').dataset.decision==='REFUSED'");
    check(true, "rapid proposal selection keeps the latest selection");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    for (const path of ["/", "/console.html?proposal=P-003", "/report.html?proposal=P-002", "/verify.html"]) {
      await navigate(path, "document.querySelector('.council-pet')");
      check(await evaluate("document.querySelectorAll('.council-pet').length>0 && [...document.querySelectorAll('.council-pet')].every(p=>p.getAnimations({subtree:true}).every(a=>a.playState!=='running'))"), `${path}: reduced-motion character static`);
    }
    await send("Emulation.setEmulatedMedia", { features: [] });
    if (process.env.UI_SCREENSHOT) {
      await viewport(1440);
      await navigate("/report.html?proposal=P-002", "document.querySelector('.council-journey[data-decision=REFUSED]')");
      await evaluate("document.querySelector('.council-journey').scrollIntoView({block:'center'})");
      await waitFor("document.querySelector('.council-journey').dataset.moving==='false'");
      const image = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(process.env.UI_SCREENSHOT, Buffer.from(image.data, "base64"));
    }
    check(errors.length === 0, `no uncaught browser errors (${errors.join(', ')})`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const closed = new Promise((resolve) => { socket.onclose = resolve; });
  socket.close();
  await closed;
  await fetch(`${debuggerOrigin}/json/close/${target.id}`);
}
