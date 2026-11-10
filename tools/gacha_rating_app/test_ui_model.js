'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('./static/ui-model');
const {planningOverview, planningTitle, luckTitle, parseWeaponProfile, validateWeapon, makeWeaponConfirmation, isWeaponConfirmed} = model;
const row = (loss, extra = {}) => ({status:'ok', localLoss:loss, ...extra});
const weapon = (extra = {}) => ({N:350, K6:20, KU:8, B:null, H80:null, ...extra});

test('B has its own subtotal and cannot change A or its title', () => {
  const planning = {pools:[row(0,{opportunity:{status:'ok',value:500}})]};
  assert.equal(model.planningOpportunityOverview(planning).total,500);
  assert.equal(planningOverview(planning).total,0);
  assert.equal(planningOverview(planning).title,'自律狂人');
});
test('B excludes unknown, malformed and provisional values independently of A', () => {
  const planning = {pools:[row(null,{status:'partial',opportunity:{status:'ok',value:10}}),
    row(0), row(0,{opportunity:{status:'partial',value:null}}),
    row(0,{opportunity:{status:'provisional',value:100}}),
    row(0,{opportunity:{status:'ok',value:-1}})]};
  assert.deepEqual(model.planningOpportunityOverview(planning),{total:10,count:1,totalPools:5,complete:false});
});
test('missing B is not zero, and only explicitly known zero is shown as zero', () => {
  for(const planning of [undefined,{pools:[]},{pools:[row(1)]}]) {
    assert.equal(model.planningOpportunityOverview(planning).total,null);
  }
  assert.deepEqual(model.planningOpportunityOverview({pools:[row(0,{opportunity:{status:'ok',value:0}})]}),
    {total:0,count:1,totalPools:1,complete:true});
  assert.equal(model.planningOpportunityOverview({pools:[1,2].map(()=>row(0,{opportunity:{status:'ok',value:Number.MAX_VALUE}}))}).total,null);
});

test('same pure helper loads as browser IIFE and CommonJS', () => {
  const context = {window:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./static/ui-model'),'utf8'), context);
  assert.deepEqual(Object.keys(context.window.RatingUIModel).sort(), Object.keys(model).sort());
  assert.equal(context.window.RatingUIModel.planningOverview({pools:[]}).score, null);
  assert.equal(Object.isFrozen(model), true);
});

test('planning includes signed gains and exposes a title instead of a transformed score', () => {
  const result = planningOverview({pools:[row(30), row(-12), row(2)]});
  assert.equal(result.total,20); assert.equal(result.score,null);
  assert.equal(result.title,'自律狂人'); assert.equal(result.lossTier,1);
  assert.equal(result.complete,true); assert.equal(result.count,3); assert.equal(result.totalPools,3);
});
test('large loss stays a direct loss rather than a negative score', () => {
  const result=planningOverview({pools:[row(135)]});
  assert.equal(result.total,135); assert.equal(result.score,null);
  assert.equal(result.title,'上头豪客'); assert.equal(result.lossTier,4);
});
test('all gains preserve negative loss and use first band without clamping', () => {
  const result = planningOverview({pools:[row(-7)]});
  assert.equal(result.total,-7); assert.equal(result.score,null); assert.deepEqual(result.topPools,[]);
  assert.equal(result.title,'自律狂人'); assert.equal(result.lossTier,1);
});
test('empty or absent planning never masquerades as zero loss', () => {
  for (const planning of [undefined,null,{}, {pools:[]}, {pools:'bad'}]) {
    const result = planningOverview(planning);
    assert.equal(result.total,null); assert.equal(result.score,null); assert.equal(result.complete,false);
    assert.equal(result.title,null); assert.equal(result.lossTier,null); assert.equal(result.titleRule,null);
    assert.equal(result.count,0); assert.equal(result.totalPools,0); assert.deepEqual(result.topPools,[]);
  }
});
test('only status ok finite numeric losses contribute', () => {
  const pools = [row(20), row(-5), row(10,{status:'provisional'}), row(100,{status:'partial'}),
    row(NaN),row(Infinity),row('5'),row(null),null];
  const result = planningOverview({pools});
  assert.equal(result.total,15); assert.equal(result.score,null); assert.equal(result.complete,false);
  assert.equal(result.title,null); assert.equal(result.lossTier,null);
  assert.equal(result.count,2); assert.equal(result.totalPools,9);
  assert.deepEqual(result.topPools.map(p=>p.localLoss),[20]);
});
test('no usable rows keeps total and score null', () => {
  const result = planningOverview({pools:[row(0,{status:'partial'}),row(NaN)]});
  assert.equal(result.total,null); assert.equal(result.score,null); assert.equal(result.totalPools,2);
});
test('known cancellation to zero is distinguished from missing data', () => {
  const result = planningOverview({pools:[row(8),row(-8)]});
  assert.equal(result.total,0); assert.equal(result.score,null); assert.equal(result.complete,true);
  assert.equal(result.title,'自律狂人');
});
test('top pools are descending positive losses only and default to five', () => {
  const result = planningOverview({pools:[row(4),row(-100),row(15),row(0),row(8),row(6),row(2),row(1)]});
  assert.deepEqual(result.topPools.map(p=>p.localLoss),[15,8,6,4,2]);
});
test('top-pool limit supports zero and valid custom values', () => {
  const data = {pools:[row(1),row(2),row(3),row(4)]};
  assert.deepEqual(planningOverview(data,2).topPools.map(p=>p.localLoss),[4,3]);
  assert.deepEqual(planningOverview(data,0).topPools,[]);
  assert.equal(planningOverview(data,-1).topPools.length,4);
});
test('planning sort and returned row do not mutate input', () => {
  const data = {pools:[row(1,{id:'a'}),row(4,{id:'b'})]},before=JSON.stringify(data);
  const result = planningOverview(data); result.topPools[0].localLoss=900;
  assert.equal(JSON.stringify(data),before);
});
test('counted loss controls total title and top list while original loss stays intact', () => {
  const data={pools:[row(170,{id:'exempt',planningExempt:true,countedLoss:0,exemptedLoss:170}),row(-12,{countedLoss:-12}),row(21,{countedLoss:21})]};
  const result=planningOverview(data);
  assert.equal(result.total,9);assert.equal(result.title,'自律狂人');assert.deepEqual(result.topPools.map(p=>p.localLoss),[21]);
  assert.equal(result.exemptedPools,1);assert.equal(result.exemptedLossSum,170);assert.equal(data.pools[0].localLoss,170);
});
test('all exempted losses are a complete known zero and missing counted losses stay unknown', () => {
  const exempt=row(170,{planningExempt:true,countedLoss:0,exemptedLoss:170});
  assert.equal(planningOverview({pools:[exempt]}).total,0);assert.equal(planningOverview({pools:[exempt]}).complete,true);
  assert.equal(planningOverview({pools:[exempt]}).title,'自律狂人');assert.deepEqual(planningOverview({pools:[exempt]}).topPools,[]);
  for(const extra of [{countedLoss:null},{status:'partial',countedLoss:0},{status:'provisional',countedLoss:0}]){
    assert.equal(model.planningCountedLoss(row(50,extra)),null);
    const result=planningOverview({pools:[exempt,row(50,extra)]});assert.equal(result.total,0);assert.equal(result.complete,false);assert.equal(result.title,null);
  }
  assert.equal(model.planningCountedLoss(row(12)),12,'legacy rows without countedLoss retain their raw value');
});
test('overflow cannot produce an infinite displayed loss or score', () => {
  const result = planningOverview({pools:[row(Number.MAX_VALUE),row(Number.MAX_VALUE)]});
  assert.equal(result.total,null);assert.equal(result.score,null);assert.equal(result.complete,false);
});

test('all five planning boundaries are inclusive and use raw values not rounded display', () => {
  for(const [loss,tier,title] of [[-1,1,'自律狂人'],[20,1,'自律狂人'],[20.000001,2,'精打细算'],
    [60,2,'精打细算'],[60.000001,3,'随性挥霍'],[120,3,'随性挥霍'],[120.000001,4,'上头豪客'],
    [240,4,'上头豪客'],[240.000001,5,'亏掉底裤'],[1e9,5,'亏掉底裤']]) {
    assert.equal(planningTitle(loss).lossTier,tier); assert.equal(planningTitle(loss).title,title);
  }
});
test('invalid loss cannot create a title', () => {
  for(const value of [null,undefined,NaN,Infinity,-Infinity,'20',true,{}]) {
    assert.deepEqual(planningTitle(value),{title:null,lossTier:null,titleRule:null});
  }
});

const titleAxisKeys=['characterSix','up','limited','weaponSix','signature'];
const axes = (scores, five=50) => ({five:{score:five,status:'scored'},
  ...Object.fromEntries(titleAxisKeys.map((key,index)=>[key,{score:scores[index],status:index<3?'scored':'ok'}]))});
// Expected approved table, indexed by H / M / L in the documented axis order.
const expectedCharacters={
  HHH:'天命所归',HHM:'当期红人',HHL:'金光独宠',HMH:'群星荟萃',HMM:'金光满地',HML:'常驻盛宴',HLH:'歪中藏金',HLM:'歪门宗师',HLL:'常驻收藏家',
  MHH:'双重眷顾',MHM:'当期如约',MHL:'独宠今朝',MMH:'限定眷顾',MMM:'星途平常',MML:'常客有缘',MLH:'歪出奇缘',MLM:'当期守望',MLL:'常驻长情',
  LHH:'惜金藏珍',LHM:'惜金逢君',LHL:'惜金独宠',LMH:'沙里淘珍',LMM:'金光吝啬',LML:'惜金遇故人',LLH:'绝境藏珍',LLM:'金稀君远',LLL:'人才凋零',
};
const expectedWeapons={HH:'武库鼎盛',HM:'百兵来朝',HL:'满库寻本命',MH:'专武眷顾',MM:'兵运平平',ML:'本命难铸',LH:'神兵独秀',LM:'武库清寒',LL:'武库荒年'};

test('five-axis title supports mixed scored and ok statuses without introducing a score', () => {
  const result=luckTitle(axes([50,50,50,50,50]));
  assert.equal(result.name,'星途平常·兵运平平'); assert.equal(result.complete,true);
  assert.equal(result.characterTitle,'星途平常'); assert.equal(result.weaponTitle,'兵运平平');
  assert.equal(result.baseName,result.name);assert.equal(result.profile,null);assert.deepEqual(result.profiles,[]);
  assert.match(result.rule,/五星不参与/);assert.match(result.rule,/娱乐性.*不代表综合概率或排名/);
  assert.equal('score' in result,false); assert.equal('mean' in result,false);
});
test('all 243 basic combinations match the approved 27 by 9 table and whole-profile overrides', () => {
  const values={H:80,M:50,L:20}, names=new Set();let combinations=0;
  for(const [characterKey,characterTitle] of Object.entries(expectedCharacters)) {
    for(const [weaponKey,weaponTitle] of Object.entries(expectedWeapons)) {
      const key=characterKey+weaponKey,result=luckTitle(axes([...key].map(letter=>values[letter])));
      const expected=key==='HHHHH'?'宗师级欧皇':key==='LLLLL'?'非入骨髓':`${characterTitle}·${weaponTitle}`;
      assert.equal(result.name,expected,key);assert.equal(result.characterTitle,characterTitle,key);
      assert.equal(result.weaponTitle,weaponTitle,key);assert.equal(result.complete,true,key);
      assert.equal(result.highCount,[...key].filter(letter=>letter==='H').length,key);
      assert.equal(result.lowCount,[...key].filter(letter=>letter==='L').length,key);
      assert.ok(result.name.split('·').length<=2,key);names.add(result.name);combinations++;
    }
  }
  assert.equal(combinations,243);assert.equal(names.size,243);
});
test('all five participating axes independently reject missing or invalid values and statuses', () => {
  for(const bad of [null,undefined,{},[]])assert.equal(luckTitle(bad).complete,false);
  for(const key of titleAxisKeys) {
    const missing=axes([50,50,50,50,50]);delete missing[key];assert.equal(luckTitle(missing).name,'数据不足',key);
    for(const value of [null,undefined,{},[]]) {
      const data=axes([50,50,50,50,50]);data[key]=value;assert.equal(luckTitle(data).complete,false,key);
    }
    for(const score of [null,undefined,NaN,Infinity,-Infinity,-0.001,100.001,'50',true]) {
      const data=axes([50,50,50,50,50]);data[key].score=score;const result=luckTitle(data);
      assert.equal(result.name,'数据不足',key);assert.equal(result.characterTitle,null);assert.equal(result.weaponTitle,null);
    }
    for(const status of ['unscored','partial','error',null]) {
      const data=axes([50,50,50,50,50]);data[key].status=status;assert.equal(luckTitle(data).complete,false,key);
    }
  }
  assert.equal(luckTitle(axes([0,0,0,100,100])).complete,true);
  assert.equal(luckTitle(Object.fromEntries(titleAxisKeys.map(key=>[key,{score:50}]))).complete,true);
});
test('five-star score, status, absence, or invalid data never changes any title output', () => {
  for(const scores of [[80,20,80,80,50],[90,90,90,90,90],[10,10,10,10,10],[50,50,50,50,50]]) {
    const expected=luckTitle(axes(scores));
    const missing=axes(scores);delete missing.five;assert.deepEqual(luckTitle(missing),expected);
    for(const value of [null,undefined,{},[],{score:0},{score:100},{score:NaN},{score:Infinity},
      {score:'50'}, {score:50,status:'error'},{score:50,status:'partial'}]) {
      const data=axes(scores);data.five=value;assert.deepEqual(luckTitle(data),expected);
    }
    const inaccessible=axes(scores);Object.defineProperty(inaccessible,'five',{get(){throw Error('five must not be read');}});
    assert.deepEqual(luckTitle(inaccessible),expected);
  }
});
test('base bands use exact inclusive 30 and 70 boundaries on each participating axis', () => {
  for(let i=0;i<5;i++) {
    for(const [value,reference] of [[29.999999,20],[30,20],[30.000001,50],[69.999999,50],[70,80],[70.000001,80]]) {
      const scores=Array(5).fill(50),expectedScores=Array(5).fill(50);scores[i]=value;expectedScores[i]=reference;
      assert.deepEqual(luckTitle(axes(scores)),luckTitle(axes(expectedScores)),`${titleAxisKeys[i]}=${value}`);
    }
  }
});
test('four whole-profile titles take priority over composition and group enhancements', () => {
  for(const [scores,name] of [
    [[90,90,90,90,90],'点石成金至尊欧皇'],[[100,100,100,100,100],'点石成金至尊欧皇'],
    [[10,10,10,10,10],'面目全非'],[[0,0,0,0,0],'面目全非'],
    [[70,70,70,70,70],'宗师级欧皇'],[[95,95,95,70,70],'宗师级欧皇'],
    [[30,30,30,30,30],'非入骨髓'],[[0,0,0,30,30],'非入骨髓'],
  ]) {
    const result=luckTitle(axes(scores));assert.equal(result.name,name);assert.match(result.rule,/整体专属/);
    assert.equal(result.name.includes('·'),false);
  }
});
test('whole-profile titles require every participating raw score at each exact boundary', () => {
  for(let i=0;i<5;i++) {
    for(const [boundary,neighbor,name] of [[90,89.999999,'宗师级欧皇'],[10,10.000001,'非入骨髓']]) {
      const scores=Array(5).fill(boundary);scores[i]=neighbor;assert.equal(luckTitle(axes(scores)).name,name);
    }
    for(const [boundary,neighbor,name] of [[70,69.999999,'宗师级欧皇'],[30,30.000001,'非入骨髓']]) {
      const scores=Array(5).fill(boundary);scores[i]=neighbor;assert.notEqual(luckTitle(axes(scores)).name,name);
    }
  }
});
test('four group extremes independently replace only their own half', () => {
  for(const [scores,name,characterTitle,weaponTitle] of [
    [[90,90,90,50,50],'群星俯首·兵运平平','群星俯首','兵运平平'],
    [[10,10,10,50,50],'命途多舛·兵运平平','命途多舛','兵运平平'],
    [[50,50,50,90,90],'星途平常·神兵天授','星途平常','神兵天授'],
    [[50,50,50,10,10],'星途平常·寸铁难求','星途平常','寸铁难求'],
    [[90,90,90,10,10],'群星俯首·寸铁难求','群星俯首','寸铁难求'],
    [[10,10,10,90,90],'命途多舛·神兵天授','命途多舛','神兵天授'],
  ]) {
    const result=luckTitle(axes(scores));assert.equal(result.name,name);assert.equal(result.characterTitle,characterTitle);
    assert.equal(result.weaponTitle,weaponTitle);assert.match(result.rule,/分组强化/);
  }
});
test('group upgrades use inclusive raw thresholds and require all members, not an extreme single axis', () => {
  for(const [indices,field,highBase,lowBase] of [[[0,1,2],'characterTitle','天命所归','人才凋零'],[[3,4],'weaponTitle','武库鼎盛','武库荒年']]) {
    for(const index of indices) {
      for(const [boundary,neighbor,expected] of [[90,89.999999,highBase],[10,10.000001,lowBase]]) {
        const scores=Array(5).fill(50);for(const j of indices)scores[j]=boundary;scores[index]=neighbor;
        assert.equal(luckTitle(axes(scores))[field],expected);
      }
    }
  }
  assert.equal(luckTitle(axes([100,50,50,50,50])).name,'金光满地·兵运平平');
  assert.equal(luckTitle(axes([50,0,50,50,50])).name,'当期守望·兵运平平');
});
test('every participating axis affects lookup and property insertion order does not', () => {
  const baseline=luckTitle(axes([50,50,50,50,50])).name;
  for(let i=0;i<5;i++) {
    const scores=Array(5).fill(50);scores[i]=80;const data=axes(scores),result=luckTitle(data);
    assert.notEqual(result.name,baseline);assert.deepEqual(luckTitle(Object.fromEntries(Object.entries(data).reverse())),result);
  }
});
test('luck nickname generation leaves frozen inputs and all six scores untouched', () => {
  const data=axes([90,80,20,60,70],NaN),before=structuredClone(data);
  for(const value of Object.values(data))Object.freeze(value);Object.freeze(data);
  luckTitle(data);assert.deepEqual(data,before);
});

test('ordinary weapon validation needs no H80 or B', () => {
  assert.deepEqual(validateWeapon(weapon()),[]);
  assert.deepEqual(validateWeapon({N:10,K6:0,KU:0}),[]);
  assert.deepEqual(validateWeapon(weapon({H80:'unused',B:'unused'})),[]);
});
test('empty weapon data cannot be confirmed', () => {
  assert.ok(validateWeapon({N:0,K6:0,KU:0}).some(e=>e.includes('没有武器抽卡数据')));
  assert.ok(validateWeapon(null).length>=3);
});
test('weapon total must be nonnegative safe integer and a ten multiple', () => {
  for (const N of [-10,10.5,'10',NaN,Infinity,true,Number.MAX_SAFE_INTEGER+1]) {
    assert.ok(validateWeapon(weapon({N})).some(e=>e.includes('总抽数必须')));
  }
  assert.ok(validateWeapon(weapon({N:351})).some(e=>e.includes('10的倍数')));
});
test('weapon counts must be nonnegative integers with KU<=K6<=N', () => {
  for (const K6 of [-1,1.5,'20',NaN])assert.ok(validateWeapon(weapon({K6})).length);
  for (const KU of [-1,1.5,'8',NaN])assert.ok(validateWeapon(weapon({KU})).length);
  assert.ok(validateWeapon(weapon({K6:351})).some(e=>e.includes('不能超过总抽数')));
  assert.ok(validateWeapon(weapon({KU:21})).some(e=>e.includes('不能超过六星武器')));
});
test('explicit individual-draw records preserve non-ten totals in both modes',()=>{
  const w=weapon({N:752,K6:33,KU:13,B:5,H80:0,profile:'5 5 3',allowIndividualDraws:true});
  assert.deepEqual(validateWeapon(w),[]);
  assert.equal(validateWeapon(w,{requireProfile:true}).length,0);
  assert.ok(validateWeapon({...w,allowIndividualDraws:false}).some(e=>e.includes('10的倍数')));
});
test('profile correction requires explicit configuration and never infers it from B/H80', () => {
  assert.ok(validateWeapon(weapon({B:10,H80:0}),{requireProfile:true}).some(e=>e.includes('请填写潜能配置')));
  assert.deepEqual(makeWeaponConfirmation(weapon({B:10,H80:0})).profile,null);
  for (const profile of ['0','31','1.5','12 -1','12 1.2','2 1 0 3',12,{},'12 NaN','12 Infinity']) {
    assert.ok(validateWeapon(weapon({profile}),{requireProfile:true}).length,String(profile));
  }
});
test('profile parsing retains potentials above five and counts omitted zero potentials', () => {
  assert.deepEqual(parseWeaponProfile('12'),{profile:'12',types:12,potentials:[],copies:12,errors:[]});
  assert.deepEqual(parseWeaponProfile(' 12\t5  1 '),{profile:'12 5 1',types:12,potentials:[5,1],copies:18,errors:[]});
  assert.deepEqual(parseWeaponProfile('1 6'),{profile:'1 6',types:1,potentials:[6],copies:7,errors:[]});
  assert.deepEqual(validateWeapon(weapon({profile:'1 7'}),{requireProfile:true}),[]);
  assert.deepEqual(validateWeapon(weapon({profile:'12 0 0',KU:12})),[]);
  assert.ok(validateWeapon(weapon({profile:'1 6'})).some(e=>e.includes('不能少于原始当期专武数')));
  assert.ok(parseWeaponProfile('1 9007199254740991').errors.length);
});
test('average metadata is ignored and manually entered loss is bounded by the direct UP draw budget', () => {
  for(const upAverage of [null,0,-1,'51.5',NaN,Infinity,51.55,true])assert.deepEqual(validateWeapon(weapon({upAverage})),[]);
  for(const lossDraws of [true,-1,1.5,343,'2'])assert.ok(validateWeapon(weapon({lossDraws})).some(e=>e.includes('亏损')));
  assert.deepEqual(validateWeapon(weapon({lossDraws:342})),[]);
});
test('legacy overflow is converted into per-full-weapon allocation and missing or inconsistent allocation is rejected',()=>{
  const w=weapon({profile:'3 6 7 1',N:1000,KU:16});
  const config=model.weaponConfigForForm(w);
  assert.deepEqual(config,{totalTypes:3,counts:[1,0,0,0,2],overflowCopies:3,overflowByType:[1,2]});
  assert.deepEqual(validateWeapon({...w,profile:null,potentialConfig:config}),[]);
  assert.ok(validateWeapon({...w,potentialConfig:{...config,overflowByType:[1,1]}}).some(m=>m.includes('溢出份数')));
  const saved=model.weaponForSave({...w,potentialConfig:config,lossDraws:10},false);
  assert.equal(saved.profile,null);assert.equal(saved.potentialConfig,undefined);assert.equal(saved.lossDraws,10);
});
test('profile repetition means potential then type count and preserves overflow', () => {
  const full=parseWeaponProfile('11 5*7'), reversed=parseWeaponProfile('11 7*5');
  assert.deepEqual(full,{profile:'11 5*7',types:11,potentials:Array(7).fill(5),copies:46,errors:[]});
  assert.deepEqual(reversed.potentials,Array(5).fill(7));assert.equal(reversed.copies,46);
  assert.notDeepEqual(full.potentials,reversed.potentials);
  assert.deepEqual(parseWeaponProfile(' 11 5 * 7\t1*2 '),
    {profile:'11 5*7 1*2',types:11,potentials:[5,5,5,5,5,5,5,1,1],copies:48,errors:[]});
  assert.deepEqual(parseWeaponProfile('3 0*2 6').potentials,[0,0,6]);
  assert.deepEqual(validateWeapon(weapon({profile:'11 5*7',N:2000,KU:40,K6:50}),{requireProfile:true}),[]);
  assert.ok(validateWeapon(weapon({profile:'11 5*7',KU:47,K6:50}),{requireProfile:true}).length);
});
test('invalid or oversized profile repetitions fail before expansion', () => {
  for(const profile of ['11*2 5','11 5*0','11 5*12','11 5*7 1*5','11 5**7','11 *7','11 5*',
    '11 5*-1','11 -5*7','11 5*1.5','11 5x7','11 5*999999999','11 1000000000*1','11 5*1000000000','11 '+ '0'.repeat(8192)])
    assert.ok(parseWeaponProfile(profile).errors.length,profile.slice(0,60));
  assert.equal(parseWeaponProfile('11 05*007').copies,46);
});
test('legacy forced guarantee metadata does not constrain the result profile', () => {
  assert.deepEqual(validateWeapon({N:100,K6:3,KU:1,B:30,H80:30,profile:'1'}),[]);
  assert.deepEqual(validateWeapon({N:30,K6:1,KU:0,B:0,H80:-1}),[]);
});

test('confirmation snapshots contain only the selected mode inputs', () => {
  const w = weapon({B:10,H80:0,upAverage:43.8,profile:' 12  5 1 ',details:{foo:1}});
  assert.deepEqual(makeWeaponConfirmation(w,false),{N:350,K6:20,KU:8,lossDraws:null,profile:null,potentialConfig:null});
  assert.deepEqual(makeWeaponConfirmation(w,true),{N:350,K6:20,KU:8,lossDraws:null,profile:'12 5 1',potentialConfig:null});
  assert.equal(Object.keys(makeWeaponConfirmation(w)).length,6);
});
test('matching ordinary and profile snapshots confirm in both call forms', () => {
  const w = weapon({B:10,H80:0,profile:'8'});
  for (const enabled of [false,true]) {
    const saved=makeWeaponConfirmation(w,enabled);
    assert.equal(isWeaponConfirmed(w,saved),true);
    assert.equal(isWeaponConfirmed(w,saved,enabled),true);
  }
});
test('changes in any relevant field revoke confirmation', () => {
  const w=weapon({B:10,H80:0,profile:'8',upAverage:43.8}),saved=makeWeaponConfirmation(w,true);
  for(const patch of [{N:360},{K6:21},{KU:9},{profile:'8 1'},{lossDraws:10}])assert.equal(isWeaponConfirmed({...w,...patch},saved,true),false);
  assert.equal(isWeaponConfirmed({...w,B:9,H80:1},saved,true),true);
});
test('ordinary confirmation ignores unused B and H but not relevant quantities', () => {
  const w=weapon(),saved=makeWeaponConfirmation(w,false);
  assert.equal(isWeaponConfirmed({...w,B:5,H80:1},saved,false),true);
  assert.equal(isWeaponConfirmed({...w,N:360},saved,false),false);
});
test('switching mode revokes a snapshot even if current input values are unchanged', () => {
  const w=weapon({B:10,H80:0,profile:'8'});
  assert.equal(isWeaponConfirmed(w,makeWeaponConfirmation(w,false),true),false);
  assert.equal(isWeaponConfirmed(w,makeWeaponConfirmation(w,true),false),false);
});
test('bad or incomplete snapshots cannot preserve a checked confirmation', () => {
  const w=weapon(),saved=makeWeaponConfirmation(w);
  for(const bad of [null,{},[],{...saved,profile:undefined},{N:350,K6:20,KU:8},{N:350,K6:20,KU:8,B:10,H80:0}])assert.equal(isWeaponConfirmed(w,bad),false);
  assert.equal(isWeaponConfirmed(w,saved,'false'),false);
  const empty={N:0,K6:0,KU:0};assert.equal(isWeaponConfirmed(empty,makeWeaponConfirmation(empty)),false);
});
test('confirmation helpers do not mutate inputs and snapshots are independent', () => {
  const w=weapon({B:10,H80:0,profile:'8'}),before=JSON.stringify(w),saved=makeWeaponConfirmation(w,true);
  validateWeapon(w,{requireProfile:true});isWeaponConfirmed(w,saved,true);saved.N=500;
  assert.equal(JSON.stringify(w),before);
});
