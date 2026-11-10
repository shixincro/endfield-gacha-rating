'use strict';
(() => {
  const standalone = typeof module === 'object' && module.exports;
  const rules = standalone ? require('./character-edit.js') : window.CharacterEdit;
  const copy = value => JSON.parse(JSON.stringify(value));
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

  function manualEvent(source, character, position) {
    const event = {source, character, identitySource:'manual-supplement', identityReviewed:true, forced:false};
    if (position !== undefined) event.at = position;
    return event;
  }

  function extendQuota(character, pool, before, draws, newRush, six, five) {
    const received = draws + (newRush ? 10 : 0);
    if (five != null && !integer(five, 0, received - six)) {
      throw Error('新增五星数量须在0至' + (received - six) + '之间。');
    }
    if (five == null) {
      pool.manualSupplementFiveUnknown = true;
      // Keep the known prefix totals as evidence even when the extension has unknown rarity.
      if (pool.quota != null || character.quotaSummary) {
        pool.manualSupplementQuotaEvidence = {through:before, quota:pool.quota ?? null};
        if (character.quotaSummary) pool.manualSupplementQuotaEvidence.summary = copy(character.quotaSummary);
      }
      pool.quota = null;
      delete character.quotaSummary;
      return;
    }
    const delta = 20 * received + 1980 * six + 180 * five;
    if (Number.isSafeInteger(pool.quota)) pool.quota += delta;
    const summary = character.quotaSummary;
    if (summary && summary.scope === 'all-pools') {
      for (const [key, increment] of Object.entries({N:draws, R:Number(newRush), K6:six, Q:delta})) {
        if (Number.isSafeInteger(summary[key])) summary[key] += increment;
      }
    }
  }

  function extendFreePositions(character, pool, before) {
    if (!Array.isArray(pool.freeDrawPositions)) return;
    const previous = character.pools.find(item => item.index === pool.index - 1);
    const allowance = pool.freeAllowance ?? (Number.isSafeInteger(previous?.total)
      ? previous.total >= 60 ? 20 : 10 : pool.index === 0 ? 10 : null);
    if (allowance == null || pool.freeDrawPositions.length !== Math.min(before, allowance)) return;
    for (let at = before + 1; at <= Math.min(allowance, pool.total); at++) pool.freeDrawPositions.push(at);
  }

  function appendRecord(record, input) {
    const character = copy(record || {pools:[]});
    const index = input.index;
    if (!integer(index, 0, rules.BANNERS.length - 1)) throw Error('请选择限定池。');
    let pool = character.pools.find(item => item.index === index);
    if (!pool) {
      pool = rules.addPool(character, index);
      Object.assign(pool, {total:0, quota:0, rushUsed:false, tail:pool.initialPity, localTail:0, ended:true});
      if (input.opening != null) {
        if (!integer(input.opening, 0, 79)) throw Error('期初水位须为0至79的整数。');
        rules.setInitialPity(character, pool, input.opening);
      }
    }
    const before = pool.total;
    if (!integer(before, 0, 10000)) throw Error('请先在限定池识别结果中确认本池已有主抽数。');
    const draws = input.draws;
    const mode = input.rushMode ?? 'keep';
    if (!['keep', 'unused', 'empty', 'hits'].includes(mode)) throw Error('请选择有效的加急状态。');
    const newRush = mode === 'empty' || mode === 'hits';
    if (!integer(draws, 0, 10000 - before) || (!draws && !newRush)) {
      throw Error('请填写新增主抽数，本池累计不能超过10000抽。');
    }
    if ((newRush || mode === 'unused') && (pool.rushUsed || pool.rush?.length)) {
      throw Error('本池已有加急记录，每池加急只结算一次。');
    }
    const allowed = rules.candidates(pool);
    const main = input.main || [], rush = input.rush || [];
    if (!Array.isArray(main) || !Array.isArray(rush) || main.length > draws || rush.length > 10) {
      throw Error('新增六星数量超过本次抽数。');
    }
    let hasUp = pool.events.some(event => event.character === pool.up);
    const positions = new Set();
    for (const hit of [...main].sort((a,b) => a.offset - b.offset)) {
      if (!integer(hit.offset, 1, draws) || positions.has(hit.offset)) {
        throw Error('主池六星位置须填本次新增的第几抽，且每个位置只能填一次。');
      }
      if (!allowed.includes(hit.character)) throw Error('请选择本池可出的六星角色。');
      positions.add(hit.offset);
      const at = before + hit.offset;
      const event = manualEvent('main', hit.character, at);
      event.forced = at === 120 && !hasUp && hit.character === pool.up;
      hasUp ||= hit.character === pool.up;
      pool.events.push(event);
    }
    pool.total = before + draws;
    if (newRush) {
      if (!integer(input.rushAt, Math.max(30, before), pool.total)) {
        throw Error('加急使用时点须达到30主抽，且在本次补充的范围内。');
      }
      if ((mode === 'hits') !== (rush.length > 0) || rush.some(name => !allowed.includes(name))) {
        throw Error('请填写本次加急六星，或选择加急未出。');
      }
      pool.rushUsed = true;
      pool.rushAt = input.rushAt;
      pool.rushAtSource = 'manual-supplement';
      pool.rush = rush.map(name => manualEvent('rush', name));
    } else if (mode === 'unused') {
      rules.setRushUsed(pool, false);
    }
    if (input.five != null) {
      let previous = 0;
      let minimum = newRush && !rush.length ? 1 : 0;
      for (const position of positions) {
        minimum += Math.floor((position - previous - 1) / 10);
        previous = position;
      }
      minimum += Math.floor((draws - previous) / 10);
      if (input.five < minimum) throw Error('按十抽五星及以上保底，本次至少有' + minimum + '个五星。记不清可留空。');
    }
    if (pool.events.length === 0 && pool.initialPity == null && integer(pool.tail, 0, 79)) {
      rules.setTail(character, pool, pool.tail + draws);
    } else {
      rules.updatePoolWater(character, pool);
    }
    for (let at = (Math.floor(before / 240) + 1) * 240; at <= pool.total; at += 240) {
      (pool.tokens ??= []).push({at, source:'token', evidence:{inferredFrom:'manual-supplement-fixed-240-node'}});
    }
    extendFreePositions(character, pool, before);
    extendQuota(character, pool, before, draws, newRush, main.length + rush.length, input.five);
    pool.manualSupplementDraws = (pool.manualSupplementDraws || 0) + draws;
    pool.ended = true;
    const effective = rules.projectCharacter(character).character;
    const checked = effective.pools.find(item => item.index === index) || pool;
    const problem = rules.validatePool(checked, {allowMissingQuota:true});
    if (problem) throw Error(problem);
    const linkError = rules.validateLinks(character);
    if (linkError && linkError !== rules.validateLinks(record || {pools:[]})) throw Error(linkError);
    return character;
  }

  function invalidatesHypothesis(original, character) {
    const setting = original.scoringScenario;
    if (!setting?.enabled) return false;
    const findTarget = value => rules.projectCharacter(value).character.pools.at(-1);
    const before = findTarget(original.ledger.character);
    const after = findTarget(character);
    return after?.id !== setting.poolId || before?.id !== after?.id ||
      before?.total !== after?.total || before?.tail !== after?.tail;
  }

  if (standalone) {
    module.exports = {appendRecord, invalidatesHypothesis};
    return;
  }

  const dialog = $('manualSupplementDialog');
  const trigger = $('manualSupplement');
  const formRoot = el('div');
  formRoot.style.display = 'contents';
  dialog.append(formRoot);
  let draft = null;
  function blankDraft(index) {
    return {id:session.id, revision, index, draws:null, opening:null, five:null, main:[], rush:[], rushMode:'keep',
      rushAt:null, saving:false};
  }
  const current = state => state === draft && dialog.open && state?.id === session?.id && state.revision === revision;
  function closeStaleDraft(state) {
    if (draft === state && dialog.open) {
      state.saving = false;
      dialog.close();
      error('记录已更新，请重新打开手动补充记录。');
    }
  }
  function render() {
    const state = draft;
    const character = session.ledger.character || {pools:[]};
    const existing = character.pools.find(item => item.index === state.index);
    const before = existing ? existing.total : 0;
    const title = el('div', undefined, 'dialog-header');
    const heading = el('h2', '手动补充记录');
    heading.id = 'manualSupplementTitle';
    dialog.setAttribute('aria-labelledby', heading.id);
    title.append(heading);
    const content = el('div', undefined, 'dialog-scroll');
    const choices = rules.BANNERS.map((name, i) => {
      const found = character.pools.find(item => item.index === i);
      return [i, name + ' · ' + rules.LIMITED[i] + (found ? '（已有' + (found.total ?? '?') + '抽）' : '（新增卡池）')];
    });
    function label(name, input) {
      const wrapper = el('label', undefined, 'field');
      wrapper.append(el('span', name), input);
      return wrapper;
    }
    content.append(label('补充到哪个池', select(state.index, choices, value => {
      draft = blankDraft(Number(value)); render();
    })));
    if ((character.interruptionCorrection?.excludedIndices || []).includes(state.index)) {
      content.append(el('p', '本池已在中断修正中排除，补录明细将保存。', 'muted small'));
    }
    const remaining = el('p', '', 'muted small');
    const updateSummary = () => {
      remaining.textContent = '已有主抽 ' + (before ?? '?') + ' 抽 → 补充后 ' +
        (Number.isSafeInteger(before) ? before + (state.draws || 0) : '?') + ' 抽。截图顶部只校验图内部分。';
    };
    updateSummary();
    const meta = el('div', undefined, 'pool-meta');
    meta.append(field('新增主抽数', state.draws, value => {state.draws = value; updateSummary();}));
    if (!existing && state.index !== 0 && !character.pools.some(item =>
      item.index === state.index - 1 && Number.isSafeInteger(item.tail))) {
      meta.append(field('期初水位（未知可留空）',state.opening,value => {state.opening=value;}));
    }
    meta.append(field('新增五星数（含本次加急，选填）',state.five,value => {state.five=value;}));
    content.append(meta, remaining);
    content.append(el('p','五星数留空时只缺五星分，以后可在限定池识别结果补齐累计配额。','muted small'));
    const allowed = rules.candidates({up:rules.LIMITED[state.index]});
    const nameChoices = [['', '选择角色'], ...allowed.map(name => [name, name])];
    content.append(el('h3', '本次主池六星'));
    for (const [i, hit] of state.main.entries()) {
      const row = el('div', undefined, 'pool-meta');
      row.append(field('新增段第几抽', hit.offset, value => {hit.offset = value;}),
        label('六星角色', select(hit.character, nameChoices, name => {hit.character = name;})),
        button('移除', () => {state.main.splice(i,1); render();}));
      content.append(row);
    }
    content.append(button('添加主池六星', () => {state.main.push({offset:null,character:''}); render();}));
    if (existing?.rushUsed === true) {
      content.append(el('p', '本池加急已记录。', 'muted small'));
    } else {
      const options = [['keep','无新增加急'], ['empty','新增加急 · 未出六星'], ['hits','新增加急 · 有六星']];
      if (existing && existing.rushUsed == null) options.push(['unused','确认本池未使用加急']);
      content.append(label('加急十连', select(state.rushMode, options, value => {
        state.rushMode = value;
        state.rush = value === 'hits' ? [''] : [];
        state.rushAt = Math.max(30, before || 0);
        render();
      })));
      if (state.rushMode === 'hits' || state.rushMode === 'empty') {
        content.append(field('加急在本池累计第几抽后使用',state.rushAt,value => {state.rushAt=value;}));
      }
      if (state.rushMode === 'hits') {
        state.rush.forEach((name, i) => {
          const row = el('div', undefined, 'pool-meta');
          row.append(label('加急六星', select(name,nameChoices,value => {state.rush[i]=value;})),
            button('移除', () => {state.rush.splice(i,1); render();}));
          content.append(row);
        });
        content.append(button('添加加急六星', () => {if (state.rush.length < 10) state.rush.push(''); render();}));
      }
    }
    const issue = el('p', '', 'dialog-error');
    issue.setAttribute('role','alert'); issue.hidden=true;
    const footer = el('div', undefined, 'dialog-footer');
    const actions = el('div', undefined, 'actions');
    const cancel = button('取消', () => {if (!state.saving) dialog.close();});
    const save = button('保存补充记录', async () => {
      if (!current(state)) {closeStaleDraft(state); return;}
      if (state.saving) return;
      issue.hidden = true;
      const candidate = clone(session);
      try {
        candidate.ledger.character = appendRecord(session.ledger.character, state);
        const cleared = invalidatesHypothesis(session, candidate.ledger.character);
        if (cleared) candidate.scoringScenario = {enabled:false};
        candidate.revision = state.revision + 1;
        state.saving = true; cancel.disabled = true; save.disabled = true;
        save.textContent = '正在保存…';
        for (const input of content.querySelectorAll('input,select,button')) input.disabled = true;
        const saved = await api('/api/score', {session:candidate, expectedRevision:state.revision});
        if (!current(state)) {closeStaleDraft(state); return;}
        dialog.close();
        loadSession(saved);
        status(cleared ? '已保存补充记录，原假设保底需按新记录重新设置。' : '已保存补充记录。');
      } catch (err) {
        if (!current(state)) {closeStaleDraft(state); return;}
        issue.textContent = err.message; issue.hidden = false;
        state.saving = false; cancel.disabled = false; save.disabled = false;
        save.textContent = '保存补充记录';
        for (const input of content.querySelectorAll('input,select,button')) input.disabled = false;
      }
    });
    save.className = 'primary';
    actions.append(cancel, save); footer.append(issue, actions);
    formRoot.replaceChildren(title, content, footer);
  }
  trigger.onclick = () => {
    if (!session || busy || restoring || historyDeleting || scoreSettingPending()) return;
    const pools = session.ledger.character?.pools || [];
    draft = blankDraft(pools.at(-1)?.index ?? 0);
    render(); openDialog('manualSupplementDialog');
  };
  dialog.addEventListener('close', () => {draft = null;});
  dialog.addEventListener('cancel', event => {if (draft?.saving) event.preventDefault();});
})();
