'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {scoreCharacter,LIMITED,BANNERS,VERSION}=require('./character_score');
const legacy=require('./character_ledger');
const m=require('./character_result_math');
const pool=(i,n,events=[],extra={})=>({id:`p${i}`,index:i,banner:BANNERS[i],up:LIMITED[i],total:n,
  events:events.map(([at,character,forced=false])=>({at,character,forced,source:'main'})),
  rushUsed:false,rush:[],tokens:[],quota:null,...extra});
const record=(pools,extra={})=>({pools,initialPity:0,initialOwned:[],completeHistory:true,...extra});
const value=(r,key)=>{const a=scoreCharacter(r).axes[key];assert.equal(a.status,'scored',a.reason);return a.score;};
const near=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);

test('production uses count DP while preserving total-count equivalence',()=>{
  assert.equal(VERSION,'character-count-merged-up-v5-catalog-20261105');
  const a=record([pool(0,100,[[20,LIMITED[0]],[100,LIMITED[0]]])]);
  const b=record([pool(0,100,[[50,LIMITED[0]],[100,LIMITED[0]]])]);
  near(value(a,'characterSix'),value(b,'characterSix'));
  assert.ok(value(a,'characterSix')>=0&&value(a,'characterSix')<=100);
});
test('UP20 plus forced120 and70 plus70 use one summed first-UP reference',()=>{
  const a=record([pool(0,20,[[20,LIMITED[0]]]),pool(1,120,[[70,'余烬'],[120,LIMITED[1],true]])]);
  const b=record([pool(0,70,[[70,LIMITED[0]]]),pool(1,70,[[70,LIMITED[1]]])]);
  near(value(a,'up'),value(b,'up'));
  near(value(a,'up'),66.93436477425948);
  // Intermediate off-banner timing cannot change completed UP cost/output.
  for(const off of [54,70,78])near(value(record([a.pools[0],pool(1,120,[[off,'余烬'],[120,LIMITED[1],true]])]),'up'),value(b,'up'));
});
test('120 forced six is included in observed count without conditioning the reference',()=>{
  const r=scoreCharacter(record([pool(0,120,[[70,'余烬'],[120,LIMITED[0],true]])]));
  assert.equal(r.axes.characterSix.details.completeMainSix,2);
  assert.equal(r.axes.characterSix.details.forcedIncluded,1);
  assert.equal(r.axes.limited.details.mainLimitedWeight,1);
  assert.equal(r.segments.some(s=>s.kind==='censored-before-120'),false);
  const natural=record([pool(0,120,[[60,LIMITED[0]],[120,'余烬']])]);
  near(r.axes.characterSix.score,value(natural,'characterSix'));
});
test('unfinished six tail is included in count budgets without an invented hit',()=>{
  const a=record([pool(0,10,[[10,LIMITED[0]]])]);
  const b=record([pool(0,20,[[10,LIMITED[0]]])]);
  assert.ok(value(b,'characterSix')<value(a,'characterSix'));
  assert.ok(value(b,'limited')<value(a,'limited'));
  assert.ok(value(b,'up')<value(a,'up'));
  const out=scoreCharacter(b);assert.equal(out.coverage.unfinishedSixDraws,10);
  assert.match(out.coverage.sixTailPolicy,/included/);
  assert.equal(out.axes.up.details.unsuccessful[0].actual,10);
});
test('empty rush and main draws enter one count law',()=>{
  const r=record([pool(0,30,[],{rushUsed:true,rush:[]}),pool(1,30,[],{rushUsed:true,rush:[]})]);
  // Across both pools main pity reaches60, below soft pity;80 independent draws total.
  const out=scoreCharacter(r);near(out.axes.characterSix.score,50*.992**80);
  assert.equal(out.axes.characterSix.details.rush.draws,20);
  assert.equal(out.axes.characterSix.details.completeMainSix,0);
});
test('rush six rank includes main budget without depending on rush hit positions',()=>{
  const p=pool(0,30,[],{rushUsed:true,rush:[{character:'伊冯',at:1},{character:'伊冯',at:9}]});
  const a=record([p]),b=record([{...p,rush:p.rush.map(e=>({...e,at:5}))}]);
  near(value(a,'characterSix'),value(b,'characterSix'));near(value(a,'up'),value(b,'up'));
  near(value(a,'characterSix'),100*m.midTail(m.rushCountCost(40,.008,m.C6),-2*m.C6));
});
test('limited double credit applies to first off NEW only and never mainUP NEW',()=>{
  const r=scoreCharacter(record([pool(0,30,[[10,'伊冯'],[20,'伊冯'],[30,LIMITED[0]]]) ]));
  assert.deepEqual(r.axes.limited.details.identities.map(x=>x.weight),[2,1,1]);
  const rush=scoreCharacter(record([pool(0,30,[],{rushUsed:true,rush:[{character:'伊冯'},{character:'伊冯'}]})]));
  assert.equal(rush.axes.limited.details.rush.limitedWeight,3);
});
test('forced limited changes subsequent ownership but grants no extra NEW identity',()=>{
  const out=scoreCharacter(record([pool(0,120,[[70,'余烬'],[120,LIMITED[0],true]]),pool(1,1,[[1,LIMITED[0]]])]));
  assert.deepEqual(out.axes.limited.details.identities.map(x=>x.weight),[0,1,1]);
});
test('unknown initial ownership never manufactures a NEW bonus',()=>{
  const r=scoreCharacter(record([pool(0,20,[[20,'伊冯']])],{initialOwned:null,completeHistory:false}));
  assert.equal(r.axes.limited.details.mainLimitedWeight,1);
});
test('failed UP horizon distinguishes a success exactly on final draw',()=>{
  const d=m.upWait(0,120,120), failed=m.upFailedCost(d,30);
  assert.ok(m.midTail(failed,30)<m.midTail(failed,30-m.CUP));
  const r=scoreCharacter(record([pool(0,30)]));
  assert.equal(r.axes.up.status,'scored');assert.equal(r.axes.up.details.unsuccessful.length,1);
});
test('scoring does not mutate source or fifth-star axis and quota',()=>{
  const r=record([pool(0,120,[[70,'伊冯'],[120,LIMITED[0],true]],
    {rushUsed:true,rush:[{character:'洁尔佩塔'}],quota:20*130+1980*3+180*18})]);
  const before=structuredClone(r), old=legacy.scoreCharacter(r),next=scoreCharacter(r);
  assert.deepEqual(next.axes.five,old.axes.five);assert.deepEqual(next.counts,old.counts);
  assert.deepEqual(r,before);
});
test('unknown main identity cannot alter ordinary80 six-count reference',()=>{
  const r=scoreCharacter(record([pool(0,100,[[70,null],[100,'余烬']])]));
  assert.equal(r.axes.characterSix.status,'scored');
  near(r.axes.characterSix.score,value(record([pool(0,100,[[70,'余烬'],[100,'余烬']])]),'characterSix'));
  assert.equal(r.axes.up.status,'unscored');assert.equal(r.axes.limited.status,'unscored');
  assert.equal(scoreCharacter(record([pool(0,20,[[10,null],[20,'余烬']])])).axes.characterSix.status,'scored');
});
test('invalid initial ownership blocks limited only, not six or UP',()=>{
  const r=scoreCharacter(record([pool(0,20,[[20,LIMITED[0]]])],{initialOwned:{}}));
  assert.equal(r.axes.characterSix.status,'scored');assert.equal(r.axes.up.status,'scored');
  assert.equal(r.axes.limited.status,'unscored');
});

test('A60 B20 merges into80 waiting with observed ending deadline180',()=>{
  const a=scoreCharacter(record([pool(0,60),pool(1,20,[[20,LIMITED[1]]])])).axes.up;
  near(a.score,44.2997791477301);assert.equal(a.details.completed.length,1);
  assert.equal(a.details.completed[0].actual,80);assert.equal(a.details.completed[0].deadline,180);
  const off=record([pool(0,60,[[30,'余烬']]),pool(1,20,[[20,LIMITED[1]]])]);
  near(value(off,'up'),a.score);
});

test('UP components conserve C plus U plus R with the whole-record denominator',()=>{
  const r=scoreCharacter(record([pool(0,60),pool(1,30,[[20,LIMITED[1]]],{rushUsed:true,rush:[]})]));
  const a=r.axes.up,d=a.details,c=d.components;assert.equal(a.status,'scored');
  assert.equal(d.totalDraws,100);
  assert.deepEqual([c.completed.draws,c.tail.draws,c.rush.draws],[80,10,10]);
  near(c.completed.score,44.2997791477301);near(c.tail.score,48.0356186751405);
  near(c.rush.score,50*.996**10);near(a.score,45.0469470532122);
  near(Object.values(c).reduce((n,p)=>n+p.draws,0),d.totalDraws);
  near(Object.values(c).reduce((n,p)=>n+p.weight,0),1);
  near(Object.values(c).reduce((n,p)=>n+(p.score??0)*p.draws/d.totalDraws,0),a.score);
});

test('only one final unfinished UP wait remains across later no-UP banners',()=>{
  const d=scoreCharacter(record([pool(0,30,[[20,LIMITED[0]]]),pool(1,0),pool(2,30)])).axes.up.details;
  assert.equal(d.components.completed.draws,20);assert.equal(d.components.tail.draws,40);
  assert.equal(d.unsuccessful.length,1);assert.equal(d.unsuccessful[0].actual,40);
  near(d.components.tail.score,50*.996**40);
});

test('no-output score uses all observed draws and does not invent a completed event',()=>{
  const r=scoreCharacter(record([pool(0,20)]));
  near(r.axes.characterSix.score,50*.992**20);
  near(r.axes.up.score,50*.996**20);
  near(r.axes.limited.score,50*(1-.008*9/14)**20);
  assert.equal(r.axes.up.details.completed.length,0);
  assert.equal(r.axes.up.details.components.completed.draws,0);
});

test('joint six-count rank ignores source allocation at fixed total output',()=>{
  const a=record([pool(0,30,[[10,LIMITED[0]]],{rushUsed:true,rush:[]})]);
  const b=record([pool(0,30,[],{rushUsed:true,rush:[{character:LIMITED[0]}]})]);
  near(value(a,'characterSix'),value(b,'characterSix'));
  near(value(a,'characterSix'),100*m.midTail(m.rushCountCost(40,.008,1),-1));
});

test('NEW-enhanced limited percentile remains within0 to100',()=>{
  const r=record([pool(0,30,[[1,'伊冯'],[2,'洁尔佩塔'],[3,LIMITED[0]]],
    {rushUsed:true,rush:[{character:LIMITED[0]}]})]);
  const score=value(r,'limited');assert.ok(score>=0&&score<=100);
});
