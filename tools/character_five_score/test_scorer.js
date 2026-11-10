'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const five=require('./scorer.js');
const params={version:five.VERSION,mu:0,sigma:1,baseline:five.BASELINE};
const close=(a,b,tol=1e-12)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
test('mechanism baseline matches independent finite renewal result',()=>{
  close(five.BASELINE.mainRate,.13411295200285406);
  close(five.BASELINE.rushMean,.8+.912**10);
});
test('raw score formula and monotonic output',()=>{
  const N=500,R=8,F=80,p=.13411295200285397+1.1980598575793349*R/N;
  close(five.rawZ({N,R,F}),(F-N*p)/Math.sqrt(N*p*(1-p)));
  let prior=-1;
  for(let f=0;f<=N+10*R;f++) {
    const score=five.scoreFive({N,R,F:f},params);
    assert.ok(score>=prior&&score>=0&&score<=100);prior=score;
  }
});
test('empty record is unscored and inconsistent counts fail',()=>{
  assert.equal(five.scoreFive({N:0,R:0,F:0},params),null);
  for(const r of [{N:0,R:1,F:1},{N:30,R:10,F:10},{N:10,R:0,F:11},{N:1.5,R:0,F:0},{N:50,R:-1,F:0},{N:NaN,R:0,F:0}])assert.throws(()=>five.rawZ(r));
});
test('external malformed calibration is rejected including nonfinite baseline',()=>{
  for(const value of [NaN,Infinity,undefined,null,'0.134',.133]) {
    assert.throws(()=>five.scoreFive({N:100,R:1,F:15},{...params,baseline:{...five.BASELINE,mainRate:value}}));
  }
  for(const change of [{mu:NaN},{sigma:0},{sigma:Infinity},{version:'wrong'},{baseline:null}]) {
    assert.throws(()=>five.scoreFive({N:100,R:1,F:15},{...params,...change}));
  }
});
test('training fit uses only supplied observations and sample SD',()=>{
  const r=[{N:100,R:1,F:13},{N:100,R:1,F:15},{N:100,R:1,F:17}];
  const z=r.map(five.rawZ),mu=z.reduce((a,b)=>a+b,0)/3,sigma=Math.sqrt(z.reduce((s,v)=>s+(v-mu)**2,0)/2);
  const p=five.fit(r);close(p.mu,mu);close(p.sigma,sigma);assert.equal(p.trainingN,3);
  assert.throws(()=>five.fit([r[0],r[0]]));
});
const resultDir=path.join(__dirname,'results_20261013');
const ready=fs.existsSync(path.join(resultDir,'report.json'));
test('frozen final sample budget, split and hashes are consistent',{skip:!ready},()=>{
  const read=f=>JSON.parse(fs.readFileSync(path.join(resultDir,f),'utf8'));
  const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const tr=read('training.json'),va=read('validation.json'),pilot=read('pilot.json'),budget=read('budget.json'),report=read('report.json');
  const p=JSON.parse(fs.readFileSync(path.join(__dirname,'parameters.json'),'utf8'));
  assert.equal(tr.rows.length,2000);assert.equal(va.rows.length,2000);assert.equal(pilot.rows.length,40);
  assert.deepEqual(tr.rows.slice(0,40),pilot.rows);assert.equal(budget.reserved,4000);
  assert.equal(va.rows.filter(r=>r.split==='validation').length,1600);
  assert.equal(va.rows.filter(r=>r.split==='single_validation').length,400);
  const all=[...tr.rows,...va.rows];assert.equal(new Set(all.map(r=>r.seed)).size,4000);assert.equal(new Set(all.map(r=>r.id)).size,4000);
  assert.equal(va.frozenParameterSHA256,hash(path.join(__dirname,'parameters.json')));
  assert.equal(p.trainingSHA256,hash(path.join(resultDir,'training.json')));
  for(const [f,expected] of Object.entries(report.sourceHashes))assert.equal(hash(path.join(__dirname,f)),expected);
  const refit=five.fit(tr.rows);close(refit.mu,p.mu);close(refit.sigma,p.sigma);
  assert.equal(report.newSimulationRecords,4000);assert.equal(report.sensitivityReusingPreviousValidation.newSimulationRecords,0);
  for(const r of all)for(const pool of r.pools)if(pool.preowned){assert.equal(pool.N,pool.freeDraws);assert.equal(pool.R,0);}
  close(five.scoreFive(tr.rows[0]),five.scoreFive(tr.rows[0],p));
  assert.ok(Object.isFrozen(five.loadParameters()));
});
