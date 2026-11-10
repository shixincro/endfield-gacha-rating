(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RatingUIModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const snapshotFields = ['N', 'K6', 'KU', 'lossDraws', 'profile', 'potentialConfig'];
  const normalizedProfile = value => typeof value === 'string' ? value.trim().replace(/\s*\*\s*/g, '*').replace(/\s+/g, ' ') || null : null;
  // Five-star scores stay on the radar but never enter nickname validation or selection.
  const luckAxes = ['characterSix', 'up', 'limited', 'weaponSix', 'signature'];
  // High / middle / low, in characterSix -> up -> limited order.
  const characterTitles = [
    '天命所归', '当期红人', '金光独宠', '群星荟萃', '金光满地', '常驻盛宴', '歪中藏金', '歪门宗师', '常驻收藏家',
    '双重眷顾', '当期如约', '独宠今朝', '限定眷顾', '星途平常', '常客有缘', '歪出奇缘', '当期守望', '常驻长情',
    '惜金藏珍', '惜金逢君', '惜金独宠', '沙里淘珍', '金光吝啬', '惜金遇故人', '绝境藏珍', '金稀君远', '人才凋零',
  ];
  // High / middle / low, in weaponSix -> signature order.
  const weaponTitles = ['武库鼎盛', '百兵来朝', '满库寻本命', '专武眷顾', '兵运平平', '本命难铸', '神兵独秀', '武库清寒', '武库荒年'];
  const lossTitles = ['自律狂人', '精打细算', '随性挥霍', '上头豪客', '亏掉底裤'];
  const lossBounds = [20, 60, 120, 240];

  /** Presentation bands, not a new probability model or a normalized score. */
  function planningTitle(loss) {
    if (!Number.isFinite(loss)) return {title: null, lossTier: null, titleRule: null};
    const boundary = lossBounds.findIndex(bound => loss <= bound);
    const index = boundary < 0 ? 4 : boundary;
    return {title: lossTitles[index], lossTier: index + 1,
      titleRule: '娱乐性称号按未四舍五入的有符号净亏损分档：≤20、(20,60]、(60,120]、(120,240]、>240抽；越低越好，不是概率排名。'};
  }

  function planningCountedLoss(pool) {
    if (pool?.status !== 'ok') return null;
    if (Object.prototype.hasOwnProperty.call(pool,'countedLoss')) return Number.isFinite(pool.countedLoss) ? pool.countedLoss : null;
    return Number.isFinite(pool.localLoss) ? pool.localLoss : null;
  }

  /** Counted signed losses only; missing/provisional rows never become zero. */
  function planningOverview(planning, limit = 5) {
    const pools = Array.isArray(planning?.pools) ? planning.pools : [];
    const known = pools.filter(pool => Number.isFinite(planningCountedLoss(pool)));
    const sum = known.reduce((total, pool) => total + planningCountedLoss(pool), 0);
    const total = known.length > 0 && Number.isFinite(sum) ? (sum === 0 ? 0 : sum) : null;
    const complete = known.length > 0 && known.length === pools.length && total !== null;
    const countLimit = Number.isSafeInteger(limit) && limit >= 0 ? limit : 5;
    const topPools = known.filter(pool => planningCountedLoss(pool) > 0)
      .slice().sort((a, b) => planningCountedLoss(b) - planningCountedLoss(a)).slice(0, countLimit)
      .map(pool => ({...pool}));
    const exempted = known.filter(pool => pool.planningExempt === true && Number.isFinite(pool.exemptedLoss) && pool.exemptedLoss > 0);
    return {total, score: null, complete,
      ...(complete ? planningTitle(total) : {title: null, lossTier: null, titleRule: null}),
      count: known.length, totalPools: pools.length, topPools,
      exemptedPools:exempted.length,exemptedLossSum:exempted.reduce((sum,pool)=>sum+pool.exemptedLoss,0)};
  }

  /** Independent B subtotal; unknown/provisional quotes never become zero. */
  function planningOpportunityOverview(planning) {
    const pools = Array.isArray(planning?.pools) ? planning.pools : [];
    const known = pools.filter(p => p?.opportunity?.status === 'ok'
      && Number.isFinite(p.opportunity.value) && p.opportunity.value >= 0);
    const sum = known.reduce((s, p) => s + p.opportunity.value, 0);
    const total = known.length && Number.isFinite(sum) ? sum : null;
    return {total, count: known.length, totalPools: pools.length,
      complete: known.length > 0 && known.length === pools.length && total !== null};
  }

  /** Five-axis presentation lookup only. Never rescore or average percentiles. */
  function luckTitle(axes) {
    const valid = value => value && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
      && (value.status === undefined || value.status === 'ok' || value.status === 'scored');
    if (!axes || luckAxes.some(key => !valid(axes[key]))) {
      return {name: '数据不足', baseName: null, profile: null, profiles: [], complete: false,
        characterTitle: null, weaponTitle: null, highCount: null, lowCount: null,
        rule: '角色六星、当期UP、限定、六星武器、当期专武五项均有有效分数后生成称号；五星不参与，不使用均分，也不替缺失维度补值。'};
    }
    const values = luckAxes.map(key => axes[key].score);
    const band = value => value >= 70 ? 0 : value <= 30 ? 2 : 1;
    const bands = values.map(band), bandNames = ['高', '中', '低'];
    const characters = values.slice(0, 3), weapons = values.slice(3);
    let characterTitle = characterTitles[bands[0] * 9 + bands[1] * 3 + bands[2]];
    let weaponTitle = weaponTitles[bands[3] * 3 + bands[4]];
    const groupRules = [];
    if (characters.every(value => value >= 90)) {
      characterTitle = '群星俯首'; groupRules.push('角色三项全部≥90');
    } else if (characters.every(value => value <= 10)) {
      characterTitle = '命途多舛'; groupRules.push('角色三项全部≤10');
    }
    if (weapons.every(value => value >= 90)) {
      weaponTitle = '神兵天授'; groupRules.push('武器两项全部≥90');
    } else if (weapons.every(value => value <= 10)) {
      weaponTitle = '寸铁难求'; groupRules.push('武器两项全部≤10');
    }

    // Whole-profile titles take precedence over both table halves and group upgrades.
    let name = `${characterTitle}·${weaponTitle}`;
    let selectionRule = `角色六星/当期UP/限定为${bands.slice(0, 3).map(index => bandNames[index]).join('/')}，六星武器/当期专武为${bands.slice(3).map(index => bandNames[index]).join('/')}`;
    if (values.every(value => value >= 90)) {
      name = '点石成金至尊欧皇'; selectionRule = '五项全部≥90，使用整体专属称号';
    } else if (values.every(value => value <= 10)) {
      name = '面目全非'; selectionRule = '五项全部≤10，使用整体专属称号';
    } else if (values.every(value => value >= 70)) {
      name = '宗师级欧皇'; selectionRule = '五项全部≥70，使用整体专属称号';
    } else if (values.every(value => value <= 30)) {
      name = '非入骨髓'; selectionRule = '五项全部≤30，使用整体专属称号';
    } else if (groupRules.length) {
      selectionRule += `；分组强化：${groupRules.join('，')}`;
    }
    return {name, baseName: name, profile: null, profiles: [], complete: true,
      characterTitle, weaponTitle, highCount: bands.filter(index => index === 0).length,
      lowCount: bands.filter(index => index === 2).length,
      rule: [selectionRule, '以未四舍五入分数判断：高≥70，中为30至70之间，低≤30；整组≥90或≤10触发极端强化',
        '五星不参与；娱乐性称号只描述五维表现，不改变评分，不代表综合概率或排名'].join('；')};
  }

  /** Result-profile syntax only; scoring and gift inference belong to the server. */
  function parseWeaponProfile(value) {
    const profile = normalizedProfile(value);
    if (value != null && typeof value !== 'string') return {profile: null, errors: ['潜能配置须为文本：种类数，后续填潜能或“潜能*数量”。']};
    if (!profile) return {profile: null, errors: []};
    if (value.length > 8192) return {profile, errors: ['潜能配置文本不能超过8192个字符。']};
    const tokens = profile.split(' ');
    const validNumber = token => /^\d+$/.test(token) && token.replace(/^0+/, '').length <= 9;
    if (!validNumber(tokens[0]) || Number(tokens[0]) < 1 || Number(tokens[0]) > 30)
      return {profile, errors: ['潜能配置首项须为1—30之间的专武种数。']};
    const types = Number(tokens[0]), potentials = [], errors = [];
    for (const token of tokens.slice(1)) {
      const match = /^(\d+)(?:\*(\d+))?$/.exec(token);
      if (!match || !validNumber(match[1]) || (match[2] !== undefined && !validNumber(match[2])))
        return {profile, errors: ['后续填写非负潜能或“潜能*数量”，例如5*7表示7种5潜；数值最多9位有效数字。']};
      const potential = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
      if (count < 1) return {profile, errors: ['“潜能*数量”中的数量必须是正整数。']};
      if (potentials.length + count > types)
        return {profile, errors: ['填写潜能的武器数量不能超过专武种数。']};
      potentials.push(...Array(count).fill(potential));
    }
    const copies = types + potentials.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(copies)) errors.push('潜能配置的总份数超出可用范围。');
    return {profile, types, potentials, copies, errors};
  }

  function hasWeaponProfile(weapon) {
    return weapon?.potentialConfig != null || normalizedProfile(weapon?.profile) !== null;
  }

  function weaponConfigForForm(weapon) {
    if (weapon?.potentialConfig != null) {
      const source = weapon.potentialConfig;
      const config = {totalTypes:source.totalTypes??null, overflowCopies:source.overflowCopies??0,
        counts:Array.from({length:5},(_,i)=>source.counts?.[i]??0)};
      if (Array.isArray(source.overflowByType)) config.overflowByType=source.overflowByType.slice(0,30);
      return config;
    }
    const legacy = parseWeaponProfile(weapon?.profile);
    const config = {totalTypes:legacy.types ?? null, counts:[0,0,0,0,0], overflowCopies:0};
    const distribution = [];
    for (const potential of legacy.potentials || []) {
      if (potential > 0) config.counts[Math.min(potential,5)-1]++;
      if (potential >= 5) distribution.push(potential-5);
    }
    config.overflowCopies = distribution.reduce((sum,n)=>sum+n,0);
    if (distribution.length > 1 && config.overflowCopies) config.overflowByType = distribution;
    return config;
  }

  function weaponForSave(weapon, enabled) {
    const value = {...weapon};
    if (!enabled) {value.profile = null; delete value.potentialConfig;}
    else if (value.potentialConfig != null) value.profile = null;
    else value.profile = normalizedProfile(value.profile);
    return value;
  }

  function tableProfile(config) {
    const fail = message => ({errors:[message]});
    if (!config || typeof config !== 'object' || Array.isArray(config)) return fail('潜能配置格式无效。');
    const {totalTypes,counts,overflowCopies=0} = config;
    if (!integer(totalTypes) || totalTypes < 1 || totalTypes > 30) return fail('总专武种类须为1至30的整数。');
    if (!Array.isArray(counts) || counts.length !== 5 || !counts.every(n=>integer(n)&&n<=30)) return fail('1至5潜专武数量须为0至30的整数。');
    if (counts.reduce((sum,n)=>sum+n,0) > totalTypes) return fail('各潜能数量之和不能超过总专武种类。');
    if (!integer(overflowCopies) || overflowCopies > 30000) return fail('溢出专武数量须为0至30000的整数。');
    const full = counts[4], allocation = config.overflowByType;
    if (overflowCopies && !full) return fail('有溢出时至少需要一把5潜专武。');
    if (full > 1 && overflowCopies && allocation == null) return fail('请分别填写各把5潜专武的溢出份数。');
    if (allocation != null && (!Array.isArray(allocation) || allocation.length !== full ||
        !allocation.every(n=>integer(n)&&n<=overflowCopies) || allocation.reduce((sum,n)=>sum+n,0)!==overflowCopies)) {
      return fail('各把5潜专武的溢出份数之和须等于溢出专武数量。');
    }
    const copies = totalTypes + counts.reduce((sum,n,i)=>sum+(i+1)*n,0) + overflowCopies;
    return {types:totalTypes, copies, errors:[]};
  }

  /** Input mechanics only. Legacy B/H80 metadata never selects a scoring mode. */
  function validateWeapon(weapon, {requireProfile = false} = {}) {
    const w = weapon && typeof weapon === 'object' ? weapon : {};
    const errors = [];
    const validN = integer(w.N), validSix = integer(w.K6), validUp = integer(w.KU);
    if (!validN) errors.push('武器总抽数必须是非负整数。');
    else {
      if (w.N === 0) errors.push('没有武器抽卡数据，不能确认。');
        if (w.N % 10 !== 0 && w.allowIndividualDraws !== true) errors.push('武器总抽数必须是10的倍数。');
    }
    if (!validSix) errors.push('六星武器数量必须是非负整数。');
    if (!validUp) errors.push('当期专武数量必须是非负整数。');
    if (validN && validSix && w.K6 > w.N) errors.push('六星武器数量不能超过总抽数。');
    if (validSix && validUp && w.KU > w.K6) errors.push('当期专武数量不能超过六星武器数量。');
    if (w.lossDraws != null) {
      if (!integer(w.lossDraws) || w.lossDraws>30000) errors.push('亏损抽数须为0至30000的整数。');
      else if (validN && validUp && w.lossDraws > w.N-w.KU) errors.push('扣除亏损后，剩余抽数不能少于抽出的当期专武数。');
    }
    const parsed = w.potentialConfig != null ? tableProfile(w.potentialConfig) : parseWeaponProfile(w.profile);
    errors.push(...parsed.errors);
    if (requireProfile && !hasWeaponProfile(w)) errors.push('请填写潜能配置。');
    if (!parsed.errors.length && hasWeaponProfile(w) && validUp) {
      if (parsed.copies < w.KU) errors.push('潜能配置的专武总份数不能少于原始当期专武数。');
      if (parsed.types > w.KU) errors.push('总专武种类不能超过原始当期专武数。');
      if (validN && parsed.copies-w.KU > (w.N<180?0:1+Math.floor((w.N-180)/160))) errors.push('潜能配置推算的赠品数超过当前抽数可到达的赠品节点。');
    }
    return errors;
  }

  /** Snapshot of exactly the fields used by the selected confirmation mode. */
  function makeWeaponConfirmation(weapon, enabled = hasWeaponProfile(weapon)) {
    const w = weaponForSave(weapon,enabled);
    return {N:w.N??null, K6:w.K6??null, KU:w.KU??null, lossDraws:w.lossDraws??null,
      profile:w.profile??null, potentialConfig:w.potentialConfig ? JSON.parse(JSON.stringify(w.potentialConfig)) : null};
  }

  function isWeaponConfirmed(weapon, saved, enabled) {
    if (!saved || typeof saved !== 'object' || !['N','K6','KU','profile'].every(key=>Object.hasOwn(saved,key))) return false;
    if (enabled !== undefined && typeof enabled !== 'boolean') return false;
    const mode = enabled ?? hasWeaponProfile(saved);
    if (validateWeapon(weaponForSave(weapon,mode),{requireProfile:mode}).length) return false;
    const current = makeWeaponConfirmation(weapon,mode);
    return snapshotFields.every(key=>JSON.stringify(current[key])===JSON.stringify(
      Object.hasOwn(saved,key)?saved[key]:null));
  }

  return Object.freeze({planningCountedLoss, planningOverview, planningOpportunityOverview, planningTitle, luckTitle, parseWeaponProfile, weaponConfigForForm, hasWeaponProfile, weaponForSave, validateWeapon, makeWeaponConfirmation, isWeaponConfirmed});
});
