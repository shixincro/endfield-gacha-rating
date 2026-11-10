'use strict';
// Ordinary-80 limited-value count reference with chronological ownership DP.
// The recorded banner schedule is fixed. Reference draws never force120.
function check(ok,message='限定价值参数不合法') {if(!ok)throw new Error(message);}
function equal(a,b,message='限定价值参数不一致') {check(a===b,message);}
const {performance}=require('node:perf_hooks');
const catalog=require('./character_ledger');
const nameOf=n=>n==='俊卫'?'骏卫':n;
const offIndices=i=>i===0?[1,2]:i===1?[0,2]:[i-1,i-2];
const hazard=p=>p===79?1:p<65?.008:.008+.05*(p-64);
const sum=a=>Array.from(a).reduce((s,p)=>s+p,0);
const knownNames=new Set([...catalog.LIMITED,...catalog.COMMON]);
const isInt=(n,a,b)=>Number.isSafeInteger(n)&&n>=a&&n<=b;

function observe(record,{includeNew=true}={}) {
  check(record&&Array.isArray(record.pools),'缺少卡池记录');
  check(isInt(record.initialPity,0,79),'期初水位未知');
  check(!includeNew||Array.isArray(record.initialOwned),'期初图鉴未知，无法判断New；可使用不含New的限定评分');
  const ownershipKnown=Array.isArray(record.initialOwned);
  const owned=new Set((ownershipKnown?record.initialOwned:[]).map(nameOf));
  for(const n of owned)check(knownNames.has(n),'期初图鉴包含未知角色');
  let mainN=0,rushN=0,mainSix=0,rushSix=0,L=0,B=0,forcedSix=0,previous=-1;
  const rows=[],schedule=[];
  for(const pool of record.pools) {
    check(isInt(pool.index,0,catalog.LIMITED.length-1)&&pool.index>previous,'卡池顺序不合法');
    check(pool.interruptionBefore!==true,'中断修正须使用分段兼容DP，不能跨中断继承水位和图鉴');
    check(record.completeHistory===true||previous<0||pool.index===previous+1,'中间记录缺失，需分段恢复水位和图鉴状态');previous=pool.index;
    check(isInt(pool.total,0,30000));
    const index=pool.index,up=catalog.LIMITED[index],off=offIndices(index).map(i=>catalog.LIMITED[i]);
    const legal=new Set([up,...off,...catalog.COMMON]);
    const rushAt=pool.rushUsed?(pool.rushAt??30):null;
    if(pool.rushUsed)check(isInt(rushAt,0,pool.total),'加急使用位置不合法');
    else equal((pool.rush??[]).length,0);
    let at=0;
    const events=pool.events.map(e=>{
      check(isInt(e.at,1,pool.total)&&e.at>at);at=e.at;
      return {...e,type:'main'};
    });
    if(pool.rushUsed)events.push({at:rushAt,type:'rush'});
    events.sort((a,b)=>a.at-b.at||(a.type==='main'?-1:1));
    for(const e of events) {
      const results=e.type==='main'?[e]:pool.rush;
      if(e.type==='rush')check(results.length<=10);
      for(const hit of results) {
        const name=nameOf(hit.character);check(legal.has(name),'角色身份未知或不属于此卡池');
        const limited=catalog.LIMITED.includes(name),isNew=ownershipKnown&&off.includes(name)&&!owned.has(name);
        L+=Number(limited);B+=Number(isNew);
        if(e.type==='main') {mainSix++;forcedSix+=Number(!!hit.forced);}else rushSix++;
        rows.push({pool:pool.id??index,at:e.at,source:e.type,character:name,limited,offNew:isNew,value:Number(limited)+Number(isNew)});
        owned.add(name);
      }
    }
    mainN+=pool.total;rushN+=pool.rushUsed?10:0;
    schedule.push({index,mainDraws:pool.total,rushDraws:pool.rushUsed?10:0,rushAt});
  }
  check(mainN<=30000);
  return {schedule,rows,mainN,rushN,mainSix,rushSix,forcedSix,L,B,V:L+B};
}

function distributionForSchedule(schedule,{initialPity=0,initialOwned=[],includeNew=true,maxValue,pruneOwnership=true}={}) {
  const started=performance.now();
  check(isInt(initialPity,0,79));check(Array.isArray(initialOwned));
  check(isInt(maxValue,0,2000));
  check(Array.isArray(schedule),'缺少卡池抽数计划');
  const drawBudget=schedule.reduce((n,p)=>n+(p.mainDraws??0)+(p.rushDraws??0),0);
  check(Number.isSafeInteger(drawBudget)&&drawBudget>=0&&drawBudget<=40000,'限定总抽数超过计算范围');
  check(drawBudget*(maxValue+1)*80*(includeNew?8:1)<=500000000,'限定价值分布超过本地安全计算上限');
  let initialMask=0;
  for(const name of initialOwned.map(nameOf)) {
    check(knownNames.has(name));const bit=catalog.LIMITED.indexOf(name);if(bit>=0)initialMask|=1<<bit;
  }
  let previous=-1,mainN=0,rushN=0;
  const future=new Array(schedule.length+1).fill(0);
  for(let i=schedule.length-1;i>=0;i--) {
    const p=schedule[i];check(isInt(p.index,0,catalog.LIMITED.length-1));
    future[i]=future[i+1]|(1<<p.index)|offIndices(p.index).reduce((m,j)=>m|(1<<j),0);
  }
  const width=(maxValue+1)*80;
  let initial=new Float64Array(width);initial[initialPity]=1;
  let states=new Map([[includeNew?initialMask&future[0]:0,initial]]),peakMasks=states.size;
  function trim(mask) {
    if(!includeNew||!pruneOwnership)return;
    const merged=new Map();
    for(const [old,arr] of states) {
      const key=old&mask;
      if(!merged.has(key))merged.set(key,arr.slice());
      else {const out=merged.get(key);for(let j=0;j<width;j++)out[j]+=arr[j];}
    }
    states=merged;
  }
  function step(index,rush) {
    const next=new Map(),[offA,offB]=offIndices(index);
    function target(mask) {if(!next.has(mask))next.set(mask,new Float64Array(width));return next.get(mask);}
    for(const [mask,arr] of states) {
      const keep=target(mask),up=target(includeNew?mask|(1<<index):0);
      const a=target(includeNew?mask|(1<<offA):0),b=target(includeNew?mask|(1<<offB):0);
      const da=includeNew&&!(mask&(1<<offA))?2:1,db=includeNew&&!(mask&(1<<offB))?2:1;
      for(let v=0;v<=maxValue;v++)for(let pity=0;pity<80;pity++) {
        const pos=v*80+pity,mass=arr[pos];if(!mass)continue;
        const q=rush?.008:hazard(pity),hit=mass*q,endPity=rush?pity:0;
        if(rush)keep[pos]+=mass*(1-q);else if(pity<79)keep[pos+1]+=mass*(1-q);
        keep[v*80+endPity]+=hit*5/14;
        if(v+1<=maxValue)up[(v+1)*80+endPity]+=hit*7/14;
        if(v+da<=maxValue)a[(v+da)*80+endPity]+=hit/14;
        if(v+db<=maxValue)b[(v+db)*80+endPity]+=hit/14;
      }
    }
    states=next;peakMasks=Math.max(peakMasks,states.size);
  }
  for(let i=0;i<schedule.length;i++) {
    const pool=schedule[i];check(pool.index>previous);previous=pool.index;
    check(isInt(pool.mainDraws,0,30000)&&isInt(pool.rushDraws??0,0,1000));
    const rn=pool.rushDraws??0,at=rn?pool.rushAt:null;if(rn)check(isInt(at,0,pool.mainDraws));
    trim(future[i]);
    if(rn&&at===0)for(let r=0;r<rn;r++)step(pool.index,true);
    for(let n=1;n<=pool.mainDraws;n++) {
      step(pool.index,false);
      if(rn&&n===at)for(let r=0;r<rn;r++)step(pool.index,true);
    }
    mainN+=pool.mainDraws;rushN+=rn;
  }
  const p=new Float64Array(maxValue+1);
  for(const arr of states.values())for(let v=0;v<=maxValue;v++)for(let pity=0;pity<80;pity++)p[v]+=arr[v*80+pity];
  const retainedMass=sum(p);check(retainedMass>=0&&retainedMass<=1+1e-10);
  return {p:Array.from(p),retainedMass,overflow:Math.max(0,1-retainedMass),maxValue,peakMasks,mainN,rushN,milliseconds:performance.now()-started};
}

function scoreRecord(record,{includeNew=true}={}) {
  const data=observe(record,{includeNew}),actual=includeNew?data.V:data.L;
  const ref=distributionForSchedule(data.schedule,{initialPity:record.initialPity,initialOwned:Array.isArray(record.initialOwned)?record.initialOwned:[],includeNew,maxValue:actual});
  const score=data.mainN+data.rushN?100*(sum(ref.p.slice(0,actual))+.5*ref.p[actual]):null;
  if(score!==null)check(score>=-1e-10&&score<=100+1e-10);
  return {status:score===null?'unscored':'scored',includeNew,score:score===null?null:Math.max(0,Math.min(100,score)),actual,...data,reference:ref,
    scope:'ordinary80 reference; actual forced120 counted; fixed observed schedule; chronological New ownership; tokens excluded'};
}
module.exports={observe,distributionForSchedule,scoreRecord};
