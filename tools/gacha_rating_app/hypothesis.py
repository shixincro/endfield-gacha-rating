"""Read-only, explicitly hypothetical extensions using the existing scorers."""
from __future__ import annotations

import copy

from importer import _legal_pool_characters, issue, revalidate_current_ledger
from service import reject_hypothetical_ledger, score_ledger, unscored

MODES = ('first-up-120', 'next-six-80')
THREE_AXES = ('characterSix', 'up', 'limited')


def _integer(value, low=0, high=2**53 - 1):
    return type(value) is int and low <= value <= high


def _prepare(documents, ledger, pool_id, mode, *, reviewed=False):
    reject_hypothetical_ledger(ledger)
    if mode not in MODES:
        raise ValueError('请选择补到首个UP的120保底，或补到下一次六星保底。')
    current = revalidate_current_ledger(documents, ledger, reviewed=reviewed)
    from history_interruption import project_ledger, refresh_projected_mechanics
    current, correction = project_ledger(current)
    if correction['enabled']:
        refresh_projected_mechanics(current)
    pools = current.get('character', {}).get('pools', [])
    selected = [pool for pool in pools if pool.get('id') == pool_id]
    if len(selected) != 1:
        raise ValueError('未找到要追加假设的卡池，请重新打开记录。')
    pool = selected[0]
    if pool is not max(pools, key=lambda row:row['index']):
        raise ValueError('假设补抽仅支持当前记录中最后一个卡池，避免改变后续实际抽卡历史。')
    if pool.get('complete') is False:
        raise ValueError('当前池记录存在缺段，请先补齐本池出货记录再确定保底位置。')
    total, pity = pool.get('total'), pool.get('tail')
    if not _integer(total, 0, 10000):
        raise ValueError('请先补齐当前池的主池总抽数。')
    if not _integer(pity, 0, 79):
        raise ValueError('请先补齐当前池期末水位（0—79）；未知水位不能猜测保底位置。')
    blockers = [entry for entry in pool.get('issues', []) if entry.get('severity') == 'error'
                and (not entry.get('axes') or set(entry['axes']) & set(THREE_AXES))]
    if blockers:
        raise ValueError('请先修正当前池记录：'+blockers[0].get('message', '出货或水位尚未确认。'))
    has_up = any(event.get('character') == pool['up'] for event in pool.get('events', []))
    if mode == 'first-up-120':
        if has_up:
            raise ValueError('主池已经获得过当期UP，首个UP的120保底已解除。')
        if total >= 120:
            raise ValueError('当前池已达到120抽，请先核对首个主池UP记录。')
    notices = ['只追加假设主池抽取；原记录、加急使用状态和原始图片均不改变。',
               '这是指定结果的对比，不是预测未来一定会发生的抽卡结果。']
    allowed = sorted(_legal_pool_characters(pool['banner']))
    deadline = 120 if not has_up and total < 120 else None
    next_six = total + 80 - pity
    if mode == 'first-up-120':
        target = 120
        events = []
        while next_six < target:
            events.append({'at':next_six, 'character':None, 'forced':False, 'requiredChoice':True,
                           'allowedCharacters':[name for name in allowed if name != pool['up']],
                           'kind':'eighty-guarantee'})
            next_six += 80
        events.append({'at':120, 'character':pool['up'], 'forced':True, 'requiredChoice':False,
                       'allowedCharacters':[pool['up']], 'kind':'first-up-120'})
        if len(events) > 1:
            notices.append('到120前先触发的80保底必须补录；为保留首UP120情形，前置六星只能选择非当期UP。')
    else:
        forced = deadline is not None and deadline <= next_six
        target = deadline if forced else next_six
        events = [{'at':target, 'character':pool['up'] if forced else None, 'forced':forced,
                   'requiredChoice':not forced, 'allowedCharacters':[pool['up']] if forced else allowed,
                   'kind':'first-up-120' if forced else 'eighty-guarantee'}]
        if forced:
            notices.append('首个UP的120保底早于或等于下一次80保底，因此在第120抽先取得当期UP。')
        elif deadline is not None:
            notices.append('若这次六星选择当期UP，首UP120保底随即解除，不会再追加第120抽强制UP。')
    if target > 10000:
        raise ValueError('假设追加后超过单池10000抽的记录上限。')
    previous, minimum_five = total, 0
    for event in events:
        minimum_five += (event['at']-previous-1)//10
        previous = event['at']
    minimum_five += (target-previous)//10
    plan = {'hypothesis':True, 'poolId':pool['id'], 'banner':pool['banner'], 'up':pool['up'],
            'mode':mode, 'fromTotal':total, 'toTotal':target, 'addedDraws':target-total,
            'fromPity':pity, 'toPity':0, 'hasMainUp':has_up, 'firstUpDeadline':deadline,
            'events':events, 'additionalFiveMin':minimum_five, 'additionalFiveMax':target-total-len(events)}
    return current, pool, plan, notices, correction


def plan_hypothesis(documents, ledger, pool_id, mode, *, reviewed=False):
    _, _, plan, notices, _ = _prepare(documents, ledger, pool_id, mode, reviewed=reviewed)
    return {'plan':plan, 'notices':notices}


def preview_hypothesis(documents, ledger, pool_id, mode, *, choices=None, additional_five=None, reviewed=False):
    baseline, _, plan, notices, correction = _prepare(documents, ledger, pool_id, mode, reviewed=reviewed)
    if choices is None:
        choices = {}
    if not isinstance(choices, dict) or any(key not in {str(event['at']) for event in plan['events']} for key in choices):
        raise ValueError('假设角色选择包含计划之外的出货位置，请重新生成计划。')
    if additional_five is not None and not _integer(additional_five, plan['additionalFiveMin'], plan['additionalFiveMax']):
        raise ValueError(f"追加五星数须为{plan['additionalFiveMin']}至{plan['additionalFiveMax']}的整数（含十抽五星及以上保底），未知时留空。")
    for event in plan['events']:
        selected = choices.get(str(event['at']), event['character'])
        if selected not in event['allowedCharacters']:
            if mode == 'first-up-120' and selected == plan['up'] and event['at'] < 120:
                raise ValueError('前置六星若已获得当期UP，首UP120保底就会解除；不能同时假设先UP再首UP120。')
            raise ValueError(f"请为第{event['at']}抽选择本计划允许的六星角色。")
        event['character'] = selected
    before = score_ledger(baseline)
    # The prepared view no longer contains excluded pools. Preserve the scope
    # audit derived from the original ledger, not from a twice-filtered view.
    before['interruptionCorrection'] = copy.deepcopy(correction)
    simulated = copy.deepcopy(baseline)
    character = simulated['character']
    pool = next(row for row in character['pools'] if row['id'] == pool_id)
    pool['total'] = plan['toTotal']
    pool['tail'] = pool['localTail'] = 0
    pool['ended'] = True
    notices.append('假设在本次保底位置停手，补抽后的规划分按已停手状态结算。')
    planning_before = next((row for row in before.get('planning', {}).get('pools', []) if row.get('id') == pool_id), {})
    free = planning_before.get('freeAllowance')
    if isinstance(pool.get('freeDrawPositions'), list) and free in (0, 10, 20):
        remaining = min(plan['addedDraws'], max(free-len(pool['freeDrawPositions']), 0))
        if remaining:
            pool['freeDrawPositions'].extend(range(plan['fromTotal']+1, plan['fromTotal']+remaining+1))
            notices.append('假设追加抽取先使用本池尚未用完的限时免费抽。')
    for event in plan['events']:
        pool['events'].append({'at':event['at'], 'character':event['character'], 'forced':event['forced'],
                               'source':'main', 'identitySource':'manual-hypothesis', 'hypothesis':True})
    existing_tokens = {event['at']:event for event in pool.get('tokens', [])}
    pool['tokens'] = [existing_tokens.get(at) or {'at':at, 'source':'token', 'hypothesis':True,
                     'evidence':{'inferredFrom':'hypothetical-total-fixed-240-node'}}
                     for at in range(240, pool['total']+1, 240)]
    five_reason = None
    baseline_counts = before.get('character', {}).get('counts', {})
    known_empty_quota = (baseline_counts.get('total') == 0 and baseline_counts.get('five') == 0
                         and baseline_counts.get('quota') == 0 and character.get('quotaSummary') is None)
    if additional_five is None:
        five_reason = '假设追加抽取的五星数量未知；本次未模拟五星，五星分不作比较。'
    elif before['axes']['five'].get('score') is None and not known_empty_quota:
        five_reason = '原记录的武库配额或五星统计尚未验证，无法据此计算假设后的五星分。'
    if five_reason:
        pool['quota'] = None
        character.pop('quotaSummary', None)
        character.setdefault('issues', []).append(issue('hypothesis_five_unknown', five_reason, 'error', ['five']))
        notices.append(five_reason)
    else:
        delta = 20*plan['addedDraws'] + 1980*len(plan['events']) + 180*additional_five
        if _integer(pool.get('quota')):
            pool['quota'] += delta
        summary = character.get('quotaSummary')
        if summary is not None:
            summary['Q'] += delta
            summary['N'] += plan['addedDraws']
            summary['K6'] += len(plan['events'])
        plan['additionalQuota'] = delta
        notices.append(f'按追加{additional_five}个五星计算新增武库配额{delta}；原记录配额保持不变。')
    # Refresh edited pool mechanics while retaining exactly the baseline
    # source conflicts. A hypothetical extension cannot contradict its old
    # screenshot header, and must not waive a conflict already present there.
    simulated = revalidate_current_ledger(documents, simulated, reviewed=True)
    simulated['issues'] = copy.deepcopy(baseline.get('issues', []))
    simulated['hypothesis'] = {'poolId':pool_id, 'mode':mode, 'addedDraws':plan['addedDraws'],
                               'additionalFive':additional_five, 'persistable':False}
    after = score_ledger(simulated)
    after['interruptionCorrection'] = copy.deepcopy(correction)
    if five_reason:
        after['axes']['five'] = unscored(five_reason)
        after['character']['axes']['five'] = unscored(five_reason)
        after['scoredAxes'] = sum(axis.get('score') is not None for axis in after['axes'].values())
    after['hypothesis'] = copy.deepcopy(simulated['hypothesis'])
    plan['additionalFive'] = additional_five
    return {'plan':plan, 'before':before, 'after':after, 'notices':notices}
