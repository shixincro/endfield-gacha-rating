const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.RATING_ROOT || path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'tools/gacha_rating_app/static/app.js'), 'utf8');
const start = source.indexOf('async function api(path,body){');
const end = source.indexOf('\nfunction showUnsupportedRecordFormat', start);
assert(start >= 0 && end > start);
function harness(runtime, browserPage = false, response = {ok:true,json:async()=>({ok:true})}) {
  const network = [];
  const scope = {
    window: runtime ? {BrowserRating:runtime} : {}, token:'desktop-token',
    $: id => browserPage && id === 'browserRuntimeStatus' ? {} : null,
    fetch:async (...args)=>{network.push(args);return response;},
  };
  vm.createContext(scope);
  vm.runInContext(source.slice(start,end),scope);
  return {api:scope.api,network};
}
test('browser UI routes config, history, import and score to the local adapter without HTTP',async()=>{
  const calls=[];
  const runtime={async api(route,body){assert.equal(this,runtime);calls.push([route,body]);return {route,body};}};
  const h=harness(runtime,true);
  for(const route of ['/api/config','/api/sessions','/api/records/import','/api/score']){
    const body=route.includes('import')||route.endsWith('score')?{synthetic:true}:undefined;
    assert.deepEqual(await h.api(route,body),{route,body});
  }
  assert.equal(calls.length,4);
  assert.deepEqual(h.network,[]);
});
test('browser adapter errors keep their code and never fall back to server requests',async()=>{
  const failure=Object.assign(new Error('记录已更新'),{code:'revision_conflict'});
  const h=harness({api:async()=>{throw failure;}},true);
  await assert.rejects(h.api('/api/score',{}),error=>error===failure);
  assert.deepEqual(h.network,[]);
});
test('static page with a missing adapter fails clearly without requesting desktop endpoints',async()=>{
  const h=harness(null,true);
  await assert.rejects(h.api('/api/config'),/浏览器计算组件未就绪/);
  assert.deepEqual(h.network,[]);
});
test('desktop UI retains its HTTP request, token and response error behavior',async()=>{
  const h=harness(null,false);
  await h.api('/api/config');
  await h.api('/api/score',{synthetic:true});
  assert.equal(h.network[0][0],'/api/config');
  assert.equal(h.network[1][1].method,'POST');
  assert.equal(h.network[1][1].headers['X-App-Token'],'desktop-token');
  assert.equal(h.network[1][1].body,JSON.stringify({synthetic:true}));
  const failed=harness(null,false,{ok:false,json:async()=>({error:'conflict',code:'revision_conflict'})});
  await assert.rejects(failed.api('/api/score'),error=>error.message==='conflict'&&error.code==='revision_conflict');
});
