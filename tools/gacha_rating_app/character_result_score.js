'use strict';

// Exact DP references at the recorded draw budgets / ending banners.
// These model scores are not a strategy-independent population ranking.
const math = require('./character_result_math');
const upDP = require('./character_up_dp');
const sixCount = require('./character_six_count');
const limitedCount = require('./character_limited_count');
const AXES = ['characterSix','up','limited'];
const LIMITS = Object.freeze({mainDraws:30000, sixEvents:1000});
const nameOf = x => x === '俊卫' ? '骏卫' : x;
const knownPity = x => Number.isSafeInteger(x) && x>=0 && x<80;
const failed = (reason, details={}) => ({score:null,status:'unscored',reason,details});

function extract(record, catalog, {makeLimited=true}={}) {
  const {LIMITED,COMMON} = catalog;
  const six=[], completedUp=[], failedUp=[], tails=[], excluded=[], uncertainCaps=[], byEvent=new Map();
  let pity=knownPity(record.initialPity)?record.initialPity:null;
  let cycle=null, previous=-1, unknownDraws=0;
  const newCycle=(p,deadline)=>({initialPity:p,actual:0,schedule:[{at:0,deadline}]});
  const finishTail=(reason,pool)=>{
    if(cycle?.actual)tails.push({pool,reason,draws:cycle.actual,initialPity:cycle.initialPity,endPity:pity});
    cycle=null;
  };
  for(const pool of record.pools) {
    const id=pool.id??pool.index, index=pool.index;
    if(pool.interruptionBefore===true || record.completeHistory!==true && previous>=0 && index>previous+1) {
      finishTail(pool.interruptionBefore===true?'history-interruption':'history-gap',id);pity=null;unknownDraws=0;
    }
    previous=index;
    if(pity==null && knownPity(pool.initialPity)) {pity=pool.initialPity;unknownDraws=0;}
    if(pity!=null) {
      if(!cycle)cycle=newCycle(pity,120);
      else {
        const step={at:cycle.actual,deadline:cycle.actual+120};
        // Consecutive empty banners / a hit on the previous last draw replace
        // the deadline before any further draw; they are not duplicate draws.
        if(cycle.schedule.at(-1).at===step.at)cycle.schedule[cycle.schedule.length-1]=step;
        else cycle.schedule.push(step);
      }
    }
    let last=0, firstUpPending=true, upStart=0, upStartPity=pity;
    for(const event of pool.events) {
      const delta=event.at-last, name=nameOf(event.character), isUp=name===LIMITED[index];
      if(cycle) {
        cycle.actual+=delta;
        const entries=math.sixWait(cycle.initialPity,cycle.schedule);
        if(cycle.schedule.some(s=>s.uncertain)) {
          const alternate=math.sixWait(cycle.initialPity,cycle.schedule.map(s=>s.uncertain?{...s,deadline:null}:s));
          if(entries.length!==alternate.length || entries.some((e,i)=>Math.abs(e.p-alternate[i].p)>1e-12))
            uncertainCaps.push({pool:id,at:event.at,reason:'earlier-unknown-identity-may-have-resolved120'});
        }
        const item={...cycle,schedule:cycle.schedule.map(x=>({...x})),pool:id,at:event.at,
          forced:event.forced,entries};
        six.push(item);byEvent.set(`${id}:${event.at}`,item);
      } else {
        unknownDraws+=delta;
        excluded.push({pool:id,at:event.at,draws:unknownDraws,reason:'unknown-opening-pity'});
        unknownDraws=0;
      }
      if(isUp) {
        if(upStartPity!=null)completedUp.push({pool:id,from:upStart,at:event.at,
          actual:event.at-upStart,initialPity:upStartPity,
          remaining120:firstUpPending!==false?120-upStart:null});
        upStart=event.at;upStartPity=0;firstUpPending=false;
      } else if(upStartPity==null) {
        // The unobserved opening is not fabricated. A known six resets pity,
        // allowing the remaining first-UP opportunity to be scored from here.
        upStart=event.at;upStartPity=0;
      }
      const off=(index===0?[1,2]:index===1?[0,2]:[index-1,index-2]).map(i=>LIMITED[i]);
      if(firstUpPending!==false && !COMMON.includes(name) && name!==LIMITED[index] && !off.includes(name))firstUpPending=null;
      pity=0;
      cycle=newCycle(0,firstUpPending!==false?120-event.at:null);
      if(firstUpPending===null)cycle.schedule[0].uncertain=true;
      last=event.at;
    }
    const rest=pool.total-last;
    if(pity!=null) {pity+=rest;cycle.actual+=rest;}
    else {
      unknownDraws+=rest;
      if(knownPity(pool.tail)) {pity=pool.tail;cycle=null;unknownDraws=0;}
    }
    if(pool.total>upStart && upStartPity!=null)failedUp.push({pool:id,from:upStart,
      actual:pool.total-upStart,initialPity:upStartPity,endPity:pity,
      remaining120:firstUpPending!==false?120-upStart:null});
  }
  finishTail('unfinished-final-six-cycle',record.pools.at(-1)?.id);
  if(unknownDraws)excluded.push({draws:unknownDraws,reason:'unknown-unfinished-opening'});

  let ownedKnown=Array.isArray(record.initialOwned), ownershipIndex=-1;
  const owned=new Set((ownedKnown?record.initialOwned:[]).map(nameOf));
  const limitedParts=[], limitedRows=[];
  let limitedObserved=0,rushDraws=0,rushSix=0,rushUp=0,rushWeight=0;
  let mainWeight=0, actualMainUp=0;
  for(const pool of record.pools) {
    const id=pool.id??pool.index,index=pool.index,up=LIMITED[index];
    // A known opening collection cannot resolve New after unobserved banners.
    // Match the ledger/planning boundary instead of rewarding assumed New.
    if(pool.interruptionBefore===true || record.completeHistory!==true&&ownershipIndex>=0&&index>ownershipIndex+1)ownedKnown=false;
    ownershipIndex=index;
    const off=(index===0?[1,2]:index===1?[0,2]:[index-1,index-2]).map(i=>LIMITED[i]);
    const missing=()=>ownedKnown?off.filter(n=>!owned.has(n)).length:0;
    const weight=name=>Number(LIMITED.includes(name))+Number(ownedKnown&&off.includes(name)&&!owned.has(name));
    const events=pool.events.map(e=>({...e,type:'main'}));
    if(pool.rushUsed)events.push({type:'rush',at:pool.rushAt??30});
    events.sort((a,b)=>a.at-b.at||(a.type==='main'?-1:1));
    for(const event of events) {
      if(event.type==='main') {
        const name=nameOf(event.character), w=weight(name), m=missing();
        const complete=byEvent.get(`${id}:${event.at}`);
        // Partial imports retain known identity evidence without pretending
        // that the missing waiting time was a zero-draw six-star acquisition.
        const entries=complete?.entries||[{wait:0,p:1,forced:!!event.forced}];
        if(makeLimited)limitedParts.push({kind:'main',entries,missing:m});
        limitedObserved+=(complete?.actual||0)-math.CL*w;
        mainWeight+=w;actualMainUp+=Number(name===up);
        limitedRows.push({pool:id,at:event.at,weight:w,missing:m,forced:!!event.forced,
          timing:complete?'complete-cycle':'identity-only-unknown-opening'});
        owned.add(name);
      } else {
        const m=missing();let w=0;
        if(makeLimited)limitedParts.push({kind:'rush',draws:10,missing:m});
        for(const result of pool.rush) {
          const name=nameOf(result.character);w+=weight(name);
          rushUp+=Number(name===up);owned.add(name);
        }
        rushDraws+=10;rushSix+=pool.rush.length;rushWeight+=w;
        limitedObserved-=math.CL*w;
        limitedRows.push({pool:id,at:event.at,kind:'rush',weight:w,missing:m});
      }
    }
  }
  return {six,completedUp,failedUp,tails,excluded,uncertainCaps,limitedParts,limitedRows,limitedObserved,
    rushDraws,rushSix,rushUp,rushWeight,mainWeight,actualMainUp};
}

function distributionScore(parts,observed,details) {
  if(!parts.length)return failed('没有已完成周期或已使用加急可评分',details);
  const distribution=math.convolveMany(parts,{highCap:observed});
  const score=100*math.midTail(distribution,observed);
  let mass=0,mean=0,second=0;
  for(let i=0;i<distribution.p.length;i++) {
    const p=distribution.p[i],x=distribution.lo+i;mass+=p;mean+=x*p;second+=x*x*p;
  }
  if(!Number.isFinite(score))throw new Error('合成分位数无效');
  return {score:Math.max(0,Math.min(100,score)),status:'scored',details:{...details,
    observedEquivalentDraws:observed,referenceMass:mass,
    referenceMean:mass>1-1e-9?mean:null,referenceVariance:mass>1-1e-9?Math.max(0,second-mean*mean):null,
    support:[distribution.lo,distribution.lo+distribution.p.length-1]}};
}

// A count law spans the whole known continuous interval. Splitting at observed
// six-star hits would condition the reference on the player's actual timing.
function countSegments(record) {
  const segments=[];
  let current=knownPity(record.initialPity)?{initialPity:record.initialPity,mainDraws:0,mainSix:0}:null;
  let previous=-1,excludedMainDraws=0;
  const flush=()=>{if(current?.mainDraws)segments.push(current);current=null;};
  for(const pool of record.pools) {
    if(pool.interruptionBefore===true || record.completeHistory!==true&&previous>=0&&pool.index>previous+1)flush();
    previous=pool.index;
    if(!current&&knownPity(pool.initialPity))current={initialPity:pool.initialPity,mainDraws:0,mainSix:0};
    let last=0;
    for(const event of pool.events) {
      if(current){current.mainDraws+=event.at-last;current.mainSix++;}
      else {excludedMainDraws+=event.at-last;current={initialPity:0,mainDraws:0,mainSix:0};}
      last=event.at;
    }
    if(current)current.mainDraws+=pool.total-last;
    else {
      excludedMainDraws+=pool.total-last;
      if(knownPity(pool.tail))current={initialPity:pool.tail,mainDraws:0,mainSix:0};
    }
  }
  flush();
  return {segments,excludedMainDraws};
}

function scoreResults(record,validated,catalog) {
  if(!record || !Array.isArray(record.pools) || !validated.counts)return validated;
  const result={...validated,axes:{...validated.axes},warnings:[...(validated.warnings||[])]};
  // Legacy gates remain authoritative for input conflicts, not for the absence
  // of old martingale variance: a deterministic hard cap legitimately scores50.
  const gate=axis=>{
    const old=validated.axes[axis];
    if(old?.status!=='unscored')return null;
    return old.reason==='没有有效评分方差'?null:old;
  };
  if(AXES.every(k=>gate(k)))return result;
  if(validated.counts.main>LIMITS.mainDraws || validated.counts.six>LIMITS.sixEvents) {
    for(const axis of AXES)if(!gate(axis))result.axes[axis]=failed('记录超过本地合成分布的安全计算上限',LIMITS);
    return result;
  }
  // In malformed ledgers a blocked identity axis can coexist with valid timing.
  // Build each axis separately so unknown identity cannot manufacture a score.
  const limitedCompatibility=record.pools.some(pool=>pool.interruptionBefore===true)||!knownPity(record.initialPity)||(record.completeHistory!==true&&
    record.pools.some((pool,i)=>i>0&&pool.index>record.pools[i-1].index+1));
  let data;
  try {data=extract(record,catalog,{makeLimited:limitedCompatibility&&!gate('limited')});}
  catch(error) {
    for(const axis of AXES)if(!gate(axis))result.axes[axis]=failed(`角色分布构建失败：${error.message}`);
    return result;
  }
  const common={reference:'fixed-observed-record-model-not-universal-player-percentile',
    rush:{draws:data.rushDraws,six:data.rushSix,up:data.rushUp,limitedWeight:data.rushWeight},
    unfinishedSixCycles:data.tails,excludedOpeningSegments:data.excluded};
  const run=(axis,fn)=>{
    if(gate(axis)){result.axes[axis]=gate(axis);return;}
    try {result.axes[axis]=fn();}
    catch(error){result.axes[axis]=failed(`角色分布计算失败：${error.message}`,common);}
  };
  run('characterSix',()=>{
    const spans=countSegments(record);
    const value=sixCount.scoreSegments(spans.segments,{rushDraws:data.rushDraws,rushSix:data.rushSix});
    const details={...common,method:'ordinary80-total-six-count-dp-with-rush-convolution',
      ...value,rushScore:value.rush,rush:common.rush,knownSegments:spans.segments,excludedMainDraws:spans.excludedMainDraws,
      completeMainSix:spans.segments.reduce((n,s)=>n+s.mainSix,0),
      forcedIncluded:data.six.filter(s=>s.forced).length,tailPolicy:'included-in-draw-budget',
      rule:'actual forced120 six included; reference uses ordinary80 only; tokens excluded'};
    return value.joint===null?failed('没有已知水位的主池区间或已使用加急可评分',details)
      :{score:value.joint,status:'scored',details};
  });
  run('up',()=>{
    const value=upDP.evaluate(record);
    const details={...common,...value,method:'merged-wait-exact-dp-draw-weighted-up',
      reference:value.mainDraws?'fixed-observed-ending-banner-wait-dp':'rush-only-aggregate-binomial',
      referencePoolCount:record.pools.filter(p=>p.total>0||p.rushUsed).length,
      unsuccessful:value.tails??(value.tailDraws?[value.tail]:[]),
      actualMainUp:data.actualMainUp,completeMainUp:value.completed.length,
      rule:'completed convolution; final wait 50*survival; rush binomial .004; full known draw weights; no tokens'};
    return value.score===null?failed('没有可确认的UP等待段或已使用加急',details)
      :{score:value.score,status:'scored',details};
  });
  run('limited',()=>{
    const details={...common,mainLimitedWeight:data.mainWeight,identities:data.limitedRows,
      identityRule:'common=0; limited=1; off-banner NEW limited=2; tokens excluded'};
    if(limitedCompatibility) {
      // Preserve useful identity evidence where the new count reference has no
      // known opening state. Never fabricate pity zero or ownership across gaps.
      return distributionScore(data.limitedParts.map(s=>s.kind==='rush'
        ?math.rushLimitedCost(s.draws,s.missing):math.limitedCost(s.entries,s.missing)),data.limitedObserved,
        {...details,method:'partial-history-limited-compatibility-dp',partialHistoryCompatibility:true,
          compatibilityReason:'unknown opening pity, interrupted history or missing intermediate banners',
          tailPolicy:'legacy completed cycles plus known identity evidence'});
    }
    const value=limitedCount.scoreRecord(record,{includeNew:Array.isArray(record.initialOwned)});
    // Runtime duration is diagnostic, not part of a saved/repeatable score.
    const {milliseconds,...reference}=value.reference;
    return value.score===null?failed('没有可评分的限定抽卡样本',details):{score:value.score,status:'scored',
      details:{...details,method:'ordinary80-limited-value-ownership-dp',
        reference,actual:value.actual,limitedCount:value.L,offNew:value.B,includeNew:value.includeNew,
        tailPolicy:'included-in-draw-budget',schedule:value.schedule}};
  });
  result.coverage={...validated.coverage,unfinishedSixDraws:data.tails.reduce((n,s)=>n+s.draws,0),
    sixTailPolicy:'included-in-total-draw-budget-without-inventing-a-six',
    limitedPartialHistoryCompatibility:!!result.axes.limited.details?.partialHistoryCompatibility};
  result.effectiveCounts={mainSix:data.six.length,forcedSixIncluded:data.six.filter(s=>s.forced).length,
    mainUp:data.actualMainUp,rushSix:data.rushSix,rushUp:data.rushUp,
    mainLimitedWeight:data.mainWeight,rushLimitedWeight:data.rushWeight};
  result.segments=[...data.six.map(({entries,...s})=>({...s,kind:'complete-six-cycle'})),
    ...data.tails.map(s=>({...s,kind:'unfinished-six-cycle'}))];
  result.warnings=result.warnings.filter(w=>!w.startsWith('期初水位未知：六星等待评分跳过'));
  result.warnings.push('六星/限定使用普通80保底的总产出DP参照；实际120收益计入产出，信物不计随机出货');
  result.warnings.push('UP合并跨池等待，以实际结束池确定保底位置；已出、未出和加急按全部可确认抽数加权，不使用离线样本分位');
  result.warnings.push('各轴是指定参照下的模型评分，不保证不同停手策略均分相同，也不是所有真实玩家的排名');
  if(validated.coverage.excludedMainDraws)result.warnings.push(`期初水位未知：${validated.coverage.excludedMainDraws}抽开头不计六星/UP等待参照；不补造水位或抽数`);
  if(result.coverage.limitedPartialHistoryCompatibility)result.warnings.push('限定轴因期初水位未知、中间缺池或中断修正，采用部分记录兼容DP；保留已知身份证据，不猜前史，其尾段仍按兼容口径处理');
  result.warnings=[...new Set(result.warnings)];
  return result;
}

module.exports={scoreResults,extract,countSegments,LIMITS};
