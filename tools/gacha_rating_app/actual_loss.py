"""Compare settled character pulls with a reference anchored to actual history."""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
import math

from importer import BANNERS

VERSION = 'observed-loss-v2.3'
DEFAULT_STANDARD_VALUE = 15
LIMITED_VALUE = 51.66
STANDARD = {'骏卫', '黎风', '别礼', '余烬', '艾尔黛拉'}
LIMITED = set(BANNERS.values())
SCHEDULE = tuple(BANNERS.items())
RUSH_AFTER_MAIN = 30


def valid_standard_value(value):
    return type(value) in (int, float) and 0 <= value <= 10000 and math.isfinite(value)


def integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


@dataclass(frozen=True)
class Draw:
    pool: int
    at: int
    kind: str
    voucher_pool: int | None = None

    @property
    def origin(self):
        return self.voucher_pool if self.kind == 'voucher' else self.pool


def split_value(value, weights, fallback, kind):
    """Attribute one value once, proportionally to the contributing water."""
    if not value:
        return []
    if not weights:
        weights = {fallback: 1}
    total = sum(weights.values())
    parts = []
    remainder = value
    for i, (pool, weight) in enumerate(weights.items(), 1):
        amount = remainder if i == len(weights) else value * weight / total
        parts.append({'poolIndex': pool, 'value': amount, 'kind': kind})
        remainder -= amount
    return parts


def first_up_attribution(quote, pool, voucher_pool, free_at, opening_draws):
    paid = Counter(d.pool for d in opening_draws if d.kind == 'paid' and quote['priorPaid'])
    water = Counter(d.origin for d in opening_draws
                    if d.kind == 'voucher' or (d.kind == 'paid' and quote['priorPaid']))
    voucher_credit = sum(at <= quote['at'] and kind == 'voucher' for at, kind in free_at.items())
    # The spend required through the same main draw cancels on both sides.
    # Vouchers reduce what that stop costs; water changes the stop itself.
    water_saving = quote['referencePaid'] - quote['actualPaid'] - voucher_credit
    parts = [{'poolIndex': origin, 'value': count, 'kind': 'paid'}
             for origin, count in paid.items() if count]
    parts += split_value(-voucher_credit, {voucher_pool: 1}, pool, 'voucher')
    parts += split_value(-water_saving, water if water_saving >= 0 else {}, pool, 'water')
    parts += split_value(-quote['characterValue'], water, pool, 'character')
    return parts


def source_error(pool, free, opening):
    idx, total, up = (pool.get(key) for key in ('index', 'total', 'up'))
    if not integer(idx, 0, len(SCHEDULE) - 1) or (pool.get('banner'), up) != SCHEDULE[idx]:
        return '本池规则未核实，无法按常规限定池还原。'
    if not integer(total, 0, 10000) or pool.get('complete') is False:
        return '主池抽数或出货记录不完整。'
    if free not in (0, 10, 20) or type(free) is not int:
        return '本池免费额度未知。'
    if any(isinstance(issue, dict) and issue.get('severity') == 'error'
           and (not issue.get('axes') or set(issue['axes']) & {'characterSix', 'up', 'planning'})
           for issue in pool.get('issues') or []):
        return '主池记录存在冲突。'
    events = pool.get('events')
    if not isinstance(events, list) or any(
            not isinstance(hit, dict) or hit.get('source', 'main') != 'main'
            or not integer(hit.get('at'), 1, total)
            or not isinstance(hit.get('character'), str)
            or hit['character'] not in STANDARD | LIMITED for hit in events):
        return '主池六星的出货位置或身份未知。'
    previous, saw_up = 0, False
    for hit in sorted(events, key=lambda h: h['at']):
        at = hit['at']
        if (at == previous or (not saw_up and (at > 120 or at == 120 and hit['character'] != up))
                or at - previous + ((opening or 0) if previous == 0 else 0) > 80
                or hit.get('forced') is True and (saw_up or at != 120 or hit['character'] != up)):
            return '主池出货与六星水位或首 UP 保底冲突。'
        previous = at
        saw_up |= hit['character'] == up
    if not saw_up and total >= 120:
        return '主池达到 120 抽但未确认首 UP。'
    tail = total - previous + ((opening or 0) if previous == 0 else 0)
    if tail >= 80 or pool.get('tail') is not None and (previous or opening is not None) and pool['tail'] != tail:
        return '主池尾水与出货记录冲突。'
    tokens = pool.get('tokens', [])
    if (not isinstance(tokens, list) or any(not isinstance(token, dict) for token in tokens)
            or sorted(token.get('at', -1) for token in tokens if type(token.get('at')) is int)
            != list(range(240, total + 1, 240))
            or len(tokens) != total // 240):
        return '信物节点不完整。'
    free_positions = pool.get('freeDrawPositions')
    if free_positions is not None and (
            not isinstance(free_positions, list)
            or any(not integer(at, 1, total) for at in free_positions)
            or len(set(free_positions)) != len(free_positions)
            or len(free_positions) != min(total, free)):
        return '免费抽位置与本池额度冲突。'
    return None


def rush_hit_position(pool):
    """Place recorded rush hits immediately after main draw #30."""
    rush, used = pool.get('rush', []), pool.get('rushUsed')
    if not isinstance(rush, list) or (used is not True and rush):
        return None, '加急使用状态和出货冲突。'
    if used is True and pool['total'] < RUSH_AFTER_MAIN:
        return None, '主池未达30抽但记录加急已使用。'
    if any(not isinstance(hit, dict) or not isinstance(hit.get('character'), str)
           or hit['character'] not in STANDARD | LIMITED for hit in rush):
        return None, '加急六星身份未知。'
    if used is None and pool['total'] >= RUSH_AFTER_MAIN:
        return None, '加急是否使用未知。'
    return (RUSH_AFTER_MAIN if rush else None), None


def free_draws(pool, allowance, voucher):
    positions = pool.get('freeDrawPositions')
    if positions is None:
        positions = range(1, min(pool['total'], allowance) + 1)
    else:
        positions = sorted(positions)
    ordinary = max(0, allowance - 10) if allowance == 20 else allowance
    return {at: (voucher if number >= ordinary else 'common')
            for number, at in enumerate(positions)}


def first_up_quote(hits, up, common_free, free_at, opening_draws, standard_value, new):
    """Shift the observed natural events until the reference first UP or #120."""
    target = hits[-1]['at']
    first = hits[0]
    prior_paid = sum(draw.kind == 'paid' for draw in opening_draws)
    voucher_water = sum(draw.kind == 'voucher' for draw in opening_draws)
    shift = prior_paid + voucher_water
    last_off = hits[-2] if len(hits) > 1 else None
    reference = min(120, target + shift)
    extra = last_off is not None and last_off['at'] + shift >= 120

    def paid_to(at, reference_path):
        if not reference_path:
            free_count = sum(pos <= at for pos in free_at)
        else:
            free_count = sum(pos <= at and kind != 'voucher' for pos, kind in free_at.items())
            # Legacy records use free first. If a stop is projected past the
            # observations, common unused free draws are used before paid draws.
            unused_common = max(0, common_free - sum(kind != 'voucher' for kind in free_at.values()))
            observed = max(free_at, default=0)
            free_count += min(unused_common, max(0, at - observed))
        return at - free_count

    actual_paid = paid_to(target, False)
    reference_paid = paid_to(reference, True)
    cost = prior_paid + actual_paid - reference_paid
    if not extra and first['character'] in LIMITED and first['character'] != up:
        # The inherited paid path already earned a limited character. Its
        # draws are common to both paths for the ordinary first-UP comparison.
        reference = min(120, target + voucher_water)
        reference_paid = paid_to(reference, True)
        cost = actual_paid - reference_paid
        prior_paid = 0
    value, gain = cost, 0
    reason = '首 UP 自费差'
    if extra:
        if last_off['character'] in STANDARD:
            gain = standard_value
            reason = '首 UP 前额外常驻'
        else:
            if new is None:
                return None
            k = 1 if new else 0.5
            gain = min(max(cost, 0), LIMITED_VALUE) + k * max(0, LIMITED_VALUE - max(cost, 0))
            reason = '首 UP 前额外歪限定'
        value = cost - gain
    return {'at': target, 'type': reason, 'value': value, 'permanentDelta': cost,
            'characterValue': gain, 'priorPaid': prior_paid, 'actualPaid': actual_paid,
            'referencePaid': reference_paid, 'referenceAt': reference,
            'extraCharacter': last_off['character'] if extra else None}


def score_actual_loss(character):
    """Settle independent stages and keep the provenance of real trailing water."""
    standard_value = character.get('actualLossStandardValue', DEFAULT_STANDARD_VALUE)
    if not valid_standard_value(standard_value):
        standard_value = DEFAULT_STANDARD_VALUE
    result = {'version': VERSION, 'standardValue': standard_value, 'pools': []}
    previous = None
    tail, tail_water = [], None
    previous_voucher = 'unknown'
    owned = set(character.get('initialOwned') or [])
    catalog_known = isinstance(character.get('initialOwned'), list)

    for pool in character.get('pools', []):
        # score_planning validates pool shape and sort order before calling us.
        idx, total, up = (pool.get(key) for key in ('index', 'total', 'up'))
        previous_index = previous.get('index') if previous else None
        adjacent = (not pool.get('interruptionBefore') and type(idx) is int
                    and type(previous_index) is int and idx == previous_index + 1)
        zero_gap = (not pool.get('interruptionBefore') and character.get('completeHistory') is True
                    and type(idx) is int and type(previous_index) is int and idx > previous_index + 1)
        if not (adjacent or zero_gap):
            tail, tail_water = [], None
            if previous is not None:
                catalog_known = False
        if pool.get('interruptionBefore'):
            catalog = pool.get('interruptionCatalog') or {}
            owned.update(catalog.get('ownedSixStars', []))
            catalog_known = catalog.get('catalogComplete') is True

        opening = pool.get('initialPity')
        if opening is None:
            opening = tail_water
        if opening is None and previous is None:
            opening = character.get('initialPity')
        if opening is None and idx == 0:
            opening = 0
        free = pool.get('freeAllowance')
        voucher = 'common' if idx == 0 or zero_gap else 'unknown'
        if adjacent and type(previous.get('total')) is int:
            voucher = previous_voucher
            if free is None:
                free = 20 if previous['total'] >= 60 else 10
        if free is None and (idx == 0 or zero_gap):
            free = 10
        if pool.get('interruptionBefore'):
            voucher = 'unknown'
        row = {'id': pool.get('id'), 'poolIndex': idx, 'banner': pool.get('banner'),
               'settlements': [], 'warnings': [], 'pending': False}
        result['pools'].append(row)
        error = source_error(pool, free, opening if integer(opening, 0, 79) else None)
        if opening is not None and not integer(opening, 0, 79):
            error = '期初水位无效。'
        if tail_water is not None and opening != tail_water:
            error = '期初水位与上期尾水冲突。'
        previous, previous_voucher = pool, 'unknown'
        if error:
            row['warnings'].append(error)
            tail, tail_water = [Draw(-1, 0, 'unknown')], None
            catalog_known = False
            continue
        if opening is None:
            tail.append(Draw(-1, 0, 'unknown-water'))

        hits = sorted(pool['events'], key=lambda hit: hit['at'])
        first_up = next((hit['at'] for hit in hits if hit['character'] == up), None)
        rush_hit_at, rush_error = rush_hit_position(pool)
        # A pool that obtained its main UP uses the main-pool checkpoints.
        # The rush still contributes to actual ownership order, never pity.
        rush_at = (rush_hit_at if first_up is None and rush_hit_at is not None
                   and any(hit['character'] in LIMITED for hit in pool.get('rush', [])) else None)
        if rush_error and (first_up is None or any(
                hit['at'] > first_up and hit['character'] in STANDARD for hit in hits) or any(
                isinstance(hit, dict) and hit.get('character') != up
                and hit.get('character') in LIMITED for hit in pool.get('rush') or [])):
            row['warnings'].append(rush_error)
        free_at = free_draws(pool, free, voucher)
        voucher_pool = previous_index if voucher == 'voucher' and adjacent else None
        common_free = 10 if free == 20 and voucher != 'common' else free
        if total >= 60:
            anchors = [hit['at'] for hit in hits if hit['character'] in LIMITED]
            anchors.extend(token['at'] for token in pool.get('tokens', []))
            if rush_at is not None:
                anchors.append(rush_at)
            # Use all originally available free draws in the stop strategy.
            # With explicit late free pulls, only paid continuation can make #60 incremental.
            normal = max(anchors, default=0)
            free_through_60 = sum(normal < pos <= 60 for pos in free_at)
            previous_voucher = ('common' if normal >= 60 or free_through_60 >= 60 - normal else
                                'unknown' if rush_error else 'voucher')

        # Track ownership at the observed time, even for the earlier hits
        # used by the reference only to advance its natural waiting clock.
        ownership = {}
        rush_hits = [(rush_hit_at, hit['character']) for hit in pool.get('rush', [])
                     if rush_hit_at is not None]
        if rush_error:
            catalog_known = False
        for at, source, name in sorted(
                [(hit['at'], 0, hit['character']) for hit in hits] +
                [(at, 1, name) for at, name in rush_hits]):
            ownership[(at, source)] = False if name in owned else True if catalog_known else None
            owned.add(name)
        if pool.get('rushUsed') is True:
            owned.update(hit['character'] for hit in pool['rush'] if isinstance(hit, dict)
                         and isinstance(hit.get('character'), str))

        def settle(at, reason, paid, saved=0):
            delta = sum(paid.values()) - saved
            allocations = [{'poolIndex': origin, 'value': count, 'kind': 'paid'}
                           for origin, count in paid.items()]
            allocations += split_value(-saved, {voucher_pool: 1}, idx, 'voucher')
            row['settlements'].append({'at': at, 'type': reason, 'value': delta,
                                       'permanentDelta': delta, 'characterValue': 0,
                                       'allocations': allocations})

        initial_draws = tail.copy()
        current_path = tail
        standard_paths = []
        vouchers_since_anchor = 0
        paid_since_anchor = False
        unknown_vouchers = False
        event_at = {hit['at']: hit for hit in hits}
        tokens_at = {token['at'] for token in pool.get('tokens', [])}
        last_limited = max((hit['at'] for hit in hits if hit['character'] in LIMITED), default=0)

        def acknowledge(at, reason):
            nonlocal vouchers_since_anchor, paid_since_anchor, unknown_vouchers
            # A free-only hit after an UP does not establish that the player
            # would have chased another copy with paid draws.
            paid_target = paid_since_anchor or at in tokens_at
            if unknown_vouchers and paid_target:
                row['warnings'].append('该结算点的赠券来源无法核实。')
            inherited = Counter(draw.pool for path in standard_paths for draw in path
                                if draw.kind == 'paid' and draw.pool != idx)
            unknown = any(draw.kind == 'unknown' for path in standard_paths for draw in path)
            if unknown:
                row['warnings'].append('先前常驻路径的自费来源无法核实。')
            settle(at, reason, inherited, vouchers_since_anchor if paid_target else 0)
            standard_paths.clear()
            current_path.clear()  # protected real water stays in tail_water
            vouchers_since_anchor = 0
            paid_since_anchor = False
            unknown_vouchers = False

        for at in range(1, total + 1):
            kind = free_at.get(at, 'paid')
            if kind != 'common':
                current_path.append(Draw(idx, at, kind, voucher_pool if kind == 'voucher' else None))
            vouchers_since_anchor += kind == 'voucher'
            paid_since_anchor |= kind == 'paid'
            unknown_vouchers |= kind == 'unknown'
            hit = event_at.get(at)
            if hit is not None:
                path, current_path = current_path, []
                name = hit['character']
                if name in STANDARD:
                    standard_paths.append(path)
                if at == first_up:
                    before_up = [h for h in hits if h['at'] <= at]
                    last = before_up[-2] if len(before_up) > 1 else None
                    if unknown_vouchers or any(draw.kind in {'unknown', 'unknown-water'}
                                               for draw in initial_draws):
                        row['warnings'].append('首 UP 的继承水位或赠券来源无法核实。')
                    else:
                        quote = first_up_quote(before_up, up, common_free, free_at, initial_draws,
                                               standard_value, ownership.get((last['at'], 0)) if last else None)
                        if quote is None:
                            row['warnings'].append('额外歪限定的 New 状态未知。')
                        else:
                            quote['allocations'] = first_up_attribution(
                                quote, idx, voucher_pool, free_at, initial_draws)
                            row['settlements'].append(quote)
                    standard_paths.clear()
                    vouchers_since_anchor = 0
                    paid_since_anchor = False
                    unknown_vouchers = False
                elif name == up:
                    acknowledge(at, '主池后续 UP')
                elif at == last_limited:
                    acknowledge(at, '歪限定后停手')
            if at in tokens_at:
                acknowledge(at, '信物保护水位')
            if at == rush_at:
                acknowledge(at, '加急限定')

        if not rush_error:
            for path in standard_paths:
                if any(draw.kind == 'unknown' for draw in path):
                    row['warnings'].append('常驻路径的自费来源无法核实。')
                else:
                    settle(total, '常驻后停手', Counter(draw.pool for draw in path if draw.kind == 'paid'))
        row['pendingPaid'] = sum(draw.kind == 'paid' for draw in current_path)
        row['pendingVouchers'] = sum(draw.kind == 'voucher' for draw in current_path)
        row['pending'] = any(draw.kind in {'paid', 'voucher', 'unknown'} for draw in current_path)
        tail = current_path
        if hits:
            tail_water = total - hits[-1]['at']
        elif opening is not None:
            tail_water = opening + total
        else:
            tail_water = pool.get('tail') if integer(pool.get('tail'), 0, 79) else None
        row['tailWater'] = tail_water

    return summarize(result)


def summarize(result):
    # Keep the real checkpoint once, then group the same amounts by source
    # for the pool cards. Regenerate on every pass, including after validation
    # discards settlements because of source conflicts.
    rows = result['pools']
    by_index = {row['poolIndex']: row for row in rows if type(row.get('poolIndex')) is int}
    for row in rows:
        row['attributedSettlements'] = []
    for row in rows:
        for part in row['settlements']:
            grouped = defaultdict(list)
            for allocation in part.get('allocations') or ():
                source = by_index.get(allocation['poolIndex'], row)
                grouped[source.get('poolIndex')].append(allocation)
            if not grouped:
                grouped[row.get('poolIndex')] = [{'value': part['value'], 'kind': 'original'}]
            for source_index, allocations in grouped.items():
                source = by_index.get(source_index, row)
                value = round(math.fsum(x['value'] for x in allocations), 8)
                voucher = -math.fsum(x['value'] for x in allocations if x['kind'] == 'voucher')
                character_value = -math.fsum(x['value'] for x in allocations if x['kind'] == 'character')
                if not value and not voucher and not character_value and source is not row:
                    continue
                view = {key: val for key, val in part.items() if key != 'allocations'}
                view.update(value=value, settledPoolId=row['id'], settledBanner=row.get('banner'),
                            permanentDelta=round(value+character_value, 8),
                            characterValue=character_value, voucherCredit=voucher,
                            extraCharacter=part.get('extraCharacter') if character_value else None)
                if all(x['kind'] == 'voucher' for x in allocations):
                    view['type'] = '赠券抵扣'
                source['attributedSettlements'].append(view)

    known, partial = False, 0
    for row in result['pools']:
        entries = row['attributedSettlements']
        row['value'] = (round(math.fsum(part['value'] for part in entries), 8)
                        if entries or not row['warnings'] else None)
        known |= row['value'] is not None
        partial += bool(row['warnings'])
    result['total'] = round(math.fsum(part['value'] for row in rows for part in row['settlements']), 8) if known else None
    result['partialPools'] = partial
    result['pending'] = bool(rows and rows[-1]['pending'])
    return result
