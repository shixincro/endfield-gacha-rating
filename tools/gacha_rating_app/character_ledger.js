'use strict';

// Retained ledger validation, quota/Five-star calculation and legacy diagnostics.
// Production first-three scores are replaced by character_result_score.js.
const {scoreFive, normalCDF, VERSION: FIVE_VERSION} = require('../character_five_score/scorer');
const VERSION = 'character-ledger-v1-20261015-si-catalog';
const LIMITED = Object.freeze(['莱万汀','洁尔佩塔','伊冯','汤汤','洛茜','庄方宜','弭弗','卡缪','诀','梨诺','提弗洛斯','祀','明河']);
const BANNERS = Object.freeze(['熔火灼痕','轻飘飘的信使','热烈色彩','河流的女儿','狼珀','春雷动，万物生','拳出无悔','逐罪者','临渊望北','晨星于此闪耀','冬猎','万物更新','烟火邀星河']);
const COMMON = Object.freeze(['骏卫','黎风','别礼','余烬','艾尔黛拉']);
const AXES = ['characterSix','up','limited','five'];
const characterName = x => x === '俊卫' ? '骏卫' : x;
const integer = (x, min=0, max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x>=min && x<=max;
const unique = xs => [...new Set(xs)];
const PREVIOUS = LIMITED.map((_,i)=>i===0?[1,2]:i===1?[0,2]:[i-1,i-2]);
const P = [0], S = [1], V = [0], U = [.5];
for(let t=1;t<=80;t++) {
  P[t]=t===80?1:t<=65?.008:.008+.05*(t-65);
  S[t]=S[t-1]*(1-P[t]);
  V[t]=V[t-1]+.25*S[t-1]**2*P[t]*(1-P[t]);
  U[t]=(S[t-1]+S[t])/2;
}
// Rush guarantees upgrade four-star only; six count is Binomial(10,.008).
const rushP=Array(11).fill(0); rushP[0]=1;
for(let n=0;n<10;n++)for(let k=n+1;k>=0;k--)rushP[k]=(rushP[k]||0)*.992+(k>0?rushP[k-1]*.008:0);
let cumulative=0;
const rushU=rushP.map(p=>{const u=cumulative+p/2;cumulative+=p;return u;});
const rushV=rushP.reduce((a,p,k)=>a+p*(rushU[k]-.5)**2,0);

// A known nonzero opening pity is a left-truncated waiting segment. Condition
// on having survived that opening age; never score its unobserved past draws.
function segmentMoments(origin, age, hit) {
  let v=0;
  for(let h=origin+1;h<=age;h++)v+=.25*(S[h-1]/S[origin])**2*P[h]*(1-P[h]);
  const u=hit?(S[age-1]+S[age])/(2*S[origin]):S[age]/(2*S[origin]);
  return {m:u-.5,v};
}

function scoreCharacter(record) {
  const warnings=[], problems=Object.fromEntries(AXES.map(k=>[k,[]]));
  const block=(message, axes=AXES)=>{for(const name of axes)if(problems[name])problems[name].push(message);};
  const first3=['characterSix','up','limited'];
  const unscored=(reasons,details)=>({score:null,status:'unscored',reason:unique(reasons).join('；'),details});
  if(!record || !Array.isArray(record.pools))return {version:VERSION,warnings,axes:Object.fromEntries(AXES.map(k=>[k,unscored(['缺少角色标准账本'])]))};
  const inputIssues=[...(Array.isArray(record.issues)?record.issues:[])];
  const quotaSummary=record.quotaSummary;
  for(const pool of record.pools)if(Array.isArray(pool?.issues))inputIssues.push(...pool.issues);
  for(const issue of inputIssues) {
    const text=typeof issue==='string'?issue:issue?.message||issue?.reason||issue?.code||'输入存在未处理疑点';
    // An explicitly scoped total replaces missing per-pool quota, not conflicts.
    if(issue?.code==='quota_missing'&&quotaSummary!=null)continue;
    // Older saved partial imports carried this blanket gate. Partial coverage
    // is not a data conflict; the boundary is handled segment by segment below.
    if(issue?.code==='incomplete_history'&&record.completeHistory!==true)continue;
    if(issue?.severity==='error')block(text,Array.isArray(issue.axes)?issue.axes:AXES);
    else warnings.push(text);
  }
  if(record.initialPity!=null&&!integer(record.initialPity,0,79))block('期初六星水位越界',first3);
  let ownershipKnown=Array.isArray(record.initialOwned);
  if(record.initialOwned!=null&&!ownershipKnown)block('期初持有列表格式无效',['limited']);
  if(record.completeHistory!==true)warnings.push('仅评分所导入的记录区间，不代表账号完整历史');
  if(!ownershipKnown)warnings.push('期初持有限定未知：限定分按限定产出计算，不计无法确认的歪限定New额外加分');
  const owned=new Set((Array.isArray(record.initialOwned)?record.initialOwned:[]).map(characterName));
  if([...owned].some(x=>!LIMITED.includes(x)&&!COMMON.includes(x)))block('期初持有包含未知角色',['limited']);
  let M=0, variance=0, upM=0, upV=0, limitedM=0, limitedV=0;
  let pity=integer(record.initialPity,0,79)?record.initialPity:null;
  let origin=pity,unknownDraws=0,excludedMainDraws=0,excludedWaitEvents=0;
  let N=0,R=0,K6=0,Q=0, quotaComplete=true, forced=0,natural=0,upCount=0,limitedCount=0,offNew=0,previousIndex=-1;
  const seenPoolIds=new Set(), segments=[];
  const addSegment=(age,hit,metadata)=>{
    const moments=segmentMoments(origin,age,hit);
    M+=moments.m;variance+=moments.v;
    segments.push({...metadata,...(origin?{initialPity:origin,conditional:true}:{})});
  };
  function identity(e,pool,index) {
    const name=characterName(e.character),up=LIMITED[index], candidates=PREVIOUS[index].map(i=>LIMITED[i]);
    if(!name || (!COMMON.includes(name)&&name!==up&&!candidates.includes(name))) {
      block(`${pool.banner||up}存在未知或不在该池名单的六星角色`,['up','limited']);
      return;
    }
    if(!e.forced) {
      const isUp=name===up,isLimited=LIMITED.includes(name),isOffNew=ownershipKnown&&isLimited&&!isUp&&!owned.has(name);
      const m=ownershipKnown?candidates.filter(n=>!owned.has(n)).length:0, mu=(9+m)/14, v=(9+3*m)/14-mu*mu;
      const weight=+isLimited + +isOffNew;
      upM+=.5*(+isUp-.5); upV+=1/16;
      limitedM+=.5*(weight-mu); limitedV+=.25*v;
      natural++; upCount+=+isUp;limitedCount+=+isLimited;offNew+=+isOffNew;
    }
    // Real forced character acquisition affects later New; tokens do not.
    owned.add(name);
  }
  for(let poolNumber=0;poolNumber<record.pools.length;poolNumber++) {
    const pool=record.pools[poolNumber];
    if(!pool||typeof pool!=='object'){block(`第${poolNumber+1}池格式无效`);continue;}
    const label=pool.banner||pool.up||`第${poolNumber+1}池`;
    const index=LIMITED.indexOf(characterName(pool.up));
    const bannerIndex=BANNERS.indexOf(pool.banner);
    if(index<0||(!integer(pool.index,0,LIMITED.length-1))||pool.index!==index||(bannerIndex>=0&&bannerIndex!==index)) {
      block(`${label}的池名、UP或顺序编号不符合已确认常规池名单`);continue;
    }
    if(pool.banner!=null&&bannerIndex<0)block(`${label}不是已支持的小黑盒常规池名称`);
    if(index<=previousIndex)block(`${label}的时间顺序倒置或与前池重复`);
    if(pool.interruptionBefore===true || record.completeHistory!==true&&previousIndex>=0&&index>previousIndex+1) {
      if(pity!=null&&origin!=null&&pity>origin)addSegment(pity,false,{kind:'censored-before-history-gap',failures:pity});
      excludedMainDraws+=unknownDraws;unknownDraws=0;
      pity=null;origin=null;
      // An opening collection does not describe acquisitions in a missing
      // middle banner. Keep known ownership, but do not invent later New hits.
      ownershipKnown=false;
      warnings.push(pool.interruptionBefore===true
        ?`${label}前已启用中断修正，水位从0开始，后续不猜测缺失期间的限定New`
        :`${label}前存在缺失卡池，水位重新以该池已知证据衔接`);
    }
    previousIndex=index;
    const id=pool.id??index;
    if(seenPoolIds.has(id))block(`${label}的来源池重复，需先去重`);
    seenPoolIds.add(id);
    if(!integer(pool.total)||!Array.isArray(pool.events)||!Array.isArray(pool.rush)) {
      block(`${label}缺少有效总抽数、主池事件或加急列表`);continue;
    }
    N+=pool.total;
    if(!Number.isSafeInteger(N))block('角色主抽总数超过安全整数范围');
    if(pool.quota==null)quotaComplete=false;
    else if(!integer(pool.quota)){block(`${label}武库配额必须为非负整数`,['five']);quotaComplete=false;}
    else Q+=pool.quota;
    if(pool.initialPity!=null) {
      if(!integer(pool.initialPity,0,79)||(pity!=null&&pool.initialPity!==pity))block(`${label}期初水位与前池结尾不一致`,first3);
      else if(pity==null){excludedMainDraws+=unknownDraws;unknownDraws=0;pity=pool.initialPity;origin=pity;}
    }
    if(pool.interruptionBefore===true&&pool.initialPity!==0)block(`${label}中断修正后的期初水位必须为0`,first3);
    const rushKnown=typeof pool.rushUsed==='boolean';
    if(!rushKnown)block(`${label}的加急是否实际使用尚未确认`);
    if(pool.rushUsed===true) {
      R++;
      if(pool.total<30)block(`${label}主抽不足30，不能已使用加急`);
    } else if(pool.rush.length)block(`${label}有加急六星但未确认使用加急`);
    if(pool.rush.length>10)block(`${label}一批加急六星数量超过10`);
    // User-confirmed convention: without an explicit timestamp, a used rush
    // batch settles after main draw 30 and before draw 31. This is not OCR fact.
    const rushTimingAssumed=pool.rushUsed===true&&pool.rushAt==null;
    const rushAt=rushTimingAssumed?30:pool.rushAt;
    const rushTimingKnown=integer(rushAt,30,pool.total);
    if(pool.rushAt!=null&&!rushTimingKnown)block(`${label}加急使用位置越界`);
    if(rushTimingAssumed)warnings.push(`${label}加急时点未标注：按用户约定在主池第30抽之后结算，并非OCR识别事实`);
    const events=[];
    let lastAt=0,seenMainUp=false,unknownBefore120=false,hasForcedAt120=false;
    for(const event of pool.events) {
      if(!event||event.source!=='main'||!integer(event.at,1,pool.total)||event.at<=lastAt) {
        block(`${label}主池六星事件位置重复、倒序、越界或来源错误`);continue;
      }
      K6++;
      const delta=event.at-lastAt,t=pity==null?null:pity+delta;
      if(typeof event.forced!=='boolean')block(`${label}第${event.at}抽的120强制标记未确认`,first3);
      const name=characterName(event.character);
      if(event.at===120&&!seenMainUp&&unknownBefore120)block(`${label}120前存在未知身份，无法确认大保底`,first3);
      const expectedForced=event.at===120&&!seenMainUp;
      if(event.forced!==expectedForced)block(`${label}第${event.at}抽的强制标记与120规则冲突`,first3);
      if(event.forced&&name!==LIMITED[index])block(`${label}120强制结果不是当期UP`,first3);
      if(event.forced) {
        forced++;hasForcedAt120=event.at===120;
        if(t!=null&&!integer(t,1,80))block(`${label}强制前未出段超过80小保底边界`,first3);
        else if(t!=null)addSegment(t-1,false,{pool:id,kind:'censored-before-120',failures:t-1});
      } else {
        if(t!=null&&!integer(t,1,80))block(`${label}自然六星等待抽数不在1至80`,first3);
        else if(t!=null)addSegment(t,true,{pool:id,kind:'natural',wait:t});
      }
      if(t==null){
        unknownDraws+=delta;
        if(unknownDraws>80)block(`${label}未知期初的首段仍超过80小保底边界`,first3);
        excludedMainDraws+=unknownDraws;excludedWaitEvents++;
        segments.push({pool:id,kind:'excluded-unknown-opening',observedDraws:unknownDraws,at:event.at});
        unknownDraws=0;
      }
      if(name===LIMITED[index])seenMainUp=true;
      if(!seenMainUp&&event.at<120&&!COMMON.includes(name)&&name!==LIMITED[index]&&!PREVIOUS[index].map(i=>LIMITED[i]).includes(name))unknownBefore120=true;
      pity=0;origin=0;lastAt=event.at;
      events.push({...event,character:name});
    }
    if(pool.total>=120&&!pool.events.some(e=>e&&e.at<120&&characterName(e.character)===LIMITED[index])&&!hasForcedAt120)block(`${label}未见提前主池UP，也缺少120强制结果`);
    if(pity==null){
      unknownDraws+=pool.total-lastAt;
      if(unknownDraws>=80)block(`${label}结尾未出段至少80抽，疑似缺失六星事件`);
      if(pool.tail!=null&&integer(pool.tail,0,79)&&pool.tail>=unknownDraws){
        excludedMainDraws+=unknownDraws;unknownDraws=0;pity=pool.tail;origin=pity;
      } else if(pool.tail!=null)block(`${label}末水位与未知期初的已观测抽数不相容`);
    } else {
      pity+=pool.total-lastAt;
      if(!integer(pity,0,79))block(`${label}结尾水位超过79，疑似缺失六星事件`);
      if(pool.tail!=null&&(!integer(pool.tail,0,79)||pool.tail!==pity))block(`${label}末水位与主池事件不一致`);
    }
    if(pool.rushUsed===true&&pool.rush.length<=10) {
      K6+=pool.rush.length;
      M+=rushU[pool.rush.length]-.5;variance+=rushV;
      segments.push({pool:id,kind:'rush',six:pool.rush.length,at:rushTimingKnown?rushAt:null,timing:rushTimingAssumed?'assumed-after-main-30':'explicit'});
      for(const event of pool.rush) {
        if(!event||typeof event!=='object'){block(`${label}加急结果格式无效`);continue;}
        if(event.forced===true)block(`${label}加急不能是120强制结果`,first3);
        events.push({...event,at:rushTimingKnown?rushAt:pool.total,forced:false,source:'rush'});
      }
    }
    const chronological=(a,b)=>a.at-b.at||(a.source==='main'?-1:b.source==='main'?1:0);
    // Main draw at the trigger position settles before the independent batch.
    events.sort(chronological);
    for(const event of events)identity(event,pool,index);
    if(pool.tokens!=null&&!Array.isArray(pool.tokens))warnings.push(`${label}信物列表格式错误；信物不计欧非分`);
    for(const token of Array.isArray(pool.tokens)?pool.tokens:[]) {
      if(!integer(token?.at,240,pool.total)||token.at%240!==0)warnings.push(`${label}信物位置待确认；未计入抽数、六星或持有本体`);
    }
  }
  if(integer(pity,0,79)&&origin!=null&&pity>origin)addSegment(pity,false,{kind:'final-censored',failures:pity});
  excludedMainDraws+=unknownDraws;
  if(excludedMainDraws)warnings.push(`期初水位未知：六星等待评分跳过${excludedMainDraws}抽的开头未闭合段；已知身份仍参与UP/限定统计`);
  if(N===0&&R===0)block('没有可评分的角色抽卡样本');
  const T=N+10*R;
  if(!Number.isSafeInteger(T)||!Number.isSafeInteger(Q))block('角色抽数或武库配额超过安全整数范围');
  if(quotaSummary!=null) {
    if(!quotaSummary||quotaSummary.scope!=='all-pools'||!integer(quotaSummary.Q)||
       quotaSummary.N!==N||quotaSummary.R!==R||quotaSummary.K6!==K6) {
      block('总武库配额的统计范围与当前主池抽数、加急次数或六星数不一致',['five']);
    } else if(Q>quotaSummary.Q||(quotaComplete&&Q!==quotaSummary.Q)) {
      block('逐池配额合计与总配额冲突',['five']);
    } else {
      Q=quotaSummary.Q;quotaComplete=true;
    }
  }
  let F=null;
  if(!quotaComplete)block('同范围武库配额产出未识别完整，角色五星暂不评分',['five']);
  else {
    const numerator=Q-20*T-1980*K6;
    if(!Number.isSafeInteger(numerator)||numerator<0||numerator%180!==0||numerator/180>T-K6)block('武库配额与总抽数、六星数不相容，不能反推整数五星',['five']);
    else F=numerator/180;
  }
  const counts={main:N,rush:R,total:T,six:K6,forced,natural,up:upCount,limited:limitedCount,offNew:ownershipKnown?offNew:null,five:F,quota:quotaComplete?Q:null,endPity:pity};
  const coverage={completeHistory:record.completeHistory===true,initialPity:record.initialPity??null,
    excludedMainDraws,excludedWaitEvents,ownershipMode:ownershipKnown?'known-initial-owned':'limited-only-no-new-bonus'};
  function axis(name,m,v) {
    const details={M:m,V:v,counts,coverage,method:'frozen-segment-martingale-normal-approximation'};
    if(problems[name].length)return unscored(problems[name],details);
    if(!(v>0)&&Number.isFinite(v))return unscored(['没有有效评分方差'],details);
    const value=100*normalCDF(m/Math.sqrt(v));
    return Number.isFinite(value)?{score:value,status:'scored',details}:unscored(['评分数值无效'],details);
  }
  const axes={characterSix:axis('characterSix',M,variance),up:axis('up',M+upM,variance+upV),limited:axis('limited',M+limitedM,variance+limitedV)};
  const fiveDetails={counts,method:FIVE_VERSION,input:{N,R,F},quotaSource:quotaSummary!=null?'same-scope-total':'per-pool-sum'};
  if(problems.five.length)axes.five=unscored(problems.five,fiveDetails);
  else {
    try {const value=scoreFive({N,R,F});axes.five=value==null?unscored(['没有可评分的五星样本'],fiveDetails):{score:value,status:'scored',details:fiveDetails};}
    catch(error){axes.five=unscored([`五星输入不满足校准模块条件：${error.message}`],fiveDetails);}
  }
  return {version:VERSION,axes,warnings:unique(warnings),counts,segments,coverage};
}

module.exports={scoreCharacter,VERSION,LIMITED,BANNERS,COMMON,probabilities:{P,S,V,U,rushP,rushU,rushV}};
