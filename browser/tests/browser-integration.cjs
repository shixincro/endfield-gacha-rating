/* Browser-only end-to-end tests. Serve the built static site first, then:
 * node browser/tests/browser-integration.cjs http://127.0.0.1:PORT/
 * PLAYWRIGHT_MODULE_PATH / PYTHON / BROWSER_CHANNEL may override local tools.
 * Test records are synthetic; no player files are copied into the public repo.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sourceApp = path.join(root, 'tools/gacha_rating_app');
const searchPaths = [root, sourceApp, path.resolve(root, '../..', 'tools/gacha_rating_app')];
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH || require.resolve('playwright', {paths: searchPaths});
const {chromium} = require(playwrightPath);
const python = process.env.PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) throw new Error('Pass the URL of the built static site.');
const clone = value => JSON.parse(JSON.stringify(value));

const baselineScript = String.raw`
import copy,json,sys
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root/'tools/gacha_rating_app'))
from importer import revalidate_current_ledger
from service import score_session_result
from record_import import import_record_text
def score(s):
 s=copy.deepcopy(s);s['ledger']=revalidate_current_ledger(s['documents'],s['ledger'],reviewed=s.get('reviewed',False))
 s['scoringScenario']=s.get('scoringScenario',{'enabled':False})
 s['result']=score_session_result(s['documents'],s['ledger'],s['scoringScenario'],reviewed=s.get('reviewed',False));return s
request=json.load(sys.stdin)
if request.get('session'):
 print(json.dumps(score(request['session']),ensure_ascii=False,allow_nan=False));sys.exit()
from test_hypothesis import fixture
demo=json.loads((root/'examples/demo-session.json').read_text(encoding='utf-8'))
docs,ledger=fixture();hyp={'schemaVersion':'gacha-rating-session-v1','id':'b'*32,'revision':1,'documents':docs,'ledger':ledger,'reviewed':True}
formats=[]
for entry in request['formats']:
 parsed=score(import_record_text(entry['text'],entry['name']));formats.append({**entry,'expected':parsed})
print(json.dumps({'demo':demo,'demoExpected':score(demo),'hypothesis':hyp,'formats':formats},ensure_ascii=False,allow_nan=False))
`;
function baseline(request) {
  return JSON.parse(execFileSync(python, ['-c', baselineScript, root], {
    input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    windowsHide: true, timeout: 120000,
    env: {...process.env, PYTHONIOENCODING:'utf-8'},
  }));
}
function formats() {
  const batch = {'1': {p:'熔火灼痕', c:[['莱万汀',5,1,0]]}, '2': {p:'熔铸申领',c:[['熔铸火焰',5,1]]}};
  const row = (seq, name='莱万汀', banner='熔火灼痕') => ({seqId:String(seq),gachaTs:String(seq),poolId:banner,poolName:banner,charName:name,rarity:6,isFree:false});
  const values = [
    ['batch.txt', '1,熔火灼痕,莱万汀-5-1-0\n2,熔铸申领,熔铸火焰-5-1'],
    ['batch.json', batch],
    ['wrapped.json', {info:{uid:'demo-account'},data:batch}],
    ['api.txt', {code:0,data:{list:[row(1)],hasMore:false,nickName:'演示账号'}}],
    ['v3.json', {formatId:'internal_json_v3',accounts:[{gameUid:'demo-account',nickName:'演示账号'}],
      pools:[{id:'c',name:'熔火灼痕',type:'limited',up_character:'莱万汀'}],
      history:[{poolId:'c',seqId:'1',id:'c:1',name:'莱万汀',rarity:6,isFree:false,gameUid:'demo-account',timestamp:'2026-01-22T12:00:00+08:00'}]}],
    ['enduid.json', {uid:'demo-account',data:{'角色寻访-冬猎':[row(99,'提弗洛斯','冬猎')]}}],
  ];
  return values.map(([name, value]) => ({name,text:typeof value === 'string' ? value : JSON.stringify(value)}));
}
function equalValue(actual, expected, at='value') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert(Number.isFinite(actual) && Number.isFinite(expected), `${at}: non-finite numeric result`);
    assert(Math.abs(actual-expected) <= 1e-8*Math.max(1, Math.abs(expected)), `${at}: ${actual} != ${expected}`);
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    assert.equal(Array.isArray(actual), Array.isArray(expected), at);
    const keys = value => Object.keys(value).filter(key => !['elapsedSeconds','updatedAt','importSeconds'].includes(key)).sort();
    assert.deepEqual(keys(actual), keys(expected), `${at}: field mismatch`);
    for (const key of keys(expected)) equalValue(actual[key], expected[key], `${at}.${key}`);
    return;
  }
  assert.equal(actual, expected, at);
}
function compareSession(actual, expected) {
  equalValue(actual.ledger, expected.ledger, 'ledger');
  equalValue(actual.result, expected.result, 'result');
  equalValue(actual.documents, expected.documents, 'documents');
}
async function api(page, route, body) {
  return page.evaluate(async ({route,body}) => window.BrowserRating.api(route, body), {route,body});
}
async function rejects(page, route, body, pattern) {
  const failure = await page.evaluate(async ({route,body}) => {
    try {await window.BrowserRating.api(route,body);return null;}
    catch (error) {return {message:error.message,code:error.code || null};}
  }, {route,body});
  assert(failure, `${route} unexpectedly succeeded`);
  if (pattern) assert.match(failure.message, pattern);
  return failure;
}
async function ready(page) {
  await page.goto(url, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => !!window.BrowserRating?.api, null, {timeout:180000});
  const config = await api(page, '/api/config');
  assert.equal(config.localOnly,true);
  return config;
}
async function uiLoad(page, value) {
  await page.evaluate(value => loadSession(value), value);
}

(async () => {
  const references = baseline({formats:formats()});
  const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  const summary = {formats:[], browserOnly:true, assertions:[], pageErrors:[], apiNetworkRequests:[]};
  const context = await browser.newContext({viewport:{width:1380,height:1000}});
  const monitor = async ctx => {
    await ctx.route('**/api/**', async route => {
      summary.apiNetworkRequests.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    ctx.on('page', page => page.on('pageerror', error => summary.pageErrors.push(error.message)));
  };
  await monitor(context);
  try {
    const page = await context.newPage();
    const config = await ready(page);
    summary.config = {runtime:config.runtime,characterVersion:config.characterVersion,weaponVersion:config.weaponVersion};
    assert.deepEqual(await api(page,'/api/sessions'),[]);
    for (const entry of references.formats) {
      const imported = await api(page,'/api/records/import',{name:entry.name,text:entry.text});
      compareSession(imported,entry.expected);
      summary.formats.push({name:entry.name,format:imported.importMethod,scoredAxes:imported.result.scoredAxes});
    }
    const restored = await api(page,'/api/restore',references.demo);
    assert.notEqual(restored.id,references.demo.id);
    compareSession(restored,references.demoExpected);
    assert.equal(restored.result.scoredAxes,6);
    summary.assertions.push('six format imports and all demo scores match native Python');

    // A real UI detail view must show ledger facts for records without images.
    await uiLoad(page,restored);
    await page.locator('#planningTopPools button').first().click();
    await page.locator('#planningDetailDialog').waitFor({state:'visible'});
    const detail = await page.locator('#planningDetailDialog').innerText();
    assert(!detail.includes('此记录的原图当前不可用'));
    assert(detail.includes('抽'));
    await page.locator('#planningDetailDialog').evaluate(dialog => dialog.close());

    // Exempt exactly one positive loss. The result is recalculated and persisted.
    const currentDemo = await api(page,'/api/sessions/'+restored.id);
    const loss = currentDemo.result.planning.pools.find(pool => pool.status === 'ok' && pool.localLoss > 0);
    assert(loss,'Synthetic demo must have a positive loss for the exemption check.');
    const exemptCandidate = clone(currentDemo);
    exemptCandidate.revision += 1;
    exemptCandidate.ledger.character.pools.find(pool => pool.id === loss.id).planningExempt = true;
    const exempted = await api(page,'/api/score',{session:exemptCandidate,expectedRevision:currentDemo.revision});
    compareSession(exempted,baseline({session:exemptCandidate}));
    assert.equal(exempted.result.planning.pools.find(pool=>pool.id===loss.id).countedLoss,0);
    assert(exempted.result.planning.summary.exemptedLossSum > 0);
    summary.assertions.push('loss exemption recalculates and persists');

    // Exercise the actual manual-supplement form rather than synthesizing its changes.
    await uiLoad(page,exempted);
    await page.locator('#manualSupplement').click();
    await page.locator('#manualSupplementDialog').waitFor({state:'visible'});
    await page.getByLabel('新增主抽数',{exact:true}).fill('10');
    await page.getByLabel('新增五星数（含本次加急，选填）',{exact:true}).fill('1');
    await page.getByRole('button',{name:'保存补充记录',exact:true}).click();
    await page.locator('#manualSupplementDialog').waitFor({state:'hidden',timeout:120000});
    const supplemented = await api(page,'/api/sessions/'+restored.id);
    assert.equal(supplemented.ledger.character.pools.at(-1).total,exempted.ledger.character.pools.at(-1).total+10);
    assert.equal(supplemented.ledger.character.pools.at(-1).manualSupplementDraws,10);
    compareSession(supplemented,baseline({session:supplemented}));
    summary.assertions.push('manual supplement through UI preserves source totals and matches Python');

    // Original documents remain authoritative when a caller submits edited source evidence.
    const candidate = clone(supplemented);
    candidate.revision += 1;
    candidate.documents[0].file = 'must not replace source evidence';
    const validated = await api(page,'/api/validate',{session:candidate});
    assert(validated.ledger);
    const scored = await api(page,'/api/score',{session:candidate});
    assert.deepEqual(scored.documents,supplemented.documents);
    const invalidRevision = clone(scored);invalidRevision.revision += 1;
    await rejects(page,'/api/score',{session:invalidRevision,expectedRevision:0},/记录已更新|版本|冲突/);
    summary.assertions.push('source evidence remains immutable and stale revisions are rejected');

    const hyp = await api(page,'/api/restore',references.hypothesis);
    const hypArgs = {session:hyp,poolId:hyp.ledger.character.pools[0].id,mode:'first-up-120'};
    const plan = await api(page,'/api/hypothesis/plan',hypArgs);
    assert.equal(plan.plan.addedDraws,70);
    assert.deepEqual(plan.plan.events.map(event=>event.at),[100,120]);
    const preview = await api(page,'/api/hypothesis/preview',{...hypArgs,choices:{100:'艾尔黛拉'},additionalFive:null});
    assert.equal(preview.after.character.counts.main,120);
    assert.equal((await api(page,'/api/sessions/'+hyp.id)).ledger.character.pools[0].total,50);
    const hypEnabled = clone(hyp);hypEnabled.revision += 1;
    hypEnabled.scoringScenario = {enabled:true,poolId:hypArgs.poolId,mode:hypArgs.mode,choices:{100:'艾尔黛拉'},additionalFive:null};
    const hypSaved = await api(page,'/api/score',{session:hypEnabled});
    compareSession(hypSaved,baseline({session:hypEnabled}));
    assert.equal(hypSaved.result.character.counts.main,120);
    assert.equal(hypSaved.ledger.character.pools[0].total,50);
    summary.assertions.push('hypothesis preview and enabled final score preserve actual history');

    const beforeReload = await api(page,'/api/sessions');
    await ready(page);
    assert.deepEqual(await api(page,'/api/sessions'),beforeReload);
    compareSession(await api(page,'/api/sessions/'+hyp.id),hypSaved);
    const otherTab = await context.newPage();await ready(otherTab);
    assert.deepEqual(await api(otherTab,'/api/sessions'),beforeReload);
    const isolated = await browser.newContext();await monitor(isolated);
    const isolatedPage = await isolated.newPage();await ready(isolatedPage);
    assert.deepEqual(await api(isolatedPage,'/api/sessions'),[]);
    await isolated.close();
    summary.assertions.push('IndexedDB survives reload, shares within origin, isolates browser contexts');

    // Unsupported files show the persistent existing dialog; malformed JSON uses ordinary errors.
    await page.locator('#images').setInputFiles({name:'unsupported.json',mimeType:'application/json',buffer:Buffer.from('{"future_format":[]}')});
    await page.locator('#import').click();
    const dialog = page.locator('#recordFormatDialog');
    await dialog.waitFor({state:'visible',timeout:120000});
    assert.match(await page.locator('#recordFormatMessage').innerText(),/暂不支持此记录格式/);
    await page.waitForTimeout(3500);
    assert(await dialog.isVisible());
    await dialog.getByRole('button',{name:'确定',exact:true}).click();
    const unknown = await rejects(page,'/api/records/import',{name:'future.txt',text:'unrecognized text'});
    assert.equal(unknown.code,'record_format_unrecognized');
    const malformed = await rejects(page,'/api/records/import',{name:'damaged.json',text:'{broken'});
    assert.notEqual(malformed.code,'record_format_unrecognized');
    assert.deepEqual(await api(page,'/api/sessions'),beforeReload);
    summary.assertions.push('unsupported format dialog persists and failed imports never save records');

    const deletion = await api(page,'/api/sessions/delete',{ids:beforeReload.map(item=>item.id)});
    assert.equal(deletion.deleted.length,beforeReload.length);
    assert.deepEqual(deletion.failed,[]);
    assert.deepEqual(await api(page,'/api/sessions'),[]);
    assert.deepEqual(await api(otherTab,'/api/sessions'),[]);
    await rejects(page,'/api/sessions/'+hyp.id,undefined,/不存在|删除/);
    summary.assertions.push('batch deletion removes only selected browser records');
    assert.deepEqual(summary.apiNetworkRequests,[],'There must be no server API calls.');
    assert.deepEqual(summary.pageErrors,[]);
    console.log(JSON.stringify(summary,null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
