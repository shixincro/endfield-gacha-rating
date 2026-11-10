'use strict';

// Production integration only: frozen numerical regressions remain in
// test_character_score.js, which deliberately imports character_ledger.
const test = require('node:test');
const assert = require('node:assert/strict');
const production = require('./character_score');
const ledger = require('./character_ledger');
const math = require('./character_result_math');
const {extract} = require('./character_result_score');
const {LIMITED,BANNERS} = production;
const axes = ['characterSix','up','limited'];
const near = (a,b,tol=1e-8) => assert.ok(Math.abs(a-b)<tol, `${a} != ${b}`);
function pool(index,total,events=[],extras={}) {
  return {id:`pool-${index}`,index,banner:BANNERS[index],up:LIMITED[index],
    total,events:events.map(e=>({source:'main',forced:false,...e})),
    rushUsed:false,rushAt:null,rush:[],tokens:[],quota:null,...extras};
}
const record = (pools,extras={}) => ({pools,initialPity:0,initialOwned:[],completeHistory:true,issues:[],...extras});
const scored = (r,axis='characterSix') => {
  assert.equal(r.axes[axis].status,'scored',`${axis}: ${r.axes[axis].reason}`);
  assert.ok(Number.isFinite(r.axes[axis].score));
  assert.ok(r.axes[axis].score>=0&&r.axes[axis].score<=100);
  return r.axes[axis].score;
};
const unscored = (r,axis='characterSix') => {
  assert.equal(r.axes[axis].status,'unscored');assert.equal(r.axes[axis].score,null);
};

test('production exposes the new version while preserving frozen ledger export',()=>{
  assert.equal(production.VERSION,'character-count-merged-up-v5-catalog-20261105');
  assert.notEqual(production.VERSION,ledger.VERSION);
  const r=production.scoreCharacter(record([pool(0,10,[{at:10,character:'莱万汀'}])]));
  assert.equal(r.version,production.VERSION);axes.forEach(a=>scored(r,a));
});

test('complete ordinary six cycles with equal total wait have equal result scores',()=>{
  const make=waits=>record([pool(0,100,[{at:waits[0],character:'莱万汀'},{at:100,character:'余烬'}])]);
  const a=production.scoreCharacter(make([20,80])),b=production.scoreCharacter(make([50,50]));
  near(scored(a),scored(b));
  assert.equal(a.axes.characterSix.details.completeMainSix,2);
});

test('Minghe screenshot cycle carries 45 pity into 23 and 45, with five draws left',()=>{
  const index=BANNERS.indexOf('烟火邀星河');
  const edit=require('./static/character-edit');
  assert.equal(index,12);assert.equal(LIMITED[index],'明河');
  assert.deepEqual(edit.BANNERS,BANNERS);assert.deepEqual(edit.LIMITED,LIMITED);
  const banner=pool(index,50,[{at:23,character:'明河'},{at:45,character:'明河'}],
    {initialPity:45,tail:5,rushUsed:true,rushAt:30,quota:6780});
  const r=production.scoreCharacter(record([banner],{initialPity:45,completeHistory:false}));
  for(const axis of [...axes,'five'])scored(r,axis);
  assert.deepEqual([r.counts.main,r.counts.six,r.counts.up,r.counts.endPity,r.counts.five],[50,2,2,5,9]);
  assert.deepEqual(r.axes.up.details.completed.map(c=>c.actual),[23,22]);
  assert.equal(r.axes.limited.details.method,'ordinary80-limited-value-ownership-dp');
  assert.deepEqual(edit.candidates(banner),['明河','祀','提弗洛斯',...ledger.COMMON]);
  const invalid=pool(index,1,[{at:1,character:'梨诺'}]);
  unscored(production.scoreCharacter(record([invalid])),'limited');
});

test('Minghe limited ownership DP counts the new thirteenth bit alongside both off-banner identities',()=>{
  const {distributionForSchedule}=require('./character_limited_count');
  const options={initialPity:79,initialOwned:['祀'],includeNew:true,maxValue:2};
  const result=distributionForSchedule([{index:12,mainDraws:1}],options);
  near(result.retainedMass,1);near(result.p[0],5/14);
  near(result.p[1],8/14);near(result.p[2],1/14);
});

test('forced120 is included in the actual six and limited counts',()=>{
  const r=production.scoreCharacter(record([pool(0,120,[
    {at:70,character:'余烬'},{at:120,character:'莱万汀',forced:true},
  ])]));
  axes.forEach(a=>scored(r,a));
  assert.equal(r.axes.characterSix.details.completeMainSix,2);
  assert.equal(r.axes.characterSix.details.forcedIncluded,1);
  assert.equal(r.axes.limited.details.mainLimitedWeight,1);
});

test('unfinished main-only six tail contributes its draw budget without a fictitious hit',()=>{
  const r=production.scoreCharacter(record([pool(0,20)]));
  axes.forEach(a=>scored(r,a));
  near(r.axes.characterSix.score,50*.992**20);
  assert.equal(r.coverage.unfinishedSixDraws,20);
  assert.match(r.coverage.sixTailPolicy,/included/);
  assert.equal(r.axes.up.details.unsuccessful[0].actual,20);
});

test('adding an unfinished six tail lowers the same-count six score and remains UP evidence',()=>{
  const a=production.scoreCharacter(record([pool(0,10,[{at:10,character:'莱万汀'}])]));
  const b=production.scoreCharacter(record([pool(0,30,[{at:10,character:'莱万汀'}])]));
  assert.ok(scored(b)<scored(a));
  assert.equal(b.coverage.unfinishedSixDraws,20);
  assert.equal(b.axes.up.details.unsuccessful[0].actual,20);
  assert.ok(scored(b,'up')<scored(a,'up'));
});

test('only a used rush adds its ten draws to the six count distribution',()=>{
  const unused=production.scoreCharacter(record([pool(0,30)]));
  const used=production.scoreCharacter(record([pool(0,30,[],{rushUsed:true,rushAt:30})]));
  near(scored(unused),50*Math.pow(.992,30));near(scored(used),50*Math.pow(.992,40));
  assert.equal(used.axes.characterSix.details.rush.draws,10);
  assert.equal(used.axes.characterSix.details.completeMainSix,0);
});

test('rush six and UP use aggregate counts and never reset main120',()=>{
  const r=production.scoreCharacter(record([pool(0,120,[
    {at:70,character:'余烬'},{at:120,character:'莱万汀',forced:true},
  ],{rushUsed:true,rushAt:30,rush:[{character:'莱万汀'}]})]));
  axes.forEach(a=>scored(r,a));
  assert.equal(r.axes.characterSix.details.forcedIncluded,1);
  assert.deepEqual(r.axes.characterSix.details.rush,{draws:10,six:1,up:1,limitedWeight:1});
  assert.equal(r.axes.up.details.completed[0].deadline,120);
  assert.equal(r.axes.up.details.components.completed.draws,120);
  assert.equal(r.axes.up.details.totalDraws,130);
});

test('same-rush repeated off NEW has one two-point hit then one ordinary hit',()=>{
  const r=production.scoreCharacter(record([pool(0,30,[],{
    rushUsed:true,rushAt:30,rush:[{character:'伊冯'},{character:'伊冯'}],
  })]));
  scored(r,'limited');
  assert.equal(r.axes.limited.details.rush.limitedWeight,3);
});

test('main trigger hit settles before rush for NEW ownership',()=>{
  const r=production.scoreCharacter(record([pool(0,30,[{at:30,character:'伊冯'}],{
    rushUsed:true,rushAt:30,rush:[{character:'伊冯'}],
  })]));
  scored(r,'limited');
  assert.equal(r.axes.limited.details.mainLimitedWeight,2);
  assert.equal(r.axes.limited.details.rush.limitedWeight,1);
});

test('a new banner resets120 while carrying incomplete ordinary six pity',()=>{
  const input=record([pool(0,90,[{at:70,character:'余烬'}]),pool(1,10,[{at:10,character:'洁尔佩塔'}])]);
  const data=extract(input,ledger),r=production.scoreCharacter(input);
  axes.forEach(a=>scored(r,a));
  assert.equal(data.six[1].actual,30);
  assert.deepEqual(data.six[1].schedule,[{at:0,deadline:50},{at:20,deadline:140}]);
  assert.equal(data.six[1].entries.at(-1).wait,80);
  assert.equal(data.six[1].entries.some(e=>e.forced),false);
});

test('zero-draw cycle boundaries and zero-draw intervening pools do not duplicate schedules',()=>{
  for(const pools of [
    [pool(0,10,[{at:10,character:'莱万汀'}]),pool(1,10,[{at:10,character:'洁尔佩塔'}])],
    [pool(0,70,[{at:70,character:'余烬'}]),pool(1,0),pool(2,10,[{at:10,character:'伊冯'}])],
  ]) {
    const r=production.scoreCharacter(record(pools));axes.forEach(a=>scored(r,a));
  }
});

test('unknown opening does not erase later known six timing or known identity evidence',()=>{
  const input=record([pool(8,30,[{at:20,character:'诀'}])],{
    completeHistory:false,initialPity:null,initialOwned:null,
  });
  const r=production.scoreCharacter(input);
  axes.forEach(a=>scored(r,a));
  near(r.axes.characterSix.score,50*.992**10);
  assert.equal(r.coverage.excludedMainDraws,20);
  assert.equal(r.coverage.unfinishedSixDraws,10);
  const withSecond=record([pool(8,35,[{at:20,character:'诀'},{at:35,character:'余烬'}])],{
    completeHistory:false,initialPity:null,initialOwned:null,
  });
  const second=production.scoreCharacter(withSecond);axes.forEach(a=>scored(second,a));
  assert.equal(second.axes.characterSix.details.completeMainSix,1);
});

test('unknown character gates identity axes without losing known six timing',()=>{
  const r=production.scoreCharacter(record([pool(0,20,[{at:10,character:null}])]));
  scored(r);unscored(r,'up');unscored(r,'limited');
});

test('missing mandatory120, incorrect forced labels and impossible waiting are blocked',()=>{
  const inputs=[
    record([pool(0,120,[{at:70,character:'余烬'}])]),
    record([pool(0,120,[{at:60,character:'莱万汀'},{at:120,character:'莱万汀',forced:true}])]),
    record([pool(0,81,[{at:81,character:'莱万汀'}])]),
  ];
  for(const input of inputs)for(const axis of axes)unscored(production.scoreCharacter(input),axis);
});

test('scoped issues remain scoped and malformed source events cannot manufacture scores',()=>{
  const input=record([pool(0,20,[{at:10,character:'莱万汀'}])]);
  input.issues=[{severity:'error',message:'限定来源冲突',axes:['limited']}];
  const r=production.scoreCharacter(input);scored(r);scored(r,'up');unscored(r,'limited');
  const bad=record([pool(0,20,[{at:10,character:'莱万汀',source:'token'}])]);
  for(const axis of axes)unscored(production.scoreCharacter(bad),axis);
});

test('potential tokens are not random six or UP output and do not change luck axes',()=>{
  const base=record([pool(0,240,[{at:60,character:'莱万汀'},{at:120,character:'余烬'},
    {at:180,character:'余烬'},{at:240,character:'余烬'}])]);
  const other=structuredClone(base);other.pools[0].tokens=[{at:240}];
  const a=production.scoreCharacter(base),b=production.scoreCharacter(other);
  for(const axis of axes)near(scored(a,axis),scored(b,axis));
});

test('five scorer and quota accounting are byte-equivalent to the frozen validation path',()=>{
  const pools=[pool(0,120,[{at:70,character:'伊冯'},{at:120,character:'莱万汀',forced:true}],{
    rushUsed:true,rushAt:30,rush:[{character:'洁尔佩塔'}],quota:20*130+1980*3+180*18,
  })];
  const input=record(pools),before=structuredClone(input);
  const actual=production.scoreCharacter(input),expected=ledger.scoreCharacter(input);
  assert.deepEqual(actual.axes.five,expected.axes.five);
  assert.deepEqual(input,before);
});

test('all production sample reads are immutable and repeatable',()=>{
  const input=record([pool(0,120,[{at:70,character:'伊冯'},{at:120,character:'莱万汀',forced:true}],{
    rushUsed:true,rushAt:null,rush:[{character:'洁尔佩塔'}],quota:20*130+1980*3+180*18,
  })]);
  const before=JSON.stringify(input),a=production.scoreCharacter(input),b=production.scoreCharacter(input);
  assert.equal(JSON.stringify(input),before);assert.deepEqual(a,b);
});

test('UP waiting kernel accepts the public production comparison bound',()=>{
  const maxWait=30000+math.CUP*(120+12)+128;
  const pmf=math.upWait(0,120,maxWait);
  near(math.sumMass(pmf),1);assert.equal(pmf.p.length,120);
});

test('partial coverage with known opening is not itself a scoring conflict',()=>{
  const full=record([pool(8,20,[{at:10,character:'诀'}])]);
  const partial={...full,completeHistory:false,issues:[{
    code:'incomplete_history',severity:'error',axes:['characterSix','up','limited'],message:'old blanket gate',
  }]};
  const a=production.scoreCharacter(full),b=production.scoreCharacter(partial);
  for(const key of axes)near(scored(a,key),scored(b,key));
});

test('known nonzero opening conditions the count reference without inventing prior draws',()=>{
  const input=record([pool(8,6,[],{initialPity:64,tail:70})],{completeHistory:false,initialPity:64});
  const r=production.scoreCharacter(input);
  near(scored(r),50*[.992,.942,.892,.842,.792,.742].reduce((a,b)=>a*b,1));
  assert.equal(r.counts.main,6);
});

test('unknown opening with no hit cannot fabricate main timing but independent rush still scores',()=>{
  const input=record([pool(8,20)],{completeHistory:false,initialPity:null,initialOwned:null});
  unscored(production.scoreCharacter(input));
  const rush=record([pool(8,30,[],{rushUsed:true,rush:[]})],{completeHistory:false,initialPity:null,initialOwned:null});
  near(scored(production.scoreCharacter(rush)),50*.992**10);
});

test('partial gaps retain missing-interval evidence and do not manufacture NEW',()=>{
  const input=record([pool(6,10,[{at:5,character:'弭弗'}]),pool(8,20,[{at:10,character:'卡缪'}])],
    {completeHistory:false,initialPity:0,initialOwned:[]});
  const r=production.scoreCharacter(input);axes.forEach(a=>scored(r,a));
  assert.equal(r.coverage.excludedMainDraws,10);
  assert.equal(r.coverage.ownershipMode,'limited-only-no-new-bonus');
  assert.equal(r.axes.limited.details.identities.at(-1).weight,1);
});

test('no input or empty zero-draw pools never manufacture a50 score',()=>{
  for(const input of [record([]),record([pool(0,0)])]) {
    const r=production.scoreCharacter(input);
    for(const axis of [...axes,'five'])unscored(r,axis);
  }
});

test('unknown rush usage, malformed event positions and inconsistent tail remain blocked',()=>{
  const cases=[
    record([pool(0,30,[],{rushUsed:null})]),
    record([pool(0,20,[{at:10,character:'莱万汀'},{at:10,character:'余烬'}])]),
    record([pool(0,20,[],{tail:0})]),
    record([pool(0,20,[{at:10,character:'莱万汀'}]),pool(0,10)]),
  ];
  for(const input of cases)for(const axis of axes)unscored(production.scoreCharacter(input),axis);
});
