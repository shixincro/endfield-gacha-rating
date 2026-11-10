'use strict';
// Exact UP waiting-time DP and whole-record draw-weighted components.
// The observed ending banner determines the reference deadline. Future choices
// are deliberately not modeled. The final score is a draw-weighted index.
function check(ok,message='抽卡记录参数不合法') {if(!ok)throw new Error(message);}
function equal(a,b,message='抽卡记录参数不一致') {check(a===b,message);}
const math=require('./character_result_math');
const catalog=require('./character_ledger');
const cache=new Map();
const hazard=p=>p===79?1:p<65?.008:.008+.05*(p-64);
const sum=xs=>Array.from(xs).reduce((a,b)=>a+b,0);
const nameOf=x=>x==='俊卫'?'骏卫':x;

function waitLaw(initialPity,deadline,limit) {
  check(Number.isInteger(initialPity)&&initialPity>=0&&initialPity<80);
  check(deadline===null||(Number.isInteger(deadline)&&deadline>=1));
  check(Number.isInteger(limit)&&limit>=1&&limit<=30000);
  const end=deadline===null?limit:Math.min(deadline,limit);
  const key=`${initialPity}/${deadline}/${end}`;
  if(cache.has(key))return cache.get(key);
  let state=new Float64Array(80);state[initialPity]=1;
  const out=new Float64Array(end);
  for(let t=1;t<=end;t++) {
    if(t===deadline) {out[t-1]=sum(state);break;}
    const next=new Float64Array(80);
    for(let p=0;p<80;p++)if(state[p]) {
      const hit=state[p]*hazard(p);
      out[t-1]+=.5*hit;next[0]+=.5*hit;
      if(p<79)next[p+1]+=state[p]-hit;
    }
    state=next;
  }
  const law=math.distribution(1,out);
  if(cache.size>=256)cache.clear();cache.set(key,law);return law;
}

function split(record) {
  check(record&&Array.isArray(record.pools),'缺少卡池记录');
  const knownPity=x=>Number.isSafeInteger(x)&&x>=0&&x<80;
  check(record.initialPity==null||knownPity(record.initialPity),'期初水位不合法');
  const makeCycle=p=>({initialPity:p,actual:0,deadline:null,schedule:[],segments:[]});
  let actualPity=knownPity(record.initialPity)?record.initialPity:null;
  let current=actualPity===null?null:makeCycle(actualPity),unknownStreak=0;
  let recordMainDraws=0,excludedMainDraws=0,rushDraws=0,rushUp=0,tokenCount=0,previousIndex=-1;
  const completed=[],tails=[],excludedSegments=[],warnings=[],seenIds=new Set();
  for(const pool of record.pools) {
    check(Number.isInteger(pool.index)&&pool.index>previousIndex,'卡池顺序不合法');
    const gap=pool.interruptionBefore===true||record.completeHistory!==true&&previousIndex>=0&&pool.index>previousIndex+1;
    if(gap) {
      if(current?.actual)tails.push({...current,reason:pool.interruptionBefore===true?'history-interruption':'history-gap'});
      current=null;actualPity=null;unknownStreak=0;
    }
    previousIndex=pool.index;
    check(Number.isSafeInteger(pool.total)&&pool.total>=0,'主池抽数不合法');
    const up=catalog.LIMITED[pool.index];check(up,'未知卡池');
    const i=pool.index,off=(i===0?[1,2]:i===1?[0,2]:[i-1,i-2]).map(j=>catalog.LIMITED[j]);
    const legalNames=new Set([up,...off,...catalog.COMMON]);
    check(Array.isArray(pool.events)&&Array.isArray(pool.rush??[]),'出货明细格式不合法');
    const id=pool.id??pool.index;check(!seenIds.has(id),'卡池来源重复');seenIds.add(id);
    if(pool.initialPity!=null) {
      check(knownPity(pool.initialPity),'卡池期初水位不合法');
      if(actualPity!==null)equal(pool.initialPity,actualPity,'卡池期初水位与前池结尾不一致');
      else {actualPity=pool.initialPity;current=makeCycle(actualPity);unknownStreak=0;}
    }
    if(pool.interruptionBefore===true)equal(pool.initialPity,0,'中断修正后的期初水位必须为0');
    if(current&&pool.total>0) {
      const deadline=current.actual+120,entry={at:current.actual,deadline,pool:id};
      if(current.schedule.at(-1)?.at===entry.at)current.schedule[current.schedule.length-1]=entry;
      else current.schedule.push(entry);
      current.deadline=deadline;
    }
    let last=0,seenUp=false;
    const add=(from,to)=>{
      if(current) {
        if(to>from)current.segments.push({pool:id,from,to,draws:to-from});
        current.actual+=to-from;
      } else if(to>from) {
        excludedMainDraws+=to-from;unknownStreak+=to-from;
        excludedSegments.push({pool:id,from,to,draws:to-from,reason:'unknown-opening-pity'});
      }
    };
    for(const event of pool.events) {
      check(Number.isSafeInteger(event.at)&&event.at>last&&event.at<=pool.total,'主池出货位置不合法');
      const name=nameOf(event.character);check(legalNames.has(name),'角色身份未知或不属于此卡池');
      if(actualPity!==null)check(actualPity+event.at-last<=80,'六星出货间隔超过80抽，请检查缺失记录');
      if(!seenUp)check(event.at<=120,'首次UP超过120抽，请检查出货记录');
      if(!seenUp&&event.at===120)equal(name,up,'第120抽首次保底必须为当期UP');
      add(last,event.at);
      if(!current) {
        check(unknownStreak<=80,'未知期初的首段仍超过80抽，请检查缺失记录');
        // The first observed gold establishes pity zero, but cannot close a
        // waiting time whose opening pity was unknown. Preserve its UP state.
        seenUp=name===up;
        current=makeCycle(0);current.deadline=seenUp?null:120-event.at;
        current.schedule=[{at:0,deadline:current.deadline,pool:id}];
        unknownStreak=0;
      } else if(name===up) {
        completed.push({...current,endPool:id,endAt:event.at});
        current=makeCycle(0);current.schedule=[{at:0,deadline:null,pool:id}];seenUp=true;
      }
      actualPity=0;last=event.at;
    }
    add(last,pool.total);
    if(actualPity!==null) {
      actualPity+=pool.total-last;
      check(actualPity<80,'末尾水位达到80抽但缺少六星记录');
      if(pool.tail!=null)equal(pool.tail,actualPity,'卡池末水位与出货记录不一致');
    } else {
      check(unknownStreak<80,'未知期初的未出段达到80抽，请检查缺失记录');
      if(pool.tail!=null) {
        check(knownPity(pool.tail)&&pool.tail>=unknownStreak,'末水位与未知期初的已观测抽数不相容');
        actualPity=pool.tail;current=makeCycle(actualPity);unknownStreak=0;
      }
    }
    if(!seenUp)check(pool.total<120,'满120抽但缺少首次UP记录');
    recordMainDraws+=pool.total;check(recordMainDraws<=30000,'主池总抽数超过安全计算范围');
    if(pool.rushUsed) {
      rushDraws+=10;check(pool.rush.length<=10,'加急六星数量超过10');
      for(const event of pool.rush) {
        check(legalNames.has(nameOf(event.character)),'加急角色身份未知或不属于此卡池');
        rushUp+=Number(nameOf(event.character)===up);
      }
    } else equal((pool.rush??[]).length,0,'未使用加急却包含加急出货');
    if(Array.isArray(pool.tokens))tokenCount+=pool.tokens.length;
    else if(pool.tokens!=null)warnings.push(`${pool.banner??id}信物列表格式异常；信物不参与UP随机评分`);
  }
  const tail=current??makeCycle(null);
  if(tail.actual)tails.push({...tail,reason:'unfinished-final-up-wait'});
  const completedDraws=completed.reduce((n,c)=>n+c.actual,0),tailDraws=tails.reduce((n,c)=>n+c.actual,0);
  const mainDraws=completedDraws+tailDraws;
  equal(mainDraws+excludedMainDraws,recordMainDraws,'已知与排除抽数未覆盖原记录');
  return {completed,tail,tails,mainDraws,recordMainDraws,completedDraws,tailDraws,rushDraws,rushUp,tokenCount,
    excludedMainDraws,excludedSegments,warnings};
}

function evaluateParts(data) {
  check(data&&Array.isArray(data.completed),'缺少UP完成等待明细');
  const tails=data.tails??(data.tail?[data.tail]:[]);
  check(Array.isArray(tails),'未出UP等待明细不合法');
  const completedDraws=data.completed.reduce((n,c)=>n+c.actual,0),tailDraws=tails.reduce((n,c)=>n+c.actual,0);
  check(Number.isSafeInteger(completedDraws)&&Number.isSafeInteger(tailDraws)&&completedDraws>=0&&tailDraws>=0&&completedDraws+tailDraws<=30000,'UP有效抽数超过计算范围');
  check(Number.isSafeInteger(data.rushDraws)&&data.rushDraws>=0&&data.rushDraws<=10000,'加急抽数不合法');
  check(Number.isSafeInteger(data.rushUp)&&data.rushUp>=0&&data.rushUp<=data.rushDraws,'加急UP数量不合法');
  data={...data,completedDraws,tailDraws,mainDraws:completedDraws+tailDraws};
  let completedScore=null,tailScore=null,rushScore=null,p0=null;
  if(data.completedDraws) {
    // Every main wait is positive; a prefix at the observed sum is sufficient
    // for its exact lower CDF and mid-tail. No normalization of missing mass.
    const laws=data.completed.map(c=>waitLaw(c.initialPity,c.deadline,data.completedDraws));
    completedScore=100*math.midTail(math.convolveMany(laws,{highCap:data.completedDraws}),data.completedDraws);
  }
  if(data.tailDraws) {
    let weighted=0;
    for(const tail of tails)if(tail.actual) {
      const law=waitLaw(tail.initialPity,tail.deadline,tail.actual);
      const probability=Math.max(0,Math.min(1,1-math.sumMass(law)));
      weighted+=50*probability*tail.actual;
      if(tails.length===1)p0=probability;
    }
    tailScore=weighted/data.tailDraws;
  }
  if(data.rushDraws) {
    // Negating K turns the common cost mid-tail into the count mid-rank.
    rushScore=100*math.midTail(math.rushCountCost(data.rushDraws,.004,1),-data.rushUp);
  }
  const totalDraws=data.mainDraws+data.rushDraws;
  const parts=[['completed',data.completedDraws,completedScore],['tail',data.tailDraws,tailScore],['rush',data.rushDraws,rushScore]];
  const components=Object.fromEntries(parts.map(([key,draws,score])=>[key,{draws,score,weight:totalDraws?draws/totalDraws:0,
    contribution:totalDraws&&draws?score*draws/totalDraws:0}]));
  const score=totalDraws?Object.values(components).reduce((n,p)=>n+p.contribution,0):null;
  return {status:score===null?'unscored':'scored',score,totalDraws,components,p0,...data};
}
function evaluate(record) {return evaluateParts(split(record));}
module.exports={waitLaw,split,evaluateParts,evaluate};
