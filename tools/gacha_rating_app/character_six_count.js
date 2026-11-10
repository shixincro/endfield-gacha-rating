'use strict';
// Ordinary-80 total six-star count DP; rush is an independent binomial.
function check(ok,message='六星计数参数不合法') {if(!ok)throw new Error(message);}
const mainCache=new Map(),rushCache=new Map();
const Q=Float64Array.from({length:80},(_,p)=>p===79?1:p<65?.008:.008+.05*(p-64));
function integer(x,low,high,label){check(Number.isSafeInteger(x)&&x>=low&&x<=high,`${label}超出允许范围`);}
function mainCountPMF(n,maxCount,initialPity=0) {
  integer(n,0,30000,'主池抽数');integer(maxCount,0,40000,'六星数量');integer(initialPity,0,79,'期初水位');
  const cap=Math.min(n,maxCount),key=`${n}/${initialPity}`,old=mainCache.get(key);
  if(old&&old.cap>=cap)return old.p;
  const computed=Math.min(n,Math.ceil((cap+1)/16)*16-1);
  check(n*(computed+1)*80<=500000000,'六星计数分布超过本地安全计算上限');
  let state=new Float64Array((computed+1)*80),next=new Float64Array(state.length);state[initialPity]=1;
  for(let draw=0;draw<n;draw++) {
    next.fill(0);
    for(let k=0;k<=Math.min(computed,draw);k++) {
      const base=k*80,hitBase=(k+1)*80;
      for(let pity=0;pity<80;pity++) {
        const mass=state[base+pity];if(!mass)continue;
        const hit=mass*Q[pity];
        if(k<computed)next[hitBase]+=hit;
        if(pity<79)next[base+pity+1]+=mass-hit;
      }
    }
    [state,next]=[next,state];
  }
  const p=new Float64Array(computed+1);
  for(let k=0;k<=computed;k++)for(let pity=0;pity<80;pity++)p[k]+=state[k*80+pity];
  // Only counts ABOVE the retained prefix are discarded. Never renormalize it.
  if(mainCache.size>=512)mainCache.clear();mainCache.set(key,{cap:computed,p});return p;
}
function rushPMF(n) {
  integer(n,0,10000,'加急抽数');if(rushCache.has(n))return rushCache.get(n);
  const p=new Float64Array(n+1),prob=.008,mode=Math.floor((n+1)*prob);p[mode]=1;
  for(let k=mode;k<n;k++)p[k+1]=p[k]*(n-k)/(k+1)*prob/(1-prob);
  for(let k=mode;k>0;k--)p[k-1]=p[k]*k/(n-k+1)*(1-prob)/prob;
  const mass=p.reduce((a,b)=>a+b,0);for(let k=0;k<=n;k++)p[k]/=mass;
  if(rushCache.size>=256)rushCache.clear();rushCache.set(n,p);return p;
}
function midrank(p,k) {
  let below=0;for(let i=0;i<Math.min(k,p.length);i++)below+=p[i];
  return Math.max(0,Math.min(100,100*(below+.5*(p[k]??0))));
}
function scoreBoth({mainDraws:N,mainSix:K,rushDraws:R,rushSix:k,initialPity=0}) {
  integer(N,0,30000,'主池抽数');integer(K,0,N,'主池六星数');integer(R,0,10000,'加急抽数');integer(k,0,R,'加急六星数');
  const total=N+R,observed=K+k;
  if(!total)return {weighted:null,joint:null,main:null,rush:null,weights:{main:0,rush:0},counts:{mainDraws:N,mainSix:K,rushDraws:R,rushSix:k,initialPity}};
  const m=mainCountPMF(N,observed,initialPity),r=rushPMF(R),joint=new Float64Array(Math.min(observed,total)+1);
  for(let i=0;i<m.length&&i<joint.length;i++)for(let j=0;j<r.length&&i+j<joint.length;j++)joint[i+j]+=m[i]*r[j];
  const main=N?midrank(m,K):null,rush=R?midrank(r,k):null;
  return {weighted:((main??0)*N+(rush??0)*R)/total,joint:midrank(joint,observed),main,rush,
    weights:{main:N/total,rush:R/total},counts:{mainDraws:N,mainSix:K,rushDraws:R,rushSix:k,initialPity}};
}
function countsFromLedger(record) {
  check(Array.isArray(record.pools));integer(record.initialPity,0,79,'已知期初水位');
  return {mainDraws:record.pools.reduce((n,p)=>n+p.total,0),mainSix:record.pools.reduce((n,p)=>n+p.events.length,0),
    rushDraws:record.pools.filter(p=>p.rushUsed).length*10,rushSix:record.pools.reduce((n,p)=>n+(p.rushUsed?p.rush.length:0),0),initialPity:record.initialPity};
}
function scoreSegments(segments,{rushDraws=0,rushSix=0}={}) {
  check(Array.isArray(segments),'缺少已知水位区间');
  integer(rushDraws,0,10000,'加急抽数');integer(rushSix,0,rushDraws,'加急六星数');
  let mainDraws=0,mainSix=0;
  for(const s of segments) {
    integer(s.mainDraws,0,30000,'主池抽数');integer(s.mainSix,0,s.mainDraws,'主池六星数');integer(s.initialPity,0,79,'期初水位');
    mainDraws+=s.mainDraws;mainSix+=s.mainSix;
  }
  integer(mainDraws,0,30000,'有效主池总抽数');
  const observed=mainSix+rushSix,total=mainDraws+rushDraws;
  if(!total)return {score:null,joint:null,main:null,rush:null,counts:{mainDraws,mainSix,rushDraws,rushSix},segments};
  let p=Float64Array.of(1);
  const combine=q=>{
    const out=new Float64Array(Math.min(observed+1,p.length+q.length-1));
    for(let a=0;a<p.length;a++)for(let b=0;b<q.length&&a+b<out.length;b++)out[a+b]+=p[a]*q[b];
    p=out;
  };
  for(const s of segments)combine(mainCountPMF(s.mainDraws,observed,s.initialPity));
  const main=mainDraws?midrank(p,mainSix):null,r=rushPMF(rushDraws),rush=rushDraws?midrank(r,rushSix):null;
  combine(r);const score=midrank(p,observed);
  return {score,joint:score,main,rush,counts:{mainDraws,mainSix,rushDraws,rushSix},segments};
}
module.exports={mainCountPMF,rushPMF,midrank,scoreBoth,countsFromLedger,scoreSegments};
