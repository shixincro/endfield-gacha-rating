'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./static/character-edit');
const {appendRecord,invalidatesHypothesis} = require('./static/manual-supplement');
function pool(index, extra={}) {
  return {id:'p'+index,index,banner:rules.BANNERS[index],up:rules.LIMITED[index],total:10,
    initialPity:0,tail:0,localTail:0,events:[{at:10,source:'main',character:rules.LIMITED[index],forced:false}],
    rushUsed:false,rush:[],tokens:[],quota:2360,issues:[],ended:true,...extra};
}
function record(pools,extra={}) {
  return {pools,initialPity:0,initialOwned:[],completeHistory:true,issues:[],...extra};
}
test('append relative positions, rush, total quota and water without changing original',()=>{
  const original=record([pool(0),pool(1)],{quotaSummary:{scope:'all-pools',Q:4720,N:20,R:0,K6:2}});
  const before=structuredClone(original);
  const updated=appendRecord(original,{index:0,draws:20,main:[{offset:15,character:'余烬'}],
    rushMode:'hits',rushAt:30,rush:['伊冯'],five:4});
  assert.deepEqual(original,before);
  assert.deepEqual(updated.pools[0].events.map(e=>e.at),[10,25]);
  assert.equal(updated.pools[0].rush[0].character,'伊冯');
  assert.equal(updated.pools[0].manualSupplementDraws,20);
  assert.equal(updated.pools[0].tail,5);assert.equal(updated.pools[1].initialPity,5);
  assert.equal(updated.pools[0].quota,2360+600+3960+720);
  assert.deepEqual(updated.quotaSummary,{scope:'all-pools',Q:4720+5280,N:40,R:1,K6:4});
  const twice=appendRecord(updated,{index:0,draws:5,five:0});
  assert.equal(twice.pools[0].total-twice.pools[0].manualSupplementDraws,10);
});
test('new unrecorded banner can start with explicit pity or inherited pity, with no invented hits',()=>{
  const original=record([pool(0,{total:14,tail:4})]);
  const updated=appendRecord(original,{index:1,draws:8,five:1});
  const added=updated.pools[1];
  assert.equal(added.initialPity,4);assert.equal(added.tail,12);
  assert.equal(added.total,8);assert.equal(added.manualSupplementDraws,8);
  assert.equal(added.quota,340);assert.deepEqual(added.events,[]);
  const late=appendRecord(original,{index:5,draws:10,opening:7,five:2});
  assert.equal(late.pools[1].tail,17);
});
test('filling two missing banners recalculates screenshot water only after the gap is connected',()=>{
  const first=pool(5,{total:20,initialPity:19,tail:5,events:[{at:15,source:'main',character:'庄方宜'}]});
  const label={inheritedPityLabel:5};
  const next=pool(8,{total:60,initialPity:5,initialPitySource:'record-derived',tail:15,
    events:[{at:45,source:'main',character:'诀',evidence:label}],rushUsed:true,rushAt:30});
  const original=record([first,next],{initialPity:19,completeHistory:false});
  const one=appendRecord(original,{index:6,draws:10,five:1});
  assert.equal(one.pools.at(-1).initialPity,5);
  const two=appendRecord(one,{index:7,draws:10,five:1});
  assert.deepEqual(two.pools.map(p=>[p.initialPity,p.tail]),[[19,5],[5,15],[15,25],[25,15]]);
  assert.equal(rules.validateLinks(two),'');
  assert.equal(rules.validatePool(two.pools.at(-1)),'');
  assert.deepEqual(two.pools.at(-1).events[0].evidence,label);
  assert.equal(original.pools[1].initialPity,5);
});
test('a newly inserted banner ending at zero resets obsolete source water through a no-hit chain',()=>{
  const original=record([pool(0),pool(2,{total:5,events:[],initialPity:20,tail:25,
    initialPitySource:'record-derived'}),pool(3,{initialPity:25,tail:0,initialPitySource:'record-derived'})],
    {completeHistory:false});
  const updated=appendRecord(original,{index:1,draws:10,main:[{offset:10,character:'洁尔佩塔'}],five:0});
  assert.deepEqual(updated.pools.map(p=>[p.initialPity,p.tail]),[[0,0],[0,0],[0,5],[5,0]]);
  assert.equal(rules.validateLinks(updated),'');
});
test('supplement keeps explicit manual opening conflicts and respects interruption boundaries',()=>{
  const next=pool(2,{initialPity:20,initialPitySource:'record-derived'});
  const original=record([pool(0),next],{completeHistory:false});
  rules.setInitialPity(original,next,20);
  assert.equal(next.initialPitySource,'manual');
  assert.throws(()=>appendRecord(original,{index:1,draws:10,five:1}),/期初水位20.*期末水位10/);
  next.initialPitySource='record-derived';
  original.interruptionCorrection={excludedIndices:[1]};
  const interrupted=appendRecord(original,{index:1,draws:10,five:1});
  assert.equal(interrupted.pools[2].initialPity,20);
  assert.equal(rules.projectCharacter(interrupted).character.pools.at(-1).initialPity,0);
});
test('recalculated source water still exposes a genuinely impossible six-star interval',()=>{
  const original=record([pool(0),pool(2,{total:75,initialPity:0,initialPitySource:'record-derived',tail:0,
    events:[{at:75,source:'main',character:'伊冯'}],rushUsed:true,rushAt:30})],{completeHistory:false});
  const updated=appendRecord(original,{index:1,draws:10,five:1});
  assert.equal(updated.pools[2].initialPity,10);
  assert.equal(rules.validateLinks(updated),'');
  assert.match(rules.validatePool(updated.pools[2]),/85抽.*超过80/);
});
test('unknown new five counts leave the original quota evidence and clear obsolete all-pool totals',()=>{
  const original=record([pool(0,{quota:null})],{quotaSummary:{scope:'all-pools',Q:2360,N:10,R:0,K6:1}});
  const updated=appendRecord(original,{index:0,draws:6,five:null});
  assert.equal(updated.pools[0].quota,null);
  assert.equal(updated.quotaSummary,undefined);
  assert.equal(updated.pools[0].manualSupplementQuotaEvidence.summary.Q,2360);
});
test('claiming an unused rush after existing final draw adds a single ten-pull, not main pulls',()=>{
  const original=record([pool(0,{total:32,tail:22})]);
  const fixed=appendRecord(original,{index:0,draws:0,rushMode:'empty',rushAt:32,five:1});
  assert.equal(fixed.pools[0].total,32);
  assert.equal(fixed.pools[0].quota,2740);
  assert.throws(()=>appendRecord(fixed,{index:0,draws:0,rushMode:'empty',rushAt:32,five:1}),/只结算一次/);
});
test('mark only the first UP at120 as forced; create newly crossed fixed token nodes',()=>{
  const events=[{at:65,source:'main',character:'余烬',forced:false}];
  const before=record([pool(0,{events,total:115,tail:50})]);
  const first=appendRecord(before,{index:0,draws:5,main:[{offset:5,character:'莱万汀'}],five:0});
  assert.equal(first.pools[0].events[1].forced,true);
  const next=appendRecord(first,{index:0,draws:120,main:[{offset:65,character:'余烬'}],five:15});
  assert.deepEqual(next.pools[0].tokens.map(t=>t.at),[240]);
});
test('respect interruption even when raw inherited water is stale',()=>{
  const original=record([pool(6),pool(8,{initialPity:30,events:[],total:20,tail:50})],
    {completeHistory:false,interruptionCorrection:{excludedIndices:[7]}});
  const next=appendRecord(original,{index:8,draws:40,main:[{offset:35,character:'诀'}],five:4});
  assert.equal(next.pools[1].initialPity,30);
  assert.equal(rules.projectCharacter(next).character.pools[1].initialPity,0);
  const excluded=appendRecord(original,{index:7,draws:5,five:0});
  assert.equal(excluded.pools.find(p=>p.index===7).total,5);
  assert.ok(!rules.projectCharacter(excluded).character.pools.some(p=>p.index===7));
});
test('a new last pool, a changed target, and a retained target distinguish saved hypotheses',()=>{
  const original=record([pool(0),pool(1)]);
  const s={ledger:{character:original},scoringScenario:{enabled:true,poolId:'p1'}};
  assert.equal(invalidatesHypothesis(s,appendRecord(original,{index:1,draws:10,five:1})),true);
  assert.equal(invalidatesHypothesis(s,appendRecord(original,{index:2,draws:10,five:1})),true);
  assert.equal(invalidatesHypothesis(s,appendRecord(original,{index:0,draws:1,main:[{offset:1,character:'莱万汀'}],five:0})),false);
});
test('invalid additions reject without clearing a source error or mutating the source',()=>{
  const original=record([pool(0,{issues:[{code:'source_conflict',severity:'error'}]})]);
  const unchanged=structuredClone(original);
  for(const input of [{draws:1,main:[{offset:2,character:'莱万汀'}]},{draws:81},{draws:0},
      {draws:2,main:[{offset:1,character:'祀'}]},{draws:10,five:12},
      {draws:10,rushMode:'empty',rushAt:30},{draws:10,five:0}]) {
    assert.throws(()=>appendRecord(original,{index:0,...input}));
  }
  assert.deepEqual(original,unchanged);
});
