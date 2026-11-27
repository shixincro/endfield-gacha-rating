"""Compare settled character pulls with a reference anchored to actual history."""
from __future__ import annotations

from collections import Counter, defaultdict
from functools import lru_cache
from itertools import accumulate
import math

from importer import BANNERS
from opportunity import FIRST_UP, FULL_POTENTIAL_COPIES, p6

VERSION = 'observed-loss-quantile-v3.0'
DEFAULT_STANDARD_VALUE = 15
LIMITED_VALUE = 51.66
STANDARD = {'骏卫', '黎风', '别礼', '余烬', '艾尔黛拉'}
LIMITED = set(BANNERS.values())
SCHEDULE = tuple(BANNERS.items())
RUSH_AFTER_MAIN = 30


def off_candidates(index):
    """The two off-banner limited identities in the ordinary pool schedule."""
    if index == 0:
        positions = (1, 2)
    elif index == 1:
        positions = (0, 2)
    else:
        positions = (index - 1, index - 2)
    return tuple(SCHEDULE[position][1] for position in positions)


def eligible_off_count(index, copies):
    """Only a confirmed full-potential identity stops counting as limited."""
    owned = dict(copies)
    return sum(owned.get(name, 0) < FULL_POTENTIAL_COPIES
               for name in off_candidates(index))


@lru_cache(maxsize=4096)
def completion_pmf(pity, eligible_off=0, *, start=0, rush=True):
    """First target at absolute main draw 1..120, before the guarantee is used."""
    if not (0 <= pity < 80 and 0 <= start < FIRST_UP and 0 <= eligible_off <= 2):
        raise ValueError('invalid first target state')
    target = 0.5 + eligible_off / 14
    rush_hit = 1 - (1 - 0.008 * target) ** 10
    alive = [0.0] * 80
    alive[pity] = 1.0
    pmf = [0.0] * FIRST_UP
    for at in range(start + 1, FIRST_UP):
        sixes = math.fsum(mass * p6(water) for water, mass in enumerate(alive))
        pmf[at - 1] = sixes * target
        alive = [sixes * (1 - target)] + [
            mass * (1 - p6(water)) for water, mass in enumerate(alive[:-1])
        ]
        if rush and at == RUSH_AFTER_MAIN:
            pmf[at - 1] += math.fsum(alive) * rush_hit
            alive = [mass * (1 - rush_hit) for mass in alive]
    pmf[-1] = math.fsum(alive)
    return tuple(pmf)


@lru_cache(maxsize=8192)
def expected_paid(pity, free, eligible_off=0, *, start=0, rush=True):
    """Expected permanent draws after start, with an absolute free allowance."""
    paid_at_start = max(start - free, 0)
    return math.fsum(
        (max(at - free, 0) - paid_at_start) * mass
        for at, mass in enumerate(completion_pmf(pity, eligible_off, start=start, rush=rush), 1)
        if mass
    )


def _overlap_quantiles(actual, reference, at):
    if not 1 <= at <= len(actual) or actual[at - 1] <= 0:
        return ()
    if actual[:at] == reference[:at]:
        return ((at, 1.0),)
    lower = math.fsum(actual[:at - 1])
    upper = lower + actual[at - 1]
    overlaps = []
    previous = 0.0
    for position, bound in enumerate(accumulate(reference), 1):
        weight = min(upper, bound) - max(lower, previous)
        if weight > 0:
            overlaps.append((position, weight))
        if bound >= upper:
            break
        previous = bound
    total = math.fsum(weight for _, weight in overlaps)
    return tuple((position, weight / total) for position, weight in overlaps)


def quantile_reference(actual_pity, ref_pity, at, *, actual_eligible=0,
                       ref_eligible=0, start=0, rush=True):
    """Reference positions and conditional weights for the observed target interval."""
    actual = completion_pmf(actual_pity, actual_eligible, start=start, rush=rush)
    reference = completion_pmf(ref_pity, ref_eligible, start=start, rush=rush)
    return _overlap_quantiles(actual, reference, at)


@lru_cache(maxsize=80)
def _first_six_pmf(pity):
    pmf = []
    alive = 1.0
    for water in range(pity, 80):
        chance = p6(water)
        pmf.append(alive * chance)
        alive *= 1 - chance
    return tuple(pmf)


def three_red_probability(actual_pity, ref_pity, first_at, last_off_at):
    """Share the first six-star rank, then keep observed gaps until draw 120."""
    reference = _first_six_pmf(ref_pity)
    actual = _first_six_pmf(actual_pity)
    gap = last_off_at - first_at
    return math.fsum(weight for at, weight in _overlap_quantiles(actual, reference, first_at)
                     if at + gap >= FIRST_UP)


def _copy_signature(copies):
    return tuple(sorted((name, min(count, FULL_POTENTIAL_COPIES))
                        for name, count in dict(copies).items() if count > 0))


@lru_cache(maxsize=8192)
def _add_copy(signature, name):
    if name is None:
        return signature
    counts = dict(signature)
    if counts.get(name, 0) >= FULL_POTENTIAL_COPIES:
        return signature
    counts[name] = counts.get(name, 0) + 1
    return tuple(sorted(counts.items()))


def _six_identities(up, candidates):
    outcomes = [(up, 0.5)] + [(name, 1 / 14) for name in candidates]
    return (*outcomes, (None, 1 - math.fsum(rate for _, rate in outcomes)))


def reference_after_prefix(pity, copies, *, actual_pity, events, observed_stop,
                           reference_stop, up, off_candidates):
    """Carry reference pity and copies through a short observed main-pool prefix."""
    states = {(pity, _copy_signature(copies)): 1.0}
    outcomes = _six_identities(up, off_candidates)
    tracked = LIMITED | {up, *off_candidates}
    for at in range(1, reference_stop + 1):
        observed = at <= observed_stop
        actual_name = events.get(at) if observed else None
        actual_rate = p6(actual_pity) if observed else None
        identities = outcomes
        if actual_name is not None:
            identities = ((actual_name if actual_name in tracked else None, 1.0),)
        following = defaultdict(float)
        for (water, signature), probability in states.items():
            chance = p6(water)
            if actual_name is not None:
                six = min(chance / actual_rate, 1.0)
            elif observed:
                six = max(chance - actual_rate, 0.0) / (1 - actual_rate)
            else:
                six = chance
            if six < 1:
                following[water + 1, signature] += probability * (1 - six)
            if six:
                for name, rate in identities:
                    following[0, _add_copy(signature, name)] += probability * six * rate
        states = following
        if observed:
            actual_pity = 0 if actual_name is not None else actual_pity + 1
    return tuple((water, signature, probability)
                 for (water, signature), probability in sorted(states.items()))


def ending_states(pity, steps, copies, up, off_candidates):
    """Enumerate ending water and capped copy counts of hypothetical main draws."""
    return reference_after_prefix(
        pity, copies, actual_pity=0, events={}, observed_stop=0,
        reference_stop=steps, up=up, off_candidates=off_candidates,
    )


def valid_standard_value(value):
    return type(value) in (int, float) and 0 <= value <= 10000 and math.isfinite(value)


def integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


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


def payment_curve(pool, allowance):
    positions = pool.get('freeDrawPositions')
    if positions is None:
        return lambda at: max(0, at - allowance)
    retained = sorted(positions)[:allowance]
    # Retain documented original free positions first. Remaining hypothetical
    # free resources can be used on later, otherwise paid draws.
    remaining = allowance - len(retained)
    first_unused = pool['total'] if remaining and len(retained) < min(pool['freeAllowance'], pool['total']) else 0
    for at in range(first_unused + 1, max(pool['total'], 120) + 21):
        if not remaining:
            break
        if at not in retained:
            retained.append(at)
            remaining -= 1
    return lambda at: at - sum(pos <= at for pos in retained)


def add_copies(copies, names):
    current = Counter(dict(copies))
    current.update(name for name in names if name in LIMITED)
    return _copy_signature(current)


def carry_prefix(branches, pool, opening, stop, hits, rush_names=()):
    """Project a free-only or common rush prefix without ending the open stage."""
    out = defaultdict(float)
    for pity, copies, probability in branches:
        for end, signature, weight in reference_after_prefix(
                pity, copies, actual_pity=opening, events=hits,
                observed_stop=min(stop, pool['total']), reference_stop=stop,
                up=pool['up'], off_candidates=off_candidates(pool['index'])):
            out[end, add_copies(signature, rush_names)] += probability * weight
    return [(pity, signature, weight) for (pity, signature), weight in out.items() if weight > 0]


def make_settlement(at, reason, allocations, **details):
    total = math.fsum(part['value'] for part in allocations)
    gain = -math.fsum(part['value'] for part in allocations if part['kind'] == 'character')
    return {'at': at, 'type': reason, 'value': total, 'permanentDelta': total + gain,
            'characterValue': gain, 'allocations': allocations, **details}


def cost_allocations(costs):
    return [{'poolIndex': origin, 'value': value, 'kind': 'paid'}
            for origin, value in costs.items() if value]


def matched_settlement(*, at, phase, is_up, pool, opening, branches, copies,
                      rush, seen_hits, standard_hits, ownership, actual_pay,
                      ref_pay, costs, effects, weights, voucher_origin, standard_value):
    """Settle one benchmark using interval overlap and per-state role credit."""
    idx = pool['index']
    actual_paid = actual_pay(at)
    ref_same = ref_pay(at)
    cash = math.fsum(costs.values()) + math.fsum(
        part['value'] for part in effects if part['kind'] == 'voucher')
    first, last_off = (seen_hits[0], seen_hits[-2]) if is_up and len(seen_hits) > 1 else (None, None)
    actual_off = 0 if is_up else eligible_off_count(idx, copies)
    expected_ref_at = expected_ref_paid = gain = extra_chance = 0.
    objective_states = defaultdict(float)
    for ref_pity, ref_copies, weight in branches:
        ref_off = 0 if is_up else eligible_off_count(idx, ref_copies)
        objective_states[ref_pity, ref_off] += weight
    for (ref_pity, ref_off), weight in objective_states.items():
        choices = quantile_reference(opening, ref_pity, at, actual_eligible=actual_off,
                                     ref_eligible=ref_off, start=phase, rush=rush)
        ref_branch = math.fsum(probability * ref_pay(position) for position, probability in choices)
        expected_ref_at += weight * math.fsum(probability * position for position, probability in choices)
        expected_ref_paid += weight * ref_branch
        if last_off is None:
            continue
        q = three_red_probability(opening, ref_pity, first['at'], last_off['at'])
        if not q:
            continue
        if last_off['at'] in standard_hits:
            value = standard_value
        else:
            new = ownership[last_off['at']]
            if new is None:
                return None
            spent = min(max(cash + actual_paid - ref_branch, 0), LIMITED_VALUE)
            value = spent + (1 if new else .5) * (LIMITED_VALUE - spent)
        extra_chance += weight * q
        gain += weight * q * value
    reason = '首 UP 自费差' if is_up else '歪限定后停手'
    if extra_chance:
        reason = '首 UP 前额外常驻' if last_off['at'] in standard_hits else '首 UP 前额外歪限定'
    allocations = cost_allocations(costs) + list(effects)
    allocations += split_value(actual_paid - ref_same, {voucher_origin: 1}, idx, 'voucher')
    allocations += split_value(ref_same - expected_ref_paid, weights, idx, 'water')
    allocations += split_value(-gain, weights, idx, 'character')
    return make_settlement(at, reason, allocations, actualPaid=actual_paid,
                           referencePaid=round(expected_ref_paid, 8), referenceAt=round(expected_ref_at, 8),
                           priorPaid=math.fsum(costs.values()),
                           extraCharacter=last_off['character'] if extra_chance else None,
                           extraCharacterProbability=extra_chance)


def score_actual_loss(character, reference_rows=None):
    """Settle cross-banner comparisons once and keep real resource provenance."""
    if reference_rows is None:
        from planning import build_reference_rows
        reference_rows = build_reference_rows(character)['pools']
    plan = {p['index']: p for p in reference_rows}
    standard_value = character.get('actualLossStandardValue', DEFAULT_STANDARD_VALUE)
    if not valid_standard_value(standard_value):
        standard_value = DEFAULT_STANDARD_VALUE
    result = {'version': VERSION, 'standardValue': standard_value, 'pools': []}
    previous = None
    tail_water = None
    branches, next_free = [], None
    costs, water_sources, effects = Counter(), Counter(), []
    force = None
    unresolved = False
    initial_owned = character.get('initialOwned')
    catalog_known = isinstance(initial_owned, list) and all(isinstance(name, str) for name in initial_owned)
    owned = set(initial_owned) if catalog_known else set()
    known_copies = Counter(owned & LIMITED)

    for pool in character.get('pools', []):
        idx, total, up = (pool.get(key) for key in ('index', 'total', 'up'))
        previous_index = previous.get('index') if previous else None
        continuous = (not pool.get('interruptionBefore') and type(idx) is int
                      and type(previous_index) is int and idx > previous_index)
        adjacent = continuous and idx == previous_index + 1
        zero_gap = continuous and not adjacent and character.get('completeHistory') is True
        if previous is not None and not (adjacent or zero_gap):
            unresolved |= bool(costs or effects)
            branches, next_free, tail_water = [], None, None
            costs, water_sources, effects, force = Counter(), Counter(), [], None
            catalog_known = False
        if pool.get('interruptionBefore'):
            catalog = pool.get('interruptionCatalog') or {}
            owned.update(catalog.get('ownedSixStars', []))
            for name in catalog.get('ownedSixStars', []):
                known_copies[name] = max(1, known_copies[name])
            catalog_known = catalog.get('catalogComplete') is True

        opening = pool.get('initialPity')
        if opening is None:
            opening = tail_water
        if opening is None and previous is None:
            opening = character.get('initialPity')
        if opening is None and idx == 0:
            opening = 0
        free = pool.get('freeAllowance')
        previously_earned = adjacent and type(previous.get('total')) is int and previous['total'] >= 60
        if free is None and adjacent and type(previous.get('total')) is int:
            free = 20 if previously_earned else 10
        if free is None and (idx == 0 or zero_gap):
            free = 10
        row = {'id': pool.get('id'), 'poolIndex': idx, 'banner': pool.get('banner'),
               'settlements': [], 'warnings': [], 'pending': False, 'pendingPaid': 0,
               'pendingVouchers': 0}
        result['pools'].append(row)
        error = source_error(pool, free, opening if integer(opening, 0, 79) else None)
        if opening is not None and not integer(opening, 0, 79):
            error = '期初水位无效。'
        if tail_water is not None and opening != tail_water:
            error = '期初水位与上期尾水冲突。'
        previous = pool
        if error:
            row['warnings'].append(error)
            unresolved |= bool(costs or effects)
            branches, next_free, tail_water = [], None, None
            costs, water_sources, effects, force = Counter(), Counter(), [], None
            catalog_known = False
            continue

        if adjacent and next_free is not None:
            if previously_earned and next_free == 10:
                reference_free = max(0, free - 10)
            elif not previously_earned and next_free == 20:
                reference_free = min(20, free + 10)
            else:
                reference_free = free
        else:
            reference_free = free
        voucher_origin = previous_index if reference_free != free else idx
        start_copies = _copy_signature(known_copies)
        if not branches and opening is not None:
            branches = [(opening, start_copies, 1.)]
        payment_pool = dict(pool, freeAllowance=free)
        actual_pay = payment_curve(payment_pool, free)
        ref_pay = payment_curve(payment_pool, reference_free)
        main_hits = sorted(pool['events'], key=lambda event: event['at'])
        hit_at = {event['at']: event['character'] for event in main_hits}
        first_up = next((at for at, name in hit_at.items() if name == up), None)
        rush_hit_at, rush_error = rush_hit_position(pool)
        rush_names = tuple(hit['character'] for hit in pool['rush']) if rush_hit_at is not None else ()
        if rush_error:
            catalog_known = False

        standard_hits, ownership = set(), {}
        effective_rush, actual_rush_up, actual_rush_common = False, False, False
        copies_at = [(0, start_copies)]
        timeline = [(at, 0, name) for at, name in hit_at.items()]
        timeline.extend((RUSH_AFTER_MAIN, 1, name) for name in rush_names)
        timeline.extend((token['at'], 2, up) for token in pool.get('tokens', []))
        for at, source, name in sorted(timeline, key=lambda item: item[:2]):
            standard = name in STANDARD or (name != up and known_copies[name] >= FULL_POTENTIAL_COPIES)
            if source == 0:
                ownership[at] = False if name in owned else True if catalog_known else None
                if standard:
                    standard_hits.add(at)
            elif source == 1:
                effective_rush |= not standard
                actual_rush_up |= name == up
                actual_rush_common |= standard
            owned.add(name)
            if name in LIMITED:
                known_copies[name] += 1
            copies_at.append((at, _copy_signature(known_copies)))

        natural_effective = [at for at in hit_at if at not in standard_hits]
        first_main = first_up if first_up is not None else next(iter(natural_effective), None)
        rush_anchor = RUSH_AFTER_MAIN if effective_rush and first_up is None else None
        if rush_error and (first_up is None or any(at > first_up for at in standard_hits)):
            row['warnings'].append(rush_error)

        def pity_at(at):
            last = max((pos for pos in hit_at if pos <= at), default=None)
            return at - last if last is not None else None if opening is None else opening + at

        def catalog_at(at):
            return next(signature for pos, signature in reversed(copies_at) if pos <= at)

        if first_main is not None:
            phase = rush_anchor if rush_anchor is not None and rush_anchor < first_main else 0
            comparison_copies, comparison_pity = start_copies, opening
            comparison_refs = branches
            if phase and branches and opening is not None:
                comparison_refs = carry_prefix(branches, pool, opening, phase, hit_at, rush_names)
                comparison_pity = pity_at(phase)
                comparison_copies = catalog_at(phase)
            weight_sources = water_sources or Counter({origin: abs(value) for origin, value in costs.items() if value})
            known_opening = comparison_pity is not None and comparison_refs
            if not known_opening:
                row['warnings'].append('首个收获的继承水位无法核实。')
            else:
                settle = matched_settlement(
                    at=first_main, phase=phase, is_up=first_up is not None, pool=pool,
                    opening=comparison_pity, branches=comparison_refs, copies=comparison_copies,
                    rush=not phase and not (actual_rush_up and first_up and RUSH_AFTER_MAIN < first_up),
                    seen_hits=[event for event in main_hits if event['at'] <= first_main],
                    standard_hits=standard_hits, ownership=ownership, actual_pay=actual_pay,
                    ref_pay=ref_pay, costs=costs, effects=effects, weights=weight_sources,
                    voucher_origin=voucher_origin, standard_value=standard_value)
                if settle is None:
                    row['warnings'].append('额外歪限定的 New 状态未知。')
                else:
                    row['settlements'].append(settle)

            if first_up is not None:
                anchors = {at: '主池后续 UP' for at in natural_effective
                           if at > first_main and hit_at[at] == up}
            else:
                anchors = {at: '歪限定后停手' for at in natural_effective if at > first_main}
            anchors.update({token['at']: '信物保护水位' for token in pool.get('tokens', [])})
            last_anchor = first_main
            for at, reason in sorted(anchors.items()):
                if reason != '主池后续 UP' or actual_pay(at) > actual_pay(last_anchor):
                    remaining_credit = actual_pay(at) - ref_pay(at) - actual_pay(last_anchor) + ref_pay(last_anchor)
                else:
                    remaining_credit = 0
                parts = split_value(remaining_credit, {voucher_origin: 1}, idx, 'voucher')
                row['settlements'].append(make_settlement(at, reason, parts))
                last_anchor = at

            costs, water_sources, effects, force = Counter(), Counter(), [], None
            reference_row = plan.get(idx, {})
            ref_view = reference_row.get('reference', {})
            ideal = ref_view.get('stop', max(free, last_anchor))
            if ideal <= max(free, last_anchor) and free != reference_free:
                ideal = max(reference_free, last_anchor)
            # Hypothetical stops are anchored to the last observed accepted target.
            ideal = max(ideal, last_anchor)
            net = actual_pay(total) - actual_pay(last_anchor) - (ref_pay(ideal) - ref_pay(last_anchor))
            if net:
                costs[idx] = net
                water_sources[idx] = abs(net)
            last_natural = max(hit_at, default=0)
            if last_natural > last_anchor:
                wasted = actual_pay(last_natural) - actual_pay(last_anchor)
                force = (row, last_natural, cost_allocations({idx: wasted}))
            if ideal == ref_view.get('stop') and ref_view.get('states') and reference_row.get('status') == 'ok':
                branches = [(state['pity'], _copy_signature(state['copies']), state['probability'])
                            for state in ref_view['states']]
            elif ideal <= total:
                projected = pity_at(ideal)
                branches = [(projected, catalog_at(ideal), 1.)] if integer(projected, 0, 79) else []
            else:
                projected = pity_at(total)
                branches = list(ending_states(projected, ideal - total, catalog_at(total), up,
                                              off_candidates(idx))) if integer(projected, 0, 79) else []
            if free > reference_free and ideal < total:
                additional = (actual_pay(ideal) - ref_pay(ideal)) - (actual_pay(total) - ref_pay(total))
                if additional > 0:
                    water_sources[voucher_origin] += additional
            next_free = 20 if ideal >= 60 else 10
        else:
            reference_stop = max(reference_free, rush_anchor or 0)
            rush_offset = actual_pay(rush_anchor) - ref_pay(rush_anchor) if rush_anchor else 0
            base_cost = actual_pay(total) - ref_pay(reference_stop)
            if rush_anchor:
                # The assumed shared reward moves the stopping anchor, while the
                # underlying reference main-pool water can still differ.
                force = None
                if rush_offset:
                    effects += split_value(rush_offset, {voucher_origin: 1}, idx, 'voucher')
                    base_cost -= rush_offset
            elif actual_rush_common and reference_stop < RUSH_AFTER_MAIN:
                effects += split_value(-standard_value, {idx: 1}, idx, 'character')
            stop_six = max(hit_at, default=0)
            if stop_six > (rush_anchor or 0):
                extra = actual_pay(stop_six) - ref_pay(min(stop_six, reference_stop)) - rush_offset
                force_costs = costs.copy()
                force_costs[idx] += extra
                force = (row, stop_six, cost_allocations({i: max(0, n) for i, n in force_costs.items()})
                         + list(effects))
            if base_cost:
                costs[idx] += base_cost
                water_sources[idx] += abs(base_cost)
            if opening is not None and branches:
                branches = carry_prefix(branches, pool, opening, reference_stop, hit_at,
                                       rush_names if rush_anchor else ())
            else:
                branches = []
            next_free = 20 if reference_stop >= 60 else 10

        tail_water = pity_at(total)
        row['tailWater'] = tail_water
        row['pendingPaid'] = sum(max(0, int(value)) for value in costs.values())
        if free > reference_free:
            last_hit = max(hit_at, default=0)
            row['pendingVouchers'] = max(0, ref_pay(total) - actual_pay(total)
                                         - (ref_pay(last_hit) - actual_pay(last_hit)))
        row['pending'] = bool(row['pendingPaid'] or row['pendingVouchers'] or effects)

    if force is not None:
        row, at, parts = force
        if parts or not row['warnings']:
            row['settlements'].append(make_settlement(at, '常驻后停手', parts))
        remaining_paid = max(0, sum(max(0, value) for value in costs.values()) -
                             sum(part['value'] for part in parts if part['kind'] == 'paid'))
        if result['pools']:
            final = result['pools'][-1]
            final['pendingPaid'] = remaining_paid
            final['pending'] = bool(remaining_paid or unresolved)
    elif unresolved and result['pools']:
        result['pools'][-1]['pending'] = True
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
