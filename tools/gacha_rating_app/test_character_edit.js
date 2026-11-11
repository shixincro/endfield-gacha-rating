'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const edit = require('./static/character-edit');
const {scoreCharacter} = require('./character_score');

const pool = (extra={}) => ({id:'p0',index:0,banner:edit.BANNERS[0],up:edit.LIMITED[0],total:60,
  initialPity:0,tail:10,quota:5000,events:[{at:50,character:'莱万汀',source:'main',forced:false}],
  rushUsed:true,rushAt:30,rush:[],tokens:[],issues:[],...extra});
const record = pools => ({pools,initialPity:pools[0]?.initialPity ?? null,initialOwned:[],completeHistory:true});
const nextPool = extra => pool({id:'p1',index:1,banner:edit.BANNERS[1],up:edit.LIMITED[1],total:20,
  initialPity:10,tail:30,events:[],rushUsed:false,rushAt:null,...extra});

test('interruption supplements validate ownership and pity separately and preserve stored facts',()=>{
  const draft=record([pool(),nextPool()]);
  for(const info of [null,[],{initialPity:true},{initialPity:-1},{initialPity:80},{initialPity:null},
    {initialPity:1.5},{initialPity:'20'},{catalogComplete:1},{ownedSixStars:null},
    {ownedSixStars:['未知']},{ownedSixStars:['骏卫','俊卫']}]){
    draft.interruptionCorrection={excludedIndices:[0],resumeInfo:{1:info}};
    assert.notEqual(edit.validateInterruption(draft),'',JSON.stringify(info));
  }
  draft.interruptionCorrection={excludedIndices:[0],resumeInfo:{1:{initialPity:25,ownedSixStars:['俊卫'],catalogComplete:true}}};
  const original=structuredClone(draft);
  assert.equal(edit.validateInterruption(draft),'');
  const luck=edit.projectCharacter(draft),planning=edit.projectCharacter(draft,{forPlanning:true});
  assert.equal(luck.character.pools[0].initialPity,25);assert.equal(luck.character.pools[0].tail,45);
  assert.equal(planning.character.pools[0].initialPity,0);assert.equal(planning.character.pools[0].tail,20);
  assert.deepEqual(luck.character.pools[0].interruptionCatalog,{ownedSixStars:['骏卫'],catalogComplete:true});
  assert.deepEqual(draft,original);
});

test('interruption across a missing banner resets only the effective record and is reversible',()=>{
  const before=pool({id:'p6',index:6,banner:edit.BANNERS[6],up:edit.LIMITED[6],total:30,initialPity:0,tail:30,events:[],rushUsed:false,rushAt:null});
  const after=pool({id:'p8',index:8,banner:edit.BANNERS[8],up:edit.LIMITED[8],total:70,initialPity:30,tail:0,
    events:[{at:70,character:edit.LIMITED[8],source:'main'}],freeDrawPositions:Array.from({length:20},(_,i)=>i+1)});
  const draft=record([before,after]),raw=JSON.stringify(draft);
  assert.match(edit.validatePool(after),/100抽/);
  draft.interruptionCorrection={excludedIndices:[7],freeAllowances:{8:20}};
  const projected=edit.projectCharacter(draft);
  assert.equal(projected.character.pools[1].initialPity,0);assert.equal(projected.character.pools[1].freeAllowance,20);
  assert.equal(projected.character.pools[1].freeDrawPositions,undefined);assert.equal(after.freeDrawPositions.length,20);
  assert.equal(edit.validatePool(projected.character.pools[1]),'');assert.equal(edit.validateLinks(draft),'');
  assert.equal(projected.character.completeHistory,false);assert.deepEqual(projected.summary.excludedBanners,['逐罪者']);
  assert.deepEqual(projected.summary.resetPools.map(p=>p.id),['p8']);
  delete draft.interruptionCorrection;assert.equal(JSON.stringify(draft),raw);
  assert.match(edit.validatePool(edit.projectCharacter(draft).character.pools[1]),/100抽/);
});

test('interruption projection propagates consistent no-hit water and preserves unrelated conflicts',()=>{
  const a=pool({id:'p2',index:2,banner:edit.BANNERS[2],up:edit.LIMITED[2],total:20,initialPity:30,tail:50,events:[],rushUsed:false,rushAt:null});
  const b=pool({id:'p3',index:3,banner:edit.BANNERS[3],up:edit.LIMITED[3],total:5,initialPity:50,tail:55,events:[],rushUsed:false,rushAt:null});
  const c=pool({id:'p4',index:4,banner:edit.BANNERS[4],up:edit.LIMITED[4],total:5,initialPity:9,tail:14,events:[],rushUsed:false,rushAt:null});
  const draft=record([a,b,c]);draft.interruptionCorrection={excludedIndices:[1],freeAllowances:{2:0}};
  const effective=edit.projectCharacter(draft).character;
  assert.deepEqual(effective.pools.map(p=>[p.initialPity,p.tail]),[[0,20],[20,25],[9,14]]);
  assert.equal(effective.initialPity,0);assert.equal(effective.initialOwned,null);assert.equal(edit.validatePool(effective.pools[0]),'');
  assert.match(edit.validateLinks(draft),/期初水位9/);
  assert.deepEqual(draft.pools.map(p=>[p.initialPity,p.tail]),[[30,50],[50,55],[9,14]]);
});

test('excluding recorded pools removes only the projected scope and unallocatable total quota',()=>{
  const draft=record([pool(),nextPool({total:null,events:[{at:null,character:null}]})]);
  draft.quotaSummary={scope:'all-pools',Q:7000,N:80,R:1,K6:1};
  draft.interruptionCorrection={excludedIndices:[1],freeAllowances:{}};
  const effective=edit.projectCharacter(draft);
  assert.deepEqual(effective.character.pools.map(p=>p.id),['p0']);assert.equal(effective.character.quotaSummary,undefined);
  assert.deepEqual(effective.summary.excludedPoolIds,['p1']);assert.equal(draft.pools.length,2);assert.equal(draft.quotaSummary.Q,7000);
  draft.interruptionCorrection.excludedIndices=[0,1];
  assert.equal(edit.projectCharacter(draft).character.initialPity,null);
});

test('interruption water editing does not propagate through excluded or reset boundaries',()=>{
  const first=pool(),next=nextPool(),draft=record([first,next]);
  draft.interruptionCorrection={excludedIndices:[0],freeAllowances:{}};
  first.total=61;edit.updatePoolWater(draft,first);
  assert.equal(first.tail,11);assert.equal(next.initialPity,10);assert.equal(next.tail,30);
  assert.equal(edit.projectCharacter(draft).character.pools[0].initialPity,0);
});

test('interruption settings reject invalid indices and free-allowance values',()=>{
  for(const settings of [{excludedIndices:[1,1]},{excludedIndices:[edit.BANNERS.length]},{excludedIndices:['1']},
    {excludedIndices:[1],freeAllowances:{2:5}},{excludedIndices:[1],freeAllowances:{'02':10}}]){
    const draft=record([pool()]);draft.interruptionCorrection=settings;
    assert(edit.validateInterruption(draft));assert.throws(()=>edit.projectCharacter(draft));
  }
});

test('selecting only future absent banners leaves exact zero-gap evidence unchanged',()=>{
  const draft=record([pool(),nextPool({index:3,banner:edit.BANNERS[3],up:edit.LIMITED[3]})]);
  draft.historyEvidence='launch_and_exact_category_totals_zero_pull_gaps';
  draft.interruptionCorrection={excludedIndices:[7,9],freeAllowances:{}};
  const {character,summary}=edit.projectCharacter(draft);
  assert.deepEqual(character,draft);assert.equal(summary.enabled,true);assert.deepEqual(summary.resetPools,[]);
});

test('manual whole pool can restore a missing launch pool without inventing pulls',()=>{
  const next=nextPool({initialPity:5,total:20,tail:25}),draft=record([next]);
  draft.firstPoolHistory={poolId:next.id,isFirstPool:false};draft.initialOwned=['莱万汀'];
  const before=JSON.stringify(next),added=edit.addPool(draft,0);
  assert.deepEqual(draft.pools.map(p=>p.index),[0,1]);assert.equal(added.evidence.manual,true);
  assert.equal(added.total,null);assert.equal(added.quota,null);assert.equal(added.rushUsed,null);
  assert.equal(added.initialPity,0);assert.equal(draft.initialPity,0);assert.deepEqual(draft.initialOwned,[]);
  assert.equal(draft.firstPoolHistory,undefined);assert.equal(JSON.stringify(next),before);
  Object.assign(added,{total:5,quota:100,rushUsed:false});edit.updatePoolWater(draft,added);
  assert.equal(added.tail,5);assert.equal(edit.validatePool(added),'');assert.equal(edit.validateLinks(draft),'');
});

test('manual pool inherits only an adjacent known water and preserves downstream evidence',()=>{
  const first=pool(),last=nextPool({index:3,banner:edit.BANNERS[3],up:edit.LIMITED[3],initialPity:22});
  const draft=record([last,first]),before=JSON.stringify(last);
  const middle=edit.addPool(draft,2);assert.equal(middle.initialPity,null);
  assert.equal(draft.completeHistory,false);assert.equal(JSON.stringify(last),before);
  assert.equal(edit.addPool(draft,1).initialPity,10);
});

test('manual selector rejects duplicate banners, invalid indices and colliding ids',()=>{
  const draft=record([pool({id:'manual-banner-1'})]);
  assert.equal(edit.availableBanners(draft).length,edit.BANNERS.length-1);
  assert.throws(()=>edit.addPool(draft,0),/已存在/);
  for(const invalid of [-1,edit.BANNERS.length,'1',1.5,null]) assert.throws(()=>edit.addPool(draft,invalid),/有效/);
  assert.equal(edit.addPool(draft,1).id,'manual-banner-1-1');
  assert(!edit.availableBanners(draft).some(p=>p.index===1));
});

test('removal is limited to manual pools and reopens missing banner selection',()=>{
  const draft=record([pool()]),added=edit.addPool(draft,1);
  assert.equal(edit.removeManualPool(draft,'p0'),false);
  assert.equal(edit.removeManualPool(draft,added.id),true);
  assert.equal(edit.removeManualPool(draft,added.id),false);
  assert(edit.availableBanners(draft).some(p=>p.index===1));assert.equal(draft.pools.length,1);
});

test('changing first manual pool invalidates history answers and ownership tied to old scope',()=>{
  const draft=record([nextPool({index:4,banner:edit.BANNERS[4],up:edit.LIMITED[4]})]);
  draft.firstPoolHistory={poolId:'p1',isFirstPool:true};
  const added=edit.addPool(draft,3);assert.equal(draft.initialPity,null);
  assert.equal(draft.initialOwned,null);assert.equal(draft.completeHistory,false);
  draft.firstPoolHistory={poolId:added.id,isFirstPool:true};
  edit.removeManualPool(draft,added.id);assert.equal(draft.firstPoolHistory,undefined);
  assert.equal(draft.initialOwned,null);assert.equal(draft.initialPity,10);
});

test('adding a pool preserves an explicit statement that launch pool has earlier history',()=>{
  const draft=record([pool()]);draft.firstPoolHistory={poolId:'p0',isFirstPool:false};draft.completeHistory=false;
  edit.addPool(draft,1);assert.equal(draft.completeHistory,false);
  assert.equal(draft.firstPoolHistory.isFirstPool,false);
});

test('new latest hit updates derived tail and all matching downstream links',()=>{
  const first=pool(),next=nextPool(),last=nextPool({id:'p2',index:2,initialPity:30,tail:40,total:10});
  const draft=record([first,next,last]);first.events.push({at:55,character:'余烬',source:'main'});
  edit.updatePoolWater(draft,first);
  assert.equal(first.tail,5);assert.equal(first.localTail,5);assert.equal(next.initialPity,5);
  assert.equal(next.tail,25);assert.equal(last.initialPity,25);assert.equal(last.tail,35);
});
test('known-complete history carries across confirmed zero-draw gaps',()=>{
  const first=pool(),next=nextPool({index:3});const draft=record([first,next]);
  first.total=61;edit.updatePoolWater(draft,first);assert.equal(next.initialPity,11);assert.equal(next.tail,31);
});
test('partial history never propagates through missing banners or mismatched user evidence',()=>{
  for(const [index,initial] of [[3,10],[1,9]]) {
    const first=pool(),next=nextPool({index,initialPity:initial});const draft=record([first,next]);draft.completeHistory=false;
    first.total=61;edit.updatePoolWater(draft,first);assert.equal(next.initialPity,initial);assert.equal(next.tail,30);
  }
});
test('manual first opening edits synchronize a previously conflicting root',()=>{
  const first=pool({initialPity:7,total:20,tail:27,events:[],rushUsed:false,rushAt:null}),draft=record([first]);draft.initialPity=0;
  edit.setInitialPity(draft,first,9);assert.equal(draft.initialPity,9);assert.equal(first.tail,29);assert.equal(edit.validateLinks(draft),'');
});
test('supplying an unknown opening fills a whole contiguous no-hit chain',()=>{
  const first=pool({initialPity:null,total:10,tail:null,events:[],rushUsed:false,rushAt:null});
  const next=nextPool({initialPity:null,tail:null,total:20}),last=nextPool({id:'p2',index:2,initialPity:null,tail:null,total:5});
  const draft=record([first,next,last]);draft.completeHistory=false;edit.setInitialPity(draft,first,7);
  assert.deepEqual(draft.pools.map(p=>[p.initialPity,p.tail]),[[7,17],[17,37],[37,42]]);
  assert.equal(edit.validateLinks(draft),'');
});
test('unknown propagation stops at an independent known opening or a partial-history gap',()=>{
  for(const [index,initial] of [[1,22],[3,null]]) {
    const first=pool({initialPity:null,total:10,tail:null,events:[],rushUsed:false,rushAt:null});
    const next=nextPool({index,initialPity:initial,tail:42}),draft=record([first,next]);draft.completeHistory=false;
    edit.setInitialPity(draft,first,7);assert.equal(next.initialPity,initial);assert.equal(next.tail,42);
  }
});
test('manual tail identifies unknown no-hit opening and propagates a known link',()=>{
  const first=pool({initialPity:null,total:20,tail:25,events:[],rushUsed:false,rushAt:null});
  const next=nextPool({initialPity:25,tail:45}),draft=record([first,next]);
  edit.setTail(draft,first,27);assert.equal(first.initialPity,7);assert.equal(draft.initialPity,7);
  assert.equal(next.initialPity,27);assert.equal(next.tail,47);assert.equal(edit.validatePool(first),'');
});
test('manual contradictory tail stays visible and does not overwrite downstream evidence',()=>{
  const first=pool(),next=nextPool(),draft=record([first,next]);edit.setTail(draft,first,12);
  assert.equal(first.tail,12);assert.equal(next.initialPity,10);assert.match(edit.validatePool(first),/应为10/);
  assert.match(edit.validateLinks(draft),/不一致/);
});
test('known no-hit opening is not silently changed to fit an entered tail',()=>{
  const first=pool({total:20,tail:20,events:[],rushUsed:false,rushAt:null}),draft=record([first]);
  edit.setTail(draft,first,25);assert.equal(first.initialPity,0);assert.equal(draft.initialPity,0);
  assert.match(edit.validatePool(first),/应为20/);
});
test('tail edits do not silently overwrite known root opening information',()=>{
  const first=pool({initialPity:null,total:20,tail:null,events:[],rushUsed:false,rushAt:null}),draft=record([first]);draft.initialPity=3;
  edit.setTail(draft,first,25);assert.equal(first.initialPity,null);assert.equal(draft.initialPity,3);
  assert.match(edit.validateLinks(draft),/期初信息不一致/);
});
test('invalid event position preserves old tail until fixed',()=>{
  const p=pool(),draft=record([p]);p.events[0].at=100;edit.updatePoolWater(draft,p);assert.equal(p.tail,10);
  assert.match(edit.validatePool(p),/累计位置/);
  p.events[0].at=55;edit.updatePoolWater(draft,p);assert.equal(p.tail,5);
});
test('editing an earlier event never uses its insertion order as the last hit',()=>{
  const p=pool(),draft=record([p]);p.events.push({at:20,source:'main',character:'余烬'});edit.updatePoolWater(draft,p);
  edit.normalizePool(p);assert.deepEqual(p.events.map(e=>e.at),[20,50]);assert.equal(p.tail,10);
});
test('unknown opening and unknown no-hit ending remain a valid partial segment',()=>{
  const p=pool({initialPity:null,total:20,tail:null,events:[],rushUsed:false,rushAt:null});
  assert.equal(edit.validatePool(p),'');assert.equal(edit.derivedPoolTail(p),null);
});
test('unknown no-hit segment cannot hide a missing 80 guarantee',()=>{
  const p=pool({initialPity:null,total:80,tail:null,events:[]});assert.match(edit.validatePool(p),/80/);
});
test('invalid numerics, duplicates, missing names and wrong sources are rejected',()=>{
  for(const value of [-1,10001,1.5,NaN,Infinity,null]) assert.notEqual(edit.validatePool(pool({total:value})),'');
  for(const patch of [{at:61},{at:null},{at:10.5},{character:null},{source:'token'}]) {
    const p=pool();Object.assign(p.events[0],patch);assert.notEqual(edit.validatePool(p),'');
  }
  const p=pool();p.events.push({...p.events[0]});assert.match(edit.validatePool(p),/重复/);
});
test('valid global character unavailable in this banner is rejected for both draw sources',()=>{
  const p=pool();p.events[0].character='祀';assert.match(edit.validatePool(p),/名单/);
  const r=pool({rush:[{character:'祀'}]});assert.match(edit.validatePool(r),/加急.*名单/);
});
test('first three launch candidates and future rolling pair match canonical backend lists',()=>{
  assert(edit.candidates(pool()).includes('伊冯'));
  assert(edit.candidates(pool({up:'洁尔佩塔'})).includes('莱万汀'));
  assert(edit.candidates(pool({up:'祀'})).includes('梨诺'));
  assert(!edit.candidates(pool({up:'祀'})).includes('莱万汀'));
});
test('120 forced event does not bypass the 80 six-star guarantee',()=>{
  const p=pool({total:120,tail:0,events:[{at:30,character:'余烬',source:'main'},
    {at:120,character:'莱万汀',source:'main'}]});
  assert.match(edit.validatePool(p),/90抽/);
});
test('legal 80-distance forced UP is normalized and passes production axes',()=>{
  const p=pool({total:120,tail:0,quota:6560,events:[{at:120,character:'莱万汀',source:'main'},
    {at:40,character:'余烬',source:'main'}]});edit.normalizePool(p);
  assert.equal(edit.validatePool(p),'');assert.equal(p.events[1].forced,true);
  const result=scoreCharacter(record([p]));
  for(const key of ['characterSix','up','limited'])assert.equal(result.axes[key].status,'scored',result.axes[key].reason);
});
test('off at120 before any UP is rejected and earlier UP removes forced marker',()=>{
  const p=pool({total:120,tail:0,events:[{at:60,character:'余烬',source:'main'},
    {at:120,character:'别礼',source:'main'}]});assert.match(edit.validatePool(p),/必须为当期UP/);
  p.events[0].character='莱万汀';edit.normalizePool(p);assert.equal(edit.validatePool(p),'');assert.equal(p.events[1].forced,false);
});
test('missing first120 UP cannot be acknowledged by editing quota',()=>{
  const p=pool({total:130,tail:10,events:[{at:60,character:'余烬',source:'main'},
    {at:120,character:'别礼',source:'main'}]});assert.notEqual(edit.validatePool(p),'');
});
test('turning rush off removes stale time but preserves conflicting hits for user repair',()=>{
  const p=pool({total:20,tail:20,events:[],rush:[{character:'余烬'}]});edit.setRushUsed(p,false);
  assert.equal(p.rushAt,null);assert.equal(p.rush.length,1);assert.match(edit.validatePool(p),/未使用加急/);
  p.rush=[];assert.equal(edit.validatePool(p),'');edit.setRushUsed(p,true);assert.equal(p.rushAt,30);
  assert.match(edit.validatePool(p),/30/);
});
test('rush bounds and forced marking are checked without affecting main water',()=>{
  const p=pool();const before=p.tail;edit.setRushUsed(p,false);edit.setRushUsed(p,true);assert.equal(p.tail,before);
  p.rush=Array.from({length:11},()=>({character:'余烬'}));assert.match(edit.validatePool(p),/最多/);
  p.rush=[{character:'余烬',forced:true}];assert.match(edit.validatePool(p),/强制/);
  p.rush=[];p.rushAt=61;assert.match(edit.validatePool(p),/位置/);
});
test('manual free allowance and explicit rush source are structurally validated',()=>{
  for(const allowance of [0,5,30,'10'])assert.match(edit.validatePool(pool({freeAllowance:allowance})),/免费额度/);
  for(const allowance of [10,20,null])assert.equal(edit.validatePool(pool({freeAllowance:allowance})), '');
  assert.match(edit.validatePool(pool({rush:[{character:'余烬',source:'main'}]})),/来源错误/);
  assert.equal(edit.validatePool(pool({rush:[{character:'余烬'}]})), '');
});
test('changing total adds and removes milestone tokens without altering random-event counts',()=>{
  const p=pool({total:479,tokens:[{at:240,source:'token',evidence:{original:true}}]});const count=p.events.length;
  p.total=480;edit.syncTokens(p);assert.deepEqual(p.tokens.map(t=>t.at),[240,480]);assert.equal(p.tokens[0].evidence.original,true);
  assert.equal(p.events.length,count);p.total=239;edit.syncTokens(p);assert.deepEqual(p.tokens,[]);
});
test('bad duplicate/missing token positions are rebuilt from explicitly confirmed total',()=>{
  const p=pool({total:720,tokens:[{at:null},{at:240},{at:240},{at:1000}]});edit.syncTokens(p);
  assert.deepEqual(p.tokens.map(t=>t.at),[240,480,720]);
});
test('quota omission is allowed only when a whole-record quota exists',()=>{
  const p=pool({quota:null});assert.match(edit.validatePool(p),/配额/);assert.equal(edit.validatePool(p,{allowMissingQuota:true}),'');
});
test('upstream manual initial mismatch is reported instead of modifying preceding data',()=>{
  const p=pool(),next=nextPool(),draft=record([p,next]);edit.setInitialPity(draft,next,12);
  assert.equal(p.tail,10);assert.match(edit.validateLinks(draft),/期初水位12.*期末水位10/);
});
