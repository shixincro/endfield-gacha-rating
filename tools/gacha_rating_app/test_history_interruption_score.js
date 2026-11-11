'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {scoreCharacter,BANNERS,LIMITED}=require('./character_score');
const {countSegments}=require('./character_result_score');
const up=require('./character_up_dp');
const six=require('./character_six_count');
const limited=require('./character_limited_count');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

function pool(index,total,hits=[],extra={}) {
  const events=hits.map(([at,character=LIMITED[index]])=>({at,character,source:'main',forced:false}));
  return {id:`p${index}`,index,banner:BANNERS[index],up:LIMITED[index],total,events,
    initialPity:0,tail:total-(events.at(-1)?.at??0),rushUsed:false,rush:[],tokens:[],
    quota:20*total+1980*events.length,issues:[],...extra};
}
const record=(pools,extra={})=>({pools,initialPity:0,initialOwned:[],completeHistory:false,issues:[],...extra});
const axes=['characterSix','up','limited','five'];
const checkScored=result=>axes.forEach(key=>{
  assert.equal(result.axes[key].status,'scored',`${key}: ${result.axes[key].reason}`);
  assert.ok(Number.isFinite(result.axes[key].score));
});

test('lost banner: an inherited30 plus observed70 remains invalid until the boundary resets it',()=>{
  const before=pool(6,30);
  const stale=record([before,pool(8,70,[[70]],{initialPity:30})]);
  assert.equal(scoreCharacter(stale).axes.characterSix.status,'unscored');
  const corrected=record([before,pool(8,70,[[70]],{interruptionBefore:true})]);
  const saved=structuredClone(corrected),result=scoreCharacter(corrected);
  checkScored(result);
  assert.deepEqual(corrected,saved,'scoring must not mutate saved evidence');
  assert.equal(result.counts.main,100);
  assert.equal(result.counts.six,1);
  assert.equal(result.counts.total,100,'missing draws must not be fabricated');
  assert.equal(result.axes.up.details.completed[0].actual,70);
  assert.equal(result.axes.up.details.completed[0].initialPity,0);
});

test('explicit adjacent boundary splits count DP and UP waits even if old coverage says complete',()=>{
  const input=record([pool(0,30),pool(1,70,[[70]],{interruptionBefore:true})],{completeHistory:true});
  const output=scoreCharacter(input);
  checkScored(output);
  const expected=[{initialPity:0,mainDraws:30,mainSix:0},{initialPity:0,mainDraws:70,mainSix:1}];
  assert.deepEqual(countSegments(input).segments,expected);
  near(output.axes.characterSix.score,six.scoreSegments(expected,{rushDraws:0,rushSix:0}).joint);
  const data=up.split(input);
  assert.equal(data.completed.length,1);
  assert.deepEqual([data.completed[0].actual,data.completed[0].deadline],[70,120]);
  assert.deepEqual(data.tails.map(t=>[t.actual,t.reason]),[[30,'history-interruption']]);
  assert.equal(data.completedDraws+data.tailDraws+data.excludedMainDraws,data.recordMainDraws);
});

test('new comparison uses independent0 start laws rather than80 inherited draws',()=>{
  const continuous=record([pool(0,30),pool(1,50,[[50]],{initialPity:30})]);
  const interrupted=record([pool(0,30),pool(1,50,[[50]],{interruptionBefore:true})]);
  const a=scoreCharacter(continuous),b=scoreCharacter(interrupted);
  checkScored(a);checkScored(b);
  assert.deepEqual(countSegments(continuous).segments,[{initialPity:0,mainDraws:80,mainSix:1}]);
  assert.notEqual(a.axes.characterSix.score,b.axes.characterSix.score);
  assert.equal(a.axes.up.details.completed[0].actual,80);
  assert.equal(b.axes.up.details.completed[0].actual,50);
});

test('boundary retains earlier knownNew but makes every later unknownNew worth only one',()=>{
  const input=record([pool(0,10,[[10,'伊冯']]),pool(1,10,[[10,'莱万汀']],{interruptionBefore:true}),
    pool(2,10,[[10,'洁尔佩塔']])]);
  const result=scoreCharacter(input);
  checkScored(result);
  assert.deepEqual(result.axes.limited.details.identities.map(x=>x.weight),[2,1,1]);
  assert.equal(result.axes.limited.details.method,'partial-history-limited-compatibility-dp');
  assert.equal(result.coverage.ownershipMode,'limited-only-no-new-bonus');
});

test('boundary before the first retained pool never treats an empty initial collection as known',()=>{
  const input=record([pool(0,10,[[10,'伊冯']],{interruptionBefore:true})]);
  const result=scoreCharacter(input);
  checkScored(result);
  assert.deepEqual(result.axes.limited.details.identities.map(x=>x.weight),[1]);
  assert.equal(result.counts.offNew,null);
  assert.equal(result.axes.limited.details.partialHistoryCompatibility,true);
  assert.throws(()=>limited.scoreRecord(input),/中断修正/);
});

test('several boundaries retain all known draws and rush without merging abandoned UP waits',()=>{
  const input=record([pool(0,30),pool(1,40,[],{interruptionBefore:true,rushUsed:true,rush:[{character:LIMITED[1]}],
    quota:20*50+1980}),pool(2,20,[[20]],{interruptionBefore:true})]);
  const result=scoreCharacter(input);
  checkScored(result);
  const data=result.axes.up.details;
  assert.equal(data.completed.length,1);assert.equal(data.completed[0].actual,20);
  assert.deepEqual(data.tails.map(t=>t.actual),[30,40]);
  assert.equal(data.components.rush.draws,10);assert.equal(data.totalDraws,100);
  assert.equal(result.counts.main,90);assert.equal(result.counts.total,100);assert.equal(result.counts.six,2);
  near(Object.values(data.components).reduce((n,c)=>n+c.weight,0),1);
});

test('a corrected boundary cannot suppress a truly impossible segment or an identity conflict',()=>{
  const tooLong=record([pool(0,30),pool(1,81,[[81]],{interruptionBefore:true})]);
  assert.equal(scoreCharacter(tooLong).axes.characterSix.status,'unscored');
  const bad=record([pool(0,30),pool(1,70,[[70]],{interruptionBefore:true,
    issues:[{code:'source_conflict',severity:'error',axes:['characterSix','up','limited'],message:'source conflict'}]})]);
  for(const key of axes.slice(0,3))assert.equal(scoreCharacter(bad).axes[key].status,'unscored');
  const invalid=record([pool(0,30),pool(1,20,[[20]],{interruptionBefore:true,initialPity:80})]);
  assert.equal(scoreCharacter(invalid).axes.up.status,'unscored');
  assert.throws(()=>up.split(invalid),/期初水位/);
});

test('supplemental boundary pity conditions the same observed hits without adding draws',()=>{
  const input=record([pool(0,30),pool(1,20,[[20]],{interruptionBefore:true,initialPity:55})]);
  const output=scoreCharacter(input);checkScored(output);
  assert.equal(output.counts.main,50);assert.equal(output.counts.six,1);
  assert.equal(output.axes.up.details.completed[0].initialPity,55);
  assert.deepEqual(countSegments(input).segments,[{initialPity:0,mainDraws:30,mainSix:0},{initialPity:55,mainDraws:20,mainSix:1}]);
});

test('supplemental collection changes only New ownership, retaining earlier observed ownership',()=>{
  const input=record([pool(0,10,[[10,'伊冯']]),pool(1,10,[[10,'莱万汀']],{
    interruptionBefore:true,interruptionCatalog:{ownedSixStars:['莱万汀'],catalogComplete:true}}),
    pool(2,10,[[10,'洁尔佩塔']])]);
  const withInfo=scoreCharacter(input);checkScored(withInfo);
  const without=structuredClone(input);delete without.pools[1].interruptionCatalog;
  const old=scoreCharacter(without);
  assert.deepEqual(withInfo.axes.limited.details.identities.map(x=>x.weight),[2,1,2]);
  for(const key of ['characterSix','up'])assert.deepEqual(withInfo.axes[key],old.axes[key]);
  assert.equal(withInfo.axes.five.score,old.axes.five.score);
  for(const key of ['main','total','six','up','quota'])assert.equal(withInfo.counts[key],old.counts[key]);
});
