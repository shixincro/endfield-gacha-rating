/* Real IndexedDB/BrowserRatingAPI concurrency checks with a deterministic
 * delayed scorer. No Python runtime, player records, or external URLs needed.
 * node browser/tests/storage-concurrency.cjs [directory containing Playwright]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(require.resolve('playwright', {paths:[process.argv[2] || process.cwd()]}));
const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer((req,res) => {
    if (req.url === '/') {res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Storage parity</title>');}
    if (!['/api.js','/storage.js'].includes(req.url)) {res.writeHead(404);return res.end();}
    res.setHeader('Content-Type','text/javascript');fs.createReadStream(path.join(root,req.url.slice(1))).pipe(res);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage(), pageErrors = [];
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
      const {BrowserRatingAPI} = await import('/api.js');
      const {RecordStore} = await import('/storage.js');
      const check=(condition,message)=>{if(!condition)throw new Error(message);};
      const rejected=async(promise,pattern)=>{
        try {await promise;} catch(error) {check(pattern.test(error.message),'unexpected error: '+error.message);return;}
        throw new Error('expected rejection');
      };
      const freshId=()=>crypto.randomUUID().replaceAll('-','');
      const store=new RecordStore('concurrency-'+freshId());
      let now=1;
      const session=(id=freshId())=>({schemaVersion:'gacha-rating-session-v1',id,revision:1,updatedAt:++now,
        documents:[{file:'synthetic.json'}],ledger:{edit:0},reviewed:false,scoringScenario:{enabled:false}});
      const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
      const makeAPI=()=>{
        const api=Object.create(BrowserRatingAPI.prototype);
        Object.assign(api,{store,urls:new Map(),scoreQueues:new Map(),scoreChains:new Map()});
        api.call=async(op,data)=>{
          if(op==='restore')return {...structuredClone(data),id:freshId(),updatedAt:++now};
          if(op!=='score')throw new Error('unexpected '+op);
          return {...structuredClone(data.session),updatedAt:++now};
        };
        return api;
      };
      const a=makeAPI(),b=makeAPI(),seed=session();await store.save(seed);
      const initialToken=seed.browserStorageVersion;
      check(/^[a-f0-9]{32}$/.test(initialToken),'initial save returned its commit token');
      const entered=gate(),release=gate(),realCall=a.call;
      let calls=0;
      a.call=async(...args)=>{if(++calls===1){entered.resolve();await release.promise;}return realCall(...args);};
      const p2=a.api('/api/score',{session:{...seed,revision:2,ledger:{edit:2}}});
      await entered.promise;
      const p3=a.api('/api/score',{session:{...seed,revision:3,ledger:{edit:3}}});
      release.resolve();
      const [r2,r3]=await Promise.all([p2,p3]);
      const saved3=await store.get(seed.id);
      check(saved3.revision===3&&saved3.ledger.edit===3,'latest queued edit must save');
      check(r2.browserStorageVersion!==initialToken&&r3.browserStorageVersion!==r2.browserStorageVersion,'every commit gets a fresh token');
      check(seed.browserStorageVersion===initialToken,'submitted snapshots stay unchanged');

      // A stale tab independently increments 3 -> 4, after another tab has
      // already saved revision 4. Matching revision numbers are not enough.
      a.call=realCall;
      const r4=await a.api('/api/score',{session:{...saved3,revision:4,ledger:{edit:4}}});
      await rejected(b.api('/api/score',{session:{...saved3,revision:4,ledger:{edit:999}}}),/其他页面/);
      check((await store.get(seed.id)).ledger.edit===4,'stale tab must not overwrite');

      // A foreign commit between the original read and local save is rejected
      // by the atomic IndexedDB transaction, even with equal revisions/times.
      const enteredRace=gate(),releaseRace=gate();
      a.call=async(...args)=>{enteredRace.resolve();await releaseRace.promise;return realCall(...args);};
      const raced=a.api('/api/score',{session:{...r4,revision:5,ledger:{edit:500}}});
      await enteredRace.promise;
      const foreign=await b.api('/api/score',{session:{...r4,revision:5,ledger:{edit:5}}});
      releaseRace.resolve();await rejected(raced,/其他页面/);
      check((await store.get(seed.id)).ledger.edit===5,'foreign commit must survive an in-flight local write');

      // Deleting an in-flight record must not let that result or a queued edit
      // recreate it. The scorer is intentionally allowed to finish.
      const enteredDelete=gate(),releaseDelete=gate();
      a.call=async(...args)=>{enteredDelete.resolve();await releaseDelete.promise;return realCall(...args);};
      const inflight=a.api('/api/score',{session:{...foreign,revision:6,ledger:{edit:6}}});
      const inflightCaught=inflight.catch(error=>error);
      await enteredDelete.promise;
      const queued=a.api('/api/score',{session:{...foreign,revision:7,ledger:{edit:7}}});
      const queuedCaught=queued.catch(error=>error);
      const removed=await b.api('/api/sessions/delete',{ids:[seed.id]});
      check(removed.deleted.includes(seed.id),'delete committed');
      releaseDelete.resolve();
      check((await inflightCaught) instanceof Error&&(await queuedCaught) instanceof Error,'deleted writes fail');
      check(!(await store.get(seed.id)),'deleted record must never reappear');

      // Older API consumers without a token remain compatible. Restores always
      // receive a new token, regardless of the one carried in an exported JSON.
      a.call=realCall;
      const legacy=session();await store.save(legacy);const oldToken=legacy.browserStorageVersion;
      const noToken=structuredClone(legacy);delete noToken.browserStorageVersion;noToken.revision++;
      const upgraded=await a.api('/api/score',{session:noToken});
      check(upgraded.browserStorageVersion!==oldToken,'token-less callers upgrade');
      const restored=await a.api('/api/restore',upgraded);
      check(restored.id!==upgraded.id&&restored.browserStorageVersion!==upgraded.browserStorageVersion,'restores ignore old commit token');

      // Evidence and session writes are atomic. An invalid evidence entry must
      // not partially update either the stored or returned commit token.
      const before=await store.get(legacy.id),invalid={...before,revision:before.revision+1,ledger:{edit:666}};
      await rejected(store.save(invalid,{original:before,files:[{path:'/data/wrong/source.png',bytes:new Uint8Array([1])}]}),/证据/);
      check(JSON.stringify(await store.get(legacy.id))===JSON.stringify(before),'failed write preserves all stored fields');
      check(invalid.browserStorageVersion===before.browserStorageVersion,'failed write does not advance caller token');

      // Restored records may share a source's original key. When the final
      // referencing record is deleted, its URL must also be released even
      // though that path contains a previously deleted record's ID.
      const owner=session(),imagePath='/data/'+owner.id+'/source.png';owner.documents[0].sourceImage=imagePath;
      await store.save(owner,{files:[{path:imagePath,mime:'image/png',bytes:new Uint8Array([1,2,3])}]});
      const shared={...structuredClone(owner),id:freshId()};await store.save(shared);
      await a.hydrate(owner);check(!!a.evidenceURL(imagePath),'image URL hydrated');
      const firstDelete=await a.api('/api/sessions/delete',{ids:[owner.id]});
      check(firstDelete.retainedEvidence.includes(owner.id)&&!!a.evidenceURL(imagePath),'shared evidence retained');
      await a.api('/api/sessions/delete',{ids:[shared.id]});
      check(!a.evidenceURL(imagePath)&&!(await store.read('evidence',imagePath)),'last reference releases blob and URL');

      // Test actual constructor handlers without loading the computational
      // worker. It is the browser event wiring, not scorer behavior, under test.
      const NativeWorker=window.Worker;
      class FakeWorker {postMessage(message){this.last=message;}}
      window.Worker=FakeWorker;
      const progress=[];let wired;
      try {wired=new BrowserRatingAPI({onProgress:text=>progress.push(text)});} finally {window.Worker=NativeWorker;}
      const pending=wired.call('test',{}),id=wired.worker.last.id;
      wired.worker.onmessage({data:{id,type:'progress',message:'正在识图'}});
      wired.worker.onmessage({data:{id,type:'result',value:1}});await pending;
      check(progress.at(-1)==='','completed jobs clear progress');
      const blob=URL.createObjectURL(new Blob(['cached evidence']));wired.urls.set('/data/test/source',blob);
      window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
      check(wired.urls.size===1&&(await fetch(blob)).ok,'BFCache preserves evidence URLs');
      window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}));
      check(wired.urls.size===0,'true unload releases evidence URLs');
      (await wired.store.ready).close();(await store.ready).close();
      return {samePageQueuedEdits:true,staleTabRejected:true,foreignInFlightCommitProtected:true,
        deletionDoesNotResurrect:true,legacyInput:true,restoreNewToken:true,atomicFailure:true,
        sharedEvidenceReleased:true,progressCleared:true,bfcacheEvidencePreserved:true};
    });
    assert.deepEqual(pageErrors,[]);
    console.log(JSON.stringify({...result,pageErrors},null,2));
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
