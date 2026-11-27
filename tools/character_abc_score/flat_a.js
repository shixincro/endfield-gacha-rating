'use strict';

// The flat A path stops at the first *main* UP. Its stop is also the point
// that decides whether it supplies the next normally adjacent pool's voucher.
const MAX_WORK = 220_000_000;
const MAX_STATES = 300_000;
const PROBABILITY_TOLERANCE = 2e-11;
const FREE_ALLOWANCES = [0,10,20];
const LIMITED_LAW_CACHE_MAX = 128;
const limitedLawCache = new Map();

class FlatALimit extends Error {}

function ordinaryRate(pity) {
  return pity===79?1:pity<65?.008:.008+.05*(pity-64);
}

function assert(condition,message) {
  if(!condition)throw new RangeError(message);
}

function finishLaw(stopped,pending) {
  const survival=pending.reduce((sum,mass)=>sum+mass,0);
  let stoppedMass=0, expected=0;
  for(const {count,mass} of stopped) {
    stoppedMass+=mass;
    expected+=count*mass;
  }
  for(let count=0;count<pending.length;count++)expected+=count*pending[count];
  if(Math.abs(stoppedMass+survival-1)>PROBABILITY_TOLERANCE) {
    throw new Error('A 区首 UP 分布概率质量不守恒');
  }
  return {stopped,pending,survival,expected};
}

function firstUpLaw(axis,openingPity,horizon) {
  const width=80*(horizon+1);
  let live=new Float64Array(width), next=new Float64Array(width);
  live[openingPity]=1;
  const stopped=[];
  // The two ordinary off-banner limited identities contribute 2/14. On UP
  // only completion counts; earlier non-UP gold still resets main pity.
  const offCount=axis==='characterSix'?1/2:axis==='limited'?2/14:0;
  for(let at=1;at<=horizon;at++) {
    const completions=new Float64Array(at+1);
    next.fill(0);
    for(let count=0;count<at;count++) {
      for(let pity=0;pity<80;pity++) {
        const mass=live[80*count+pity];
        if(!mass)continue;
        if(at===120) {
          completions[count+1]+=mass;
          continue;
        }
        const gold=mass*ordinaryRate(pity);
        const miss=mass-gold;
        if(miss>0)next[80*count+pity+1]+=miss;
        completions[count+1]+=gold/2;
        next[80*(count+1)]+=gold*offCount;
        next[80*count]+=gold*(.5-offCount);
      }
    }
    for(let count=1;count<completions.length;count++) {
      if(completions[count]>0)stopped.push({at,count,mass:completions[count]});
    }
    [live,next]=[next,live];
  }
  const pending=new Float64Array(horizon+1);
  for(let count=0;count<pending.length;count++) {
    for(let pity=0;pity<80;pity++)pending[count]+=live[80*count+pity];
  }
  return finishLaw(stopped,pending);
}

function normalizeCapacity(raw,horizon) {
  const {remaining,grantAt=null,grants=[0,0]}=raw;
  const tuple=(values,max)=>Array.isArray(values)&&values.length===2&&
    values.every(value=>Number.isInteger(value)&&value>=0&&value<=max);
  assert(tuple(remaining,6)&&tuple(grants,10)&&grants[0]+grants[1]<=10&&
    (grantAt===null?grants[0]+grants[1]===0:Number.isInteger(grantAt)&&grantAt>=0&&grantAt<=120),
    'A 区限定参照的剩余潜能容量无效');
  const [left,right]=remaining;
  const grantLeft=Math.min(left,grants[0]),grantRight=Math.min(right,grants[1]);
  if(grantAt===0)return {left:left-grantLeft,right:right-grantRight,at:null,grantLeft:0,grantRight:0};
  // A grant after the final scored draw cannot change any current A output.
  if(grantAt===null||grantAt>=horizon||grantLeft+grantRight===0) {
    return {left,right,at:null,grantLeft:0,grantRight:0};
  }
  return {left,right,at:grantAt,grantLeft,grantRight};
}

function countLimitedA(openingPity,horizon,capacity) {
  const {left,right,at:grantAt,grantLeft,grantRight}=capacity;
  const budget=left+right;
  if(!budget)return firstUpLaw('up',openingPity,horizon);

  // Effective off-banner outputs are the decrease in capacity minus copies
  // consumed by the fixed rush event. Keep that amount as a separate state.
  const grantMax=grantLeft+grantRight;
  const leftStride=80*(right+1),usedStride=leftStride*(left+1);
  const width=usedStride*(grantMax+1);
  if(width>MAX_STATES||width*horizon>MAX_WORK)throw new FlatALimit('A 区限定参照计算量超限');
  const index=(l,r,used)=>used*usedStride+l*leftStride+r*80;
  function afterGrant(l,r,used) {
    const fillLeft=Math.min(l,grantLeft),fillRight=Math.min(r,grantRight);
    return index(l-fillLeft,r-fillRight,used+fillLeft+fillRight);
  }

  let live=new Float64Array(width),next=new Float64Array(width);
  live[index(left,right,0)+openingPity]=1;
  const stopped=[];
  const countWidth=Math.min(horizon,budget+1)+1;
  for(let at=1;at<=horizon;at++) {
    const completions=new Float64Array(countWidth);
    const usedMax=grantAt!==null&&at>grantAt?grantMax:0;
    const nextIndex=at===grantAt?afterGrant:index;
    next.fill(0);
    for(let used=0;used<=usedMax;used++) {
      for(let l=0;l<=left;l++) {
        for(let r=0;r<=right;r++) {
          const count=budget-l-r-used;
          if(count<0||count>=at)continue;
          const current=index(l,r,used);
          const reset=nextIndex(l,r,used);
          const offLeft=l?nextIndex(l-1,r,used):reset;
          const offRight=r?nextIndex(l,r-1,used):reset;
          for(let pity=0;pity<80;pity++) {
            const mass=live[current+pity];
            if(!mass)continue;
            if(at===120) {
              completions[count+1]+=mass;
              continue;
            }
            const gold=mass*ordinaryRate(pity);
            const miss=mass-gold;
            if(miss>0)next[reset+pity+1]+=miss;
            completions[count+1]+=gold/2;
            next[reset]+=gold*5/14;
            next[offLeft]+=gold/14;
            next[offRight]+=gold/14;
          }
        }
      }
    }
    for(let count=1;count<countWidth;count++) {
      if(completions[count]>0)stopped.push({at,count,mass:completions[count]});
    }
    [live,next]=[next,live];
  }
  const pending=new Float64Array(countWidth);
  const usedMax=grantAt===null?0:grantMax;
  for(let used=0;used<=usedMax;used++) {
    for(let l=0;l<=left;l++) {
      for(let r=0;r<=right;r++) {
        const count=budget-l-r-used;
        if(count<0||count>=countWidth)continue;
        const current=index(l,r,used);
        for(let pity=0;pity<80;pity++)pending[count]+=live[current+pity];
      }
    }
  }
  return finishLaw(stopped,pending);
}

function limitedLaw(openingPity,horizon,raw) {
  const capacity=normalizeCapacity(raw,horizon);
  const {left,right,at,grantLeft,grantRight}=capacity;
  const key=[openingPity,horizon,left,right,at??'-',grantLeft,grantRight].join('/');
  if(!limitedLawCache.has(key)) {
    if(limitedLawCache.size>=LIMITED_LAW_CACHE_MAX)limitedLawCache.delete(limitedLawCache.keys().next().value);
    limitedLawCache.set(key,countLimitedA(openingPity,horizon,capacity));
  }
  return limitedLawCache.get(key);
}

function observedOutput(axis,groups) {
  return groups.reduce((sum,{segment})=>sum+(axis==='up'?Number(segment.complete):
    axis==='characterSix'?segment.six:segment.limited),0);
}

function observedPaid(groups) {
  return groups.reduce((sum,{segment})=>sum+segment.paid,0);
}

function scoreUnfinished(axis,groups,lawFor) {
  const actual=observedOutput(axis,groups);
  let weight=0,survival=1;
  let countPrefix=Float64Array.of(1);
  for(const {segment} of groups) {
    const law=lawFor(segment,segment.observedAt);
    weight+=law.expected;
    survival*=law.survival;
    if(axis==='up')continue;
    const local=law.pending.slice(0,actual+1);
    for(const {count,mass} of law.stopped) {
      if(count<=actual)local[count]+=mass;
    }
    const next=new Float64Array(Math.min(actual+1,countPrefix.length+local.length-1));
    for(let i=0;i<countPrefix.length;i++) {
      for(let j=0;j<local.length&&i+j<next.length;j++)next[i+j]+=countPrefix[i]*local[j];
    }
    countPrefix=next;
  }
  const details={pools:groups.map(({segment})=>segment.id),observedPaid:observedPaid(groups),
    observedOutput:actual,expectedOutput:weight,survival,
    cutoffs:groups.map(({segment})=>({id:segment.id,observedAt:segment.observedAt,
      openingPity:segment.referenceOpeningPity}))};
  let score;
  if(axis==='up') {
    score=50*survival;
    details.method='flat-a-unfinished-new-up-survival';
  } else {
    const below=countPrefix.subarray(0,actual).reduce((sum,mass)=>sum+mass,0);
    const equal=countPrefix[actual]??0;
    score=Math.max(0,Math.min(100,100*(below+.5*equal)));
    Object.assign(details,{method:'flat-a-unfinished-count-dp',below,equal});
  }
  return {kind:'A-unfinished',score,weight,details};
}

function add(map,key,mass) {
  map.set(key,(map.get(key)??0)+mass);
}

function costRows(law,allowance,outputCap,costCap) {
  const rows=new Map();
  const stride=2*(costCap+1);
  for(const {at,count,mass} of law.stopped) {
    if(count>outputCap)continue;
    const cost=Math.min(costCap,Math.max(0,at-allowance));
    add(rows,count*stride+2*cost+Number(at>=60),mass);
  }
  const byCount=Array.from({length:outputCap+1},()=>[]);
  const countMass=Array.from({length:outputCap+1},()=>new Float64Array(2));
  for(const [key,mass] of rows) {
    const count=Math.floor(key/stride),cost=Math.floor(key%stride/2),voucher=key%2;
    byCount[count].push({cost,voucher,mass});
    countMass[count][voucher]+=mass;
  }
  return {byCount,countMass};
}

function scoreCompleted(axis,groups,completed,lawFor) {
  // The benchmark earns the observed number of main-UP completions in flat
  // pools. Actual spend and accidental output in other A attempts still count.
  const totalOutput=observedOutput(axis,groups);
  const totalPaid=observedPaid(groups);
  const costCap=totalPaid+1;
  // Cost slot 0 is guaranteed to finish below the observed cost. The other
  // slots store actual cost plus one, capped at the strictly higher bucket.
  const stride=2*(costCap+2);
  let distribution=new Map([[2,1]]);
  let weight=0, work=0;
  let previousIndex=-2;
  const dynamicVoucherPools=[];
  const resetVoucherPools=[];
  for(let i=0;i<completed.length;i++) {
    const {index,segment}=completed[i];
    const law=lawFor(segment,120);
    weight+=law.expected;
    const dynamicVoucher=segment.inheritsVoucher&&index===previousIndex+1;
    const localCutoff=totalOutput-(completed.length-1);
    // A skipped ordinary pool cannot grant the benchmark an extra voucher.
    // A fixed external grant remains fixed even though it may be exceptional.
    const ordinaryFree=segment.inheritsVoucher?10:segment.referenceFreeAllowance;
    const ordinaryRows=costRows(law,ordinaryFree,localCutoff,costCap);
    const voucherRows=dynamicVoucher?costRows(law,20,localCutoff,costCap):ordinaryRows;
    if(dynamicVoucher)dynamicVoucherPools.push(segment.id);
    else if(segment.inheritsVoucher)resetVoucherPools.push(segment.id);
    const next=new Map();
    // Each still-unprocessed completed pool contributes at least its first UP.
    const remaining=completed.length-i-1;
    const combinedCap=totalOutput-remaining;
    const guaranteedBelow=totalPaid-120*remaining;
    for(const [key,mass] of distribution) {
      const count=Math.floor(key/stride);
      const priorCost=Math.floor(key%stride/2)-1;
      const rows=key%2?voucherRows:ordinaryRows;
      const attainedTail=priorCost===-1||priorCost===costCap;
      const maxCount=Math.min(localCutoff,combinedCap-count);
      for(let localCount=1;localCount<=maxCount;localCount++) {
        const rankBase=(count+localCount)*stride;
        if(attainedTail) {
          work+=2;
          for(let voucher=0;voucher<=1;voucher++) {
            const joint=mass*rows.countMass[localCount][voucher];
            if(joint>0)add(next,rankBase+2*(priorCost+1)+voucher,joint);
          }
        } else {
          const localRows=rows.byCount[localCount];
          work+=localRows.length;
          for(const {cost,voucher,mass:localMass} of localRows) {
            const paid=priorCost+cost;
            const nowCost=paid<guaranteedBelow?-1:Math.min(costCap,paid);
            const joint=mass*localMass;
            if(joint>0)add(next,rankBase+2*(nowCost+1)+voucher,joint);
          }
        }
        if(work>MAX_WORK)throw new FlatALimit('A 区合并分布达到计算量上限');
      }
      if(next.size>MAX_STATES)throw new FlatALimit('A 区合并分布达到状态数上限');
    }
    distribution=next;
    previousIndex=index;
  }
  let below=0,equal=0,above=0;
  for(const [key,mass] of distribution) {
    if(Math.floor(key/stride)!==totalOutput)continue;
    const cost=Math.floor(key%stride/2)-1;
    if(cost<totalPaid)below+=mass;
    else if(cost===totalPaid)equal+=mass;
    else above+=mass;
  }
  const conditionedMass=below+equal+above;
  if(!(conditionedMass>0))throw new FlatALimit('A 区参照没有相同总产出的完成路径');
  const score=Math.max(0,Math.min(100,100*(above+.5*equal)/conditionedMass));
  return {kind:'A-completed',score,weight,details:{
    method:'flat-a-completed-same-output-paid-dp',
    pools:completed.map(({segment})=>segment.id),dynamicVoucherPools,resetVoucherPools,
    includedUnfinishedPools:groups.filter(({segment})=>!segment.complete&&segment.observedAt>0)
      .map(({segment})=>segment.id),
    observedOutput:totalOutput,observedPaid:totalPaid,expectedOutput:weight,
    conditionedMass,lowerCost:below/conditionedMass,equalCost:equal/conditionedMass,
    higherCost:above/conditionedMass,work,
  }};
}

function scoreFlatA(axis,segments) {
  if(axis==='six')axis='characterSix';
  assert(['characterSix','up','limited'].includes(axis),'A 区评分轴无效');
  assert(Array.isArray(segments),'A 区缺少已整理的卡池段');
  const groups=segments.map((raw,index)=>{
    const segment={...raw,
      referenceOpeningPity:raw.referenceOpeningPity??raw.openingPity,
      referenceFreeAllowance:raw.referenceFreeAllowance??raw.freeAllowance,
    };
    const {observedAt,complete,paid,six,limited,referenceOpeningPity,referenceFreeAllowance}=segment;
    assert(Number.isInteger(observedAt)&&observedAt>=0&&observedAt<=120&&typeof complete==='boolean'&&
      (complete?observedAt>0:observedAt<120),'A 区首 UP 结算位置无效');
    assert(Number.isSafeInteger(paid)&&paid>=0&&paid<=30000&&
      Number.isInteger(six)&&six>=0&&six<=observedAt&&Number.isInteger(limited)&&limited>=0&&limited<=six&&
      (!complete||limited>0),'A 区投入或出货计数无效');
    assert(Number.isInteger(referenceOpeningPity)&&referenceOpeningPity>=0&&referenceOpeningPity<80,
      'A 区缺少有效参照期初水位');
    assert(FREE_ALLOWANCES.includes(referenceFreeAllowance),'A 区缺少有效参照免费额度');
    return {index,segment};
  });
  const cache=new Map();
  const lawFor=(segment,horizon)=>{
    if(axis==='limited'&&segment.capacity) {
      return limitedLaw(segment.referenceOpeningPity,horizon,segment.capacity);
    }
    const key=segment.referenceOpeningPity*121+horizon;
    if(!cache.has(key))cache.set(key,firstUpLaw(axis,segment.referenceOpeningPity,horizon));
    return cache.get(key);
  };
  let flatPity=0;
  const completed=[];
  for(const {index,segment} of groups) {
    if(!segment.carry)flatPity=segment.referenceOpeningPity;
    if(segment.complete) {
      completed.push({index,segment:{...segment,referenceOpeningPity:flatPity}});
      flatPity=0;
    }
  }
  const unfinished=groups.filter(({segment})=>!segment.complete&&segment.observedAt>0);
  if(completed.length)return [scoreCompleted(axis,groups,completed,lawFor)];
  if(unfinished.length)return [scoreUnfinished(axis,unfinished,lawFor)];
  return [];
}

module.exports={FlatALimit,scoreFlatA};
