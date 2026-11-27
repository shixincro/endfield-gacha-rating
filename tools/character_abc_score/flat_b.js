'use strict';

const {probabilities:{P}}=require('../gacha_rating_app/character_ledger');

const WATER=80;
const TOKEN_STEP=240;
const MAX_DRAWS=30000;
const MAX_WORK=180000000;
const CACHE_ENTRIES=384;
const CACHE_DRAWS=2048;
const MASS_TOLERANCE=1e-8;

const METRIC={
  characterSix:{field:'six',givenSix:1,hasToken:false},
  limited:{field:'limited',givenSix:9/14,hasToken:false},
  up:{field:'up',givenSix:.5,hasToken:true},
};
const passageCache=new Map();

class FlatBLimit extends RangeError {
  constructor(message) {
    super(message);
    this.name='FlatBLimit';
  }
}

const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

function charge(context,amount) {
  context.work+=amount;
  if(context.work>MAX_WORK)throw new FlatBLimit('B区参照达到计算量上限');
}

function checkedProbability(value) {
  if(!Number.isFinite(value)||value< -MASS_TOLERANCE||value>1+MASS_TOLERANCE) {
    throw new Error('B区参照概率质量不守恒');
  }
  return Math.max(0,Math.min(1,value));
}

function normalize(segment,metric) {
  const {id,start,end,paidPrefix,freeAllowance}=segment??{};
  if(!Array.isArray(paidPrefix)&&!ArrayBuffer.isView(paidPrefix)) {
    throw new RangeError('B区缺少原池永久抽前缀');
  }
  const total=paidPrefix.length-1;
  if(!integer(total,0,MAX_DRAWS)||!integer(start,0,total)||!integer(end,start,total)) {
    throw new RangeError('B区主抽起止位置不合法');
  }
  const observedPaid=paidPrefix[end]-paidPrefix[start];
  if(!integer(observedPaid,0,end-start)||(segment.paid!=null&&segment.paid!==observedPaid)) {
    throw new RangeError('B区永久抽数和账本不一致');
  }
  const output=segment[metric.field];
  const tokens=metric.hasToken?Math.floor(end/TOKEN_STEP)-Math.floor(start/TOKEN_STEP):0;
  if(!integer(output,tokens,end-start+tokens))throw new RangeError('B区已确认产出数量不合法');
  if(metric.hasToken&&segment.completeEnd!=null&&!integer(segment.completeEnd,start,end)) {
    throw new RangeError('B区最后一个已结算UP或信物的位置不合法');
  }
  const observedFree=total-paidPrefix[total];
  if(!integer(observedFree,0,20)||(freeAllowance!=null&&
     !integer(freeAllowance,observedFree,20))) {
    throw new RangeError('B区免费抽前缀和额度不一致');
  }
  const futureFree=freeAllowance==null?0:Math.max(0,freeAllowance-observedFree);
  if(!integer(futureFree,0,20))throw new RangeError('B区剩余免费额度不合法');
  const paidBefore=paidPrefix[start];
  function cost(draws) {
    const at=start+draws;
    if(at<=total)return paidPrefix[at]-paidBefore;
    return paidPrefix[total]-paidBefore+Math.max(0,at-total-futureFree);
  }
  function horizon(maxCost) {
    // Gross draws never cost less than gross draws minus all possible free uses.
    const freeAfterStart=total-start-(paidPrefix[total]-paidBefore)+futureFree;
    let lo=0,hi=maxCost+freeAfterStart;
    while(lo<hi) {
      const mid=Math.ceil((lo+hi)/2);
      if(cost(mid)<=maxCost)lo=mid;
      else hi=mid-1;
    }
    return lo;
  }
  return {id,start,end,draws:end-start,paid:observedPaid,output,
    completeEnd:segment.completeEnd??null,window:total-start,target:segment.stopTarget,
    capacity:segment.capacity,cost,horizon};
}

function creditAt(metric,offset,draw) {
  return metric.hasToken&&(offset+draw)%TOKEN_STEP===0?1:0;
}

// First-passage PMF indexed by gross draws after the first main-pool UP.
// A natural UP and a token can contribute two copies on the same draw.
function firstPassage(metric,offset,target,maxDraws,context) {
  const bound=metric.hasToken?TOKEN_STEP*target-offset:
    metric.givenSix===1?WATER*target:maxDraws;
  const horizon=Math.min(maxDraws,bound);
  const key=[metric.field,offset,target].join('/');
  const cached=passageCache.get(key);
  if(cached&&cached.length>horizon)return cached.subarray(0,horizon+1);
  const width=target*WATER;
  charge(context,width*horizon);
  let live=new Float64Array(width),next=new Float64Array(width);
  live[0]=1;
  const exits=new Float64Array(horizon+1);
  for(let draw=1;draw<=horizon;draw++) {
    next.fill(0);
    const token=creditAt(metric,offset,draw);
    let exitMass=0;
    for(let completed=0;completed<target;completed++) {
      const from=completed*WATER;
      const unchanged=completed+token;
      const additional=unchanged+1;
      for(let pity=0;pity<WATER;pity++) {
        const mass=live[from+pity];
        if(!mass)continue;
        const hit=mass*P[pity+1];
        const hitOutput=hit*metric.givenSix;
        if(unchanged===target) {
          // This token reaches the target regardless of the draw's identity.
          exitMass+=mass;
          continue;
        }
        const to=unchanged*WATER;
        if(pity<79)next[to+pity+1]+=mass-hit;
        next[to]+=hit-hitOutput;
        if(additional>=target)exitMass+=hitOutput;
        else next[additional*WATER]+=hitOutput;
      }
    }
    exits[draw]=exitMass;
    [live,next]=[next,live];
  }
  const exited=exits.reduce((sum,mass)=>sum+mass,0);
  const pending=live.reduce((sum,mass)=>sum+mass,0);
  if(Math.abs(exited+pending-1)>MASS_TOLERANCE||
     ((metric.hasToken||metric.givenSix===1)&&horizon===bound&&pending>MASS_TOLERANCE)) {
    throw new Error('B区达标等待概率质量不守恒');
  }
  if(horizon<=CACHE_DRAWS) {
    if(passageCache.size>=CACHE_ENTRIES)passageCache.clear();
    passageCache.set(key,exits);
  }
  return exits;
}

function convolvePrefix(left,right,cap,context) {
  const next=new Float64Array(Math.min(cap+1,left.length+right.length-1));
  charge(context,left.length*right.length);
  for(let i=0;i<left.length;i++) {
    if(!left[i])continue;
    const limit=Math.min(right.length,next.length-i);
    for(let j=0;j<limit;j++)next[i+j]+=left[i]*right[j];
  }
  return next;
}

function rankCosts(combined,actualPaid) {
  const equal=checkedProbability(combined[actualPaid]??0);
  let lower=0;
  for(let cost=0;cost<Math.min(actualPaid,combined.length);cost++)lower+=combined[cost];
  lower=checkedProbability(lower);
  const higher=checkedProbability(1-lower-equal);
  return {score:100*checkedProbability(higher+.5*equal),
    refFaster:lower,refEqual:equal,refSlower:higher};
}

function completedPart(segments,metric,actualPaid,context) {
  let combined=Float64Array.of(1),weight=0;
  const pools=[];
  for(const segment of segments) {
    const offset=metric.hasToken?segment.start%TOKEN_STEP:0;
    const gross=firstPassage(metric,offset,segment.output,segment.horizon(actualPaid),context);
    const paid=new Float64Array(segment.cost(gross.length-1)+1);
    for(let draws=1;draws<gross.length;draws++)paid[segment.cost(draws)]+=gross[draws];
    combined=convolvePrefix(combined,paid,actualPaid,context);
    weight+=segment.output;
    pools.push({id:segment.id,start:segment.start,end:segment.end,
      completeEnd:segment.completeEnd,output:segment.output,paid:segment.paid});
  }
  const {score,...rank}=rankCosts(combined,actualPaid);
  return {
    score,weight,
    details:{method:'b-same-output-permanent-cost-dp',part:'completed',actualPaid,
      output:weight,...rank,pools},
  };
}

function fixedExposure(metric,offset,draws,context) {
  charge(context,2*WATER*draws);
  let live=new Float64Array(WATER),next=new Float64Array(WATER);
  let without=new Float64Array(WATER),stillWithout=new Float64Array(WATER);
  live[0]=1;
  without[0]=1;
  let expected=0;
  for(let draw=1;draw<=draws;draw++) {
    next.fill(0);
    stillWithout.fill(0);
    const token=creditAt(metric,offset,draw);
    let gold=0;
    for(let pity=0;pity<WATER;pity++) {
      const goldRate=P[pity+1];
      const hit=live[pity]*goldRate;
      gold+=hit;
      if(pity<79)next[pity+1]+=live[pity]-hit;
      if(!token&&without[pity]) {
        const hitWithout=without[pity]*goldRate;
        if(pity<79)stillWithout[pity+1]+=without[pity]-hitWithout;
        stillWithout[0]+=hitWithout*(1-metric.givenSix);
      }
    }
    next[0]=gold;
    expected+=gold*metric.givenSix+token;
    [live,next]=[next,live];
    [without,stillWithout]=[stillWithout,without];
  }
  return {expected,noOutput:checkedProbability(without.reduce((sum,mass)=>sum+mass,0))};
}

function unfinishedPart(segments,metric,context) {
  let noOutput=1,weight=0,actualPaid=0;
  const pools=[];
  for(const segment of segments) {
    const offset=metric.hasToken?segment.start%TOKEN_STEP:0;
    const {expected,noOutput:probability}=fixedExposure(metric,offset,segment.draws,context);
    noOutput*=probability;
    weight+=expected;
    actualPaid+=segment.paid;
    pools.push({id:segment.id,start:segment.start,end:segment.end,
      draws:segment.draws,paid:segment.paid,noOutput:probability,expectedOutput:expected});
  }
  return {
    score:50*noOutput,weight,
    details:{method:'b-unfinished-no-output-survival-dp',part:'unfinished',actualPaid,noOutput,pools},
  };
}

function scoreFlatB(axis,segments) {
  if(!Object.hasOwn(METRIC,axis)||!Array.isArray(segments)) {
    throw new RangeError('B区指标或账本片段无效');
  }
  const metric=METRIC[axis];
  const rows=segments.map(segment=>normalize(segment,metric));
  if(rows.reduce((sum,row)=>sum+row.draws,0)>MAX_DRAWS) {
    throw new FlatBLimit('B区记录主抽总数超过30000');
  }
  const completed=rows.filter(row=>row.output>0);
  const unfinished=rows.filter(row=>row.output===0&&row.draws>0);
  const context={work:0};
  const parts=[];
  if(completed.length) {
    const paid=completed.reduce((sum,row)=>sum+row.paid,0);
    parts.push(completedPart(completed,metric,paid,context));
  }
  if(unfinished.length)parts.push(unfinishedPart(unfinished,metric,context));
  for(const part of parts)part.details.work=context.work;
  return parts;
}

function matchedPart(axis,segments,context) {
  const {stoppedBKernel}=require('./flat_b_stop');
  const actualPaid=segments.reduce((sum,segment)=>sum+segment.paid,0);
  let combined=Float64Array.of(1),weight=0,output=0;
  const pools=[];
  for(const segment of segments) {
    const {id,start,target,window,end,paid,completeEnd}=segment;
    const kernel=stoppedBKernel(axis,{start,target,window,output:segment.output,capacity:segment.capacity});
    if(!kernel.conditionedMass)throw new FlatBLimit(`${id} 的同停手参照没有该轴的同产出路径`);
    const gross=kernel.probabilities;
    const costs=new Float64Array(Math.min(actualPaid,segment.cost(gross.length-1))+1);
    for(let draws=0;draws<gross.length;draws++) {
      const cost=segment.cost(draws);
      if(cost<costs.length)costs[cost]+=gross[draws];
    }
    combined=convolvePrefix(combined,costs,actualPaid,context);
    weight+=kernel.expectedOutput;
    output+=segment.output;
    pools.push({id,start,end,completeEnd,paid,target,window,output:segment.output,
      conditionedMass:kernel.conditionedMass,expectedOutput:kernel.expectedOutput});
  }
  const {score,...rank}=rankCosts(combined,actualPaid);
  return {score,weight,details:{method:'b-matched-stop-same-output-permanent-cost-dp',
    part:'matched',actualPaid,output,...rank,pools}};
}

function scoreFlatBMatched(axis,segments) {
  if(!Object.hasOwn(METRIC,axis)||!Array.isArray(segments)) {
    throw new RangeError('B区指标或账本片段无效');
  }
  const metric=METRIC[axis];
  const rows=segments.map(segment=>normalize(segment,metric)).filter(row=>row.draws>0);
  if(rows.some(row=>!integer(row.target,0,2*row.window)||(axis==='up'&&row.target!==row.output))) {
    throw new RangeError('B区停手目标与已结算份数不一致');
  }
  if(rows.reduce((sum,row)=>sum+row.window,0)>MAX_DRAWS) {
    throw new FlatBLimit('B区记录主抽总数超过30000');
  }
  const matched=rows.filter(row=>axis!=='up'||row.target>0);
  const unfinished=rows.filter(row=>axis==='up'&&row.target===0);
  const context={work:0};
  const parts=[];
  if(matched.length)parts.push(matchedPart(axis,matched,context));
  if(unfinished.length)parts.push(unfinishedPart(unfinished,metric,context));
  for(const part of parts)part.details.work=context.work;
  return parts;
}

module.exports={scoreFlatB,scoreFlatBMatched,FlatBLimit};
