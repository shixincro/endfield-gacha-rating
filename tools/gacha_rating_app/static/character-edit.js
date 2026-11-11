(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CharacterEdit = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Editing rules only. Probability/scoring formulas remain in the scorers.
  const LIMITED = Object.freeze(['莱万汀','洁尔佩塔','伊冯','汤汤','洛茜','庄方宜','弭弗','卡缪','诀','梨诺','提弗洛斯','祀','明河']);
  const COMMON = Object.freeze(['骏卫','黎风','别礼','余烬','艾尔黛拉']);
  const BANNERS = Object.freeze(['熔火灼痕','轻飘飘的信使','热烈色彩','河流的女儿','狼珀','春雷动，万物生','拳出无悔','逐罪者','临渊望北','晨星于此闪耀','冬猎','万物更新','烟火邀星河']);
  const integer = (v, low = 0, high = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= low && v <= high;
  const orderedPools = record => [...(record?.pools || [])].sort((a,b) => a.index-b.index);
  const nameOf = value => value === '俊卫' ? '骏卫' : value;
  const inherited = (record, previous, next) => next && !next.interruptionBefore && next.index > previous.index &&
    !(record.interruptionCorrection?.excludedIndices || []).some(i=>i>=previous.index&&i<=next.index) &&
    (next.index === previous.index + 1 || record.completeHistory === true);

  function validateInterruption(record) {
    const value=record?.interruptionCorrection;if(value==null)return '';
    if(typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.excludedIndices)||
       value.excludedIndices.length>BANNERS.length||value.excludedIndices.some(i=>!integer(i,0,BANNERS.length-1))||
       new Set(value.excludedIndices).size!==value.excludedIndices.length)return '中断修正的排除卡池选项无效。';
    const free=Object.hasOwn(value,'freeAllowances')?value.freeAllowances:{};
    if(typeof free!=='object'||free===null||Array.isArray(free)||Object.entries(free).some(([key,n])=>
       !/^(0|[1-9]\d*)$/.test(key)||!integer(Number(key),0,BANNERS.length-1)||![0,10,20].includes(n)))return '中断后的免费额度须选择0、10或20抽。';
    const resume=Object.hasOwn(value,'resumeInfo')?value.resumeInfo:{},known=new Set([...LIMITED,...COMMON]);
    if(!resume||typeof resume!=='object'||Array.isArray(resume)||Object.entries(resume).some(([key,info])=>
       !/^(0|[1-9]\d*)$/.test(key)||!integer(Number(key),0,BANNERS.length-1)||!info||typeof info!=='object'||Array.isArray(info)))return '中断补充信息须对应有效卡池。';
    for(const info of Object.values(resume)){
      const names=Object.hasOwn(info,'ownedSixStars')?info.ownedSixStars:[];
      if(!Array.isArray(names)||names.length>known.size||names.some(n=>!known.has(nameOf(n)))||
         new Set(names.map(nameOf)).size!==names.length)return '补充图鉴须为不重复的已支持六星角色。';
      if(Object.hasOwn(info,'catalogComplete')&&typeof info.catalogComplete!=='boolean')return '图鉴补全确认须为选中或未选中。';
      if(!integer(Object.hasOwn(info,'initialPity')?info.initialPity:0,0,79))return '中断后补充水位须为0—79的整数。';
    }
    return '';
  }

  function projectCharacter(record,{forPlanning=false}={}) {
    const character=JSON.parse(JSON.stringify(record||{pools:[]}));
    const problem=validateInterruption(character);if(problem)throw new Error(problem);
    const selected=[...(character.interruptionCorrection?.excludedIndices||[])].sort((a,b)=>a-b);
    const summary={enabled:selected.length>0,version:'history-interruption-v2-catalog-pity-20261111',excludedIndices:selected,
      excludedBanners:selected.map(i=>BANNERS[i]),excludedPoolIds:[],excludedMainDraws:0,resetPools:[]};
    if(!selected.length)return {character,summary};
    const originals=orderedPools(character),removed=(character.pools||[]).filter(p=>selected.includes(p.index));
    summary.excludedPoolIds=removed.map(p=>p.id);
    summary.excludedMainDraws=removed.reduce((n,p)=>n+(integer(p.total,0,10000)?p.total:0),0);
    if(!removed.length&&!selected.some(index=>originals.some(pool=>index<pool.index)))return {character,summary};
    character.pools=originals.filter(p=>!selected.includes(p.index));
    character.completeHistory=false;
    if(removed.length)delete character.quotaSummary;
    let previousOriginal=null,previousEffective=null;
    for(const pool of character.pools){
      const original=JSON.parse(JSON.stringify(pool)),boundary=selected.some(i=>i>(previousOriginal?.index??-1)&&i<pool.index);
      if(boundary){
        const info=character.interruptionCorrection.resumeInfo?.[pool.index]??{};
        pool.interruptionBefore=true;pool.initialPity=forPlanning?0:info.initialPity??0;
        pool.interruptionCatalog={ownedSixStars:(info.ownedSixStars??[]).map(nameOf),catalogComplete:info.catalogComplete??false};
        pool.freeAllowance=character.interruptionCorrection.freeAllowances?.[pool.index]??10;
        delete pool.freeDrawPositions;
        summary.resetPools.push({id:pool.id,index:pool.index,banner:pool.banner,initialPity:pool.initialPity,
          planningInitialPity:0,freeAllowance:pool.freeAllowance,...pool.interruptionCatalog});
      }else if(previousOriginal&&pool.index===previousOriginal.index+1&&
               previousEffective.tail!==previousOriginal.tail&&
               (original.initialPity==null||original.initialPity===previousOriginal.tail)&&integer(previousEffective.tail,0,79)){
        pool.initialPity=previousEffective.tail;
      }
      if((boundary||pool.initialPity!==original.initialPity)&&Array.isArray(pool.events)&&pool.events.length===0&&
         integer(pool.total,0,10000)&&integer(pool.initialPity,0,79)&&
         (boundary||original.tail==null||(integer(original.initialPity,0,79)&&original.tail===original.initialPity+original.total))){
        pool.tail=pool.initialPity+pool.total;pool.localTail=pool.total;
      }
      previousOriginal=original;previousEffective=pool;
    }
    const first=character.pools[0];
    if(!first||first.interruptionBefore||first.id!==originals[0]?.id){
      character.initialPity=first?.initialPity??null;character.initialOwned=null;delete character.firstPoolHistory;
    }
    return {character,summary};
  }

  function availableBanners(record) {
    const pools = record?.pools || [];
    return BANNERS.map((banner,index) => ({index,banner,up:LIMITED[index]}))
      .filter(item => !pools.some(pool => pool.index === item.index || pool.banner === item.banner));
  }

  function updateCoverageAfterPoolChange(record, oldFirst) {
    const pools = orderedPools(record), first = pools[0];
    if (first?.id !== oldFirst?.id) {
      // These answers described the old first pool, so cannot describe a new scope.
      delete record.firstPoolHistory;
      record.initialPity = first?.initialPity ?? null;
      record.initialOwned = first?.index === 0 ? [] : null;
    }
    const history = record.firstPoolHistory;
    const confirmedFirst = history?.poolId === first?.id && typeof history.isFirstPool === 'boolean'
      ? history.isFirstPool : first?.index === 0;
    record.completeHistory = Boolean(confirmedFirst && pools.every((pool,i) => !i || pool.index === pools[i-1].index+1));
    record.historyEvidence = 'manual-banner-coverage';
  }

  function addPool(record, index) {
    if (!record || !Array.isArray(record.pools) || !integer(index,0,BANNERS.length-1)) throw new Error('请选择有效卡池。');
    if (!availableBanners(record).some(item => item.index === index)) throw new Error('该卡池已存在，请直接修正。');
    const ordered = orderedPools(record), previous = [...ordered].reverse().find(pool => pool.index < index);
    let id = `manual-banner-${index}`, suffix = 1;
    while (record.pools.some(pool => pool.id === id)) id = `manual-banner-${index}-${suffix++}`;
    const pool = {id,index,banner:BANNERS[index],up:LIMITED[index],total:null,quota:null,
      initialPity:index === 0 ? 0 : previous?.index === index-1 && integer(previous.tail,0,79) ? previous.tail : null,
      initialPitySource:'record-derived',
      tail:null,localTail:null,events:[],rushUsed:null,rushAt:null,rush:[],tokens:[],issues:[],
      evidence:{manual:true}};
    record.pools.push(pool);
    record.pools.sort((a,b) => a.index-b.index);
    updateCoverageAfterPoolChange(record,ordered[0]);
    return pool;
  }

  function removeManualPool(record, id) {
    const pool = record?.pools?.find(item => item.id === id);
    if (!pool || pool.evidence?.manual !== true) return false;
    const oldFirst = orderedPools(record)[0];
    record.pools.splice(record.pools.indexOf(pool),1);
    updateCoverageAfterPoolChange(record,oldFirst);
    return true;
  }

  function candidates(pool) {
    const index = LIMITED.indexOf(nameOf(pool.up));
    if (index < 0) return [];
    const previous = index === 0 ? [1,2] : index === 1 ? [0,2] : [index-1,index-2];
    return [LIMITED[index], ...previous.map(i => LIMITED[i]), ...COMMON];
  }

  function derivedPoolTail(pool) {
    if (!integer(pool.total,0,10000) || !Array.isArray(pool.events)) return undefined;
    const positions = pool.events.map(event => event?.at);
    if (positions.some(at => !integer(at,1,pool.total)) || new Set(positions).size !== positions.length) return undefined;
    if (positions.length) return pool.total - Math.max(...positions);
    if (pool.initialPity == null) return null;
    return integer(pool.initialPity,0,79) ? pool.total + pool.initialPity : undefined;
  }

  function updateLocalTail(pool) {
    if (!integer(pool.total,0,10000) || !Array.isArray(pool.events)) return;
    const positions = pool.events.map(event => event?.at);
    if (positions.some(at => !integer(at,1,pool.total)) || new Set(positions).size !== positions.length) return;
    pool.localTail = pool.total - (positions.length ? Math.max(...positions) : 0);
  }

  function carry(record, pools, index, oldTail, newTail) {
    const pool = pools[index], next = pools[index+1];
    if (!inherited(record,pool,next)) return;
    // Screenshot water was computed from the old record. Inserting missing
    // draws/pools changes that reference, even if the new pool ends at zero.
    // An explicitly supplied opening remains independent evidence.
    const derived = next.initialPitySource === 'record-derived';
    if (oldTail === newTail && (!derived || next.initialPity === newTail)) return;
    if (next.initialPitySource === 'manual' && next.initialPity !== newTail) return;
    if (!derived && (oldTail == null ? next.initialPity != null : next.initialPity !== oldTail)) return;
    next.initialPity = newTail;
    const oldNextTail = next.tail, nextTail = derivedPoolTail(next);
    if (nextTail === undefined) return;
    next.tail = nextTail;
    updateLocalTail(next);
    carry(record,pools,index+1,oldNextTail,nextTail);
  }

  function updatePoolWater(record, pool) {
    const pools = orderedPools(record), index = pools.indexOf(pool);
    if (index < 0) return;
    const oldTail = pool.tail, nextTail = derivedPoolTail(pool);
    if (nextTail === undefined) return;
    pool.tail = nextTail;
    updateLocalTail(pool);
    carry(record,pools,index,oldTail,nextTail);
  }

  function setInitialPity(record, pool, value) {
    pool.initialPity = value;
    pool.initialPitySource = 'manual';
    if (orderedPools(record)[0] === pool) record.initialPity = value;
    updatePoolWater(record,pool);
  }

  function setTail(record, pool, value) {
    const oldTail = pool.tail;
    pool.tail = value;
    const pools = orderedPools(record), index = pools.indexOf(pool);
    // A no-hit segment with unknown opening age can identify its own opening.
    // If opening age was already supplied, leave contradictions visible.
    const rootOpeningKnown = pools[0] === pool && integer(record.initialPity,0,79);
    if (pool.initialPity == null && !rootOpeningKnown && Array.isArray(pool.events) && pool.events.length === 0 &&
        integer(pool.total,0,10000) && integer(value,0,79) && integer(value-pool.total,0,79)) {
      pool.initialPity = value-pool.total;
      pool.initialPitySource = 'manual';
      if (pools[0] === pool) record.initialPity = pool.initialPity;
    }
    if (index >= 0 && derivedPoolTail(pool) === value) {
      updateLocalTail(pool);
      carry(record,pools,index,oldTail,value);
    }
  }

  function setRushUsed(pool, value) {
    pool.rushUsed = value;
    if (value === false) {
      pool.rushAt = null;
      pool.rushAtSource = 'manual-not-used';
    } else if (value === true && pool.rushAt == null) {
      pool.rushAt = 30;
      pool.rushAtSource = 'confirmed-default-after-main-30';
    }
  }

  function syncTokens(pool) {
    if (!integer(pool.total,0,10000)) return;
    const old = Array.isArray(pool.tokens) ? pool.tokens : [];
    pool.tokens = [];
    for (let at=240; at<=pool.total; at+=240) {
      const existing = old.find(token => token?.at === at);
      pool.tokens.push(existing || {at,source:'token',evidence:{inferredFrom:'confirmed-total-fixed-240-node'}});
    }
  }

  function normalizePool(pool) {
    if (!Array.isArray(pool.events)) return;
    pool.events.sort((a,b) => a.at-b.at);
    let hasUp = false;
    for (const event of pool.events) {
      event.character = nameOf(event.character);
      event.forced = event.at === 120 && !hasUp && event.character === pool.up;
      if (event.character === pool.up) hasUp = true;
    }
    for (const event of pool.rush || []) event.character = nameOf(event.character);
    syncTokens(pool);
    updateLocalTail(pool);
  }

  function allowsMissingQuota(record) {
    return !!record?.quotaSummary || (record?.pools || []).some(pool =>
      pool.manualSupplementFiveUnknown === true && pool.manualSupplementQuotaEvidence?.summary?.scope === 'all-pools');
  }

  function validatePool(pool, {allowMissingQuota = false} = {}) {
    if (!integer(pool.total,0,10000)) return '总抽数须为0—10000的整数。';
    if (pool.freeAllowance != null && !(pool.interruptionBefore?[0,10,20]:[10,20]).includes(pool.freeAllowance)) return '本池免费额度只支持10抽或20抽；中断后可选0抽。';
    if (!((allowMissingQuota || pool.manualSupplementFiveUnknown === true) && pool.quota == null) &&
        !integer(pool.quota)) return '武库配额须为非负整数。';
    if (!Array.isArray(pool.events) || !Array.isArray(pool.rush)) return '主池和加急出货明细须为列表。';
    if (typeof pool.rushUsed !== 'boolean') return '加急使用状态缺失。';
    if (pool.rushUsed && (pool.total < 30 || (pool.rushAt != null && !integer(pool.rushAt,30,pool.total)))) return '加急使用位置不在30至本池总抽数之间。';
    if (!pool.rushUsed && pool.rush.length) return '未使用加急但存在加急出货，请先移除误录行或改为已使用。';
    if (pool.rushAt != null && !integer(pool.rushAt,30,pool.total)) return '加急时点越界，请更正使用状态和位置。';
    if (pool.initialPity != null && !integer(pool.initialPity,0,79)) return '期初水位须为0—79的整数，未知时可留空。';
    if (pool.tail != null && !integer(pool.tail,0,79)) return '期末水位须为0—79的整数，未知时可留空。';
    const allowed = candidates(pool);
    if (!allowed.length) return '当前卡池UP不在支持名单中。';
    if (pool.rush.length > 10) return '独立加急十连最多出现10个六星。';
    for (let i=0;i<pool.rush.length;i++) {
      const event = pool.rush[i];
      if (!event || !allowed.includes(nameOf(event.character))) return `第${i+1}条加急出货的角色不在本池可出名单中。`;
      if (event.source != null && event.source !== 'rush') return `第${i+1}条加急出货来源错误，不能混入主池或赠品。`;
      if (event.forced === true) return `第${i+1}条加急出货不能标记为120强制保底。`;
    }
    const seen = new Set();
    for (let i=0;i<pool.events.length;i++) {
      const event = pool.events[i];
      if (!event || !integer(event.at,1,pool.total)) return `第${i+1}条六星记录的累计位置须为1—${pool.total}的整数。`;
      if (seen.has(event.at)) return `第${event.at}抽重复出现六星记录。`;
      if (!allowed.includes(nameOf(event.character))) return `第${event.at}抽的六星角色不在本池可出名单中。`;
      if (event.source !== 'main') return `第${event.at}抽的六星记录来源不是主池。`;
      seen.add(event.at);
    }
    const ordered = [...pool.events].sort((a,b) => a.at-b.at);
    let previous=0, hasUp=false;
    for (const event of ordered) {
      const wait = event.at-previous + (previous===0 ? (pool.initialPity ?? 0) : 0);
      if (wait > 80) return `第${event.at}抽六星距上次出货（含期初水位）为${wait}抽，超过80抽；120保底也不能越过80保底。`;
      if (event.at === 120 && !hasUp && nameOf(event.character) !== pool.up) return '第120抽尚未取得主池UP，这一抽必须为当期UP。';
      if (nameOf(event.character) === pool.up) hasUp=true;
      previous=event.at;
    }
    const derived = derivedPoolTail(pool);
    if (derived != null && (!integer(derived,0,79) || pool.tail !== derived)) return `期末水位与主池记录不一致：应为${derived}，当前为${pool.tail ?? '未知'}。`;
    if (!ordered.length && pool.initialPity == null && pool.tail != null && pool.tail < pool.total) return '期末水位小于本池已观察到的未出抽数。';
    if (!ordered.length && pool.initialPity == null && pool.total >= 80) return '未知期初水位的未出段仍不能达到80抽，疑似漏录六星。';
    if (pool.total >= 120 && !ordered.some(event => nameOf(event.character) === pool.up && event.at <= 120)) return '前120抽缺少主池当期UP记录。';
    return '';
  }

  function validateLinks(record) {
    const interruptionProblem=validateInterruption(record);if(interruptionProblem)return interruptionProblem;
    record=projectCharacter(record).character;
    const pools = orderedPools(record);
    if (record.initialPity != null && !integer(record.initialPity,0,79)) return '期初信息中的水位须为0—79的整数。';
    if (pools.length && record.initialPity != null && pools[0].initialPity != null && record.initialPity !== pools[0].initialPity) return `${pools[0].banner}的期初水位与首池之前的信息不一致。`;
    if (pools.length && record.initialPity != null && pools[0].initialPity == null && Array.isArray(pools[0].events) && pools[0].events.length === 0 &&
        pools[0].tail != null && integer(pools[0].total,0,10000) && pools[0].tail !== record.initialPity+pools[0].total) return `${pools[0].banner}的期末水位与已填写的期初信息不一致。`;
    for (let i=1;i<pools.length;i++) {
      const before=pools[i-1], current=pools[i];
      if (inherited(record,before,current) && before.tail != null && current.initialPity != null && before.tail !== current.initialPity) return `${current.banner}期初水位${current.initialPity}与上一池${before.banner}期末水位${before.tail}不一致。`;
    }
    return '';
  }

  return {LIMITED,COMMON,BANNERS,availableBanners,addPool,removeManualPool,candidates,derivedPoolTail,updatePoolWater,setInitialPity,setTail,setRushUsed,syncTokens,normalizePool,allowsMissingQuota,validatePool,validateLinks,validateInterruption,projectCharacter};
});
