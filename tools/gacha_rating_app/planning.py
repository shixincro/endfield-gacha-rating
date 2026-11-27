"""Exact per-banner planning loss for a normalized historical ledger."""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import math
from pathlib import Path

import actual_loss
import opportunity

# Stored ratings need recalculation when any of the three algorithms changes.
VERSION = f"planning-three-losses-v4.0+{actual_loss.VERSION}+{opportunity.VERSION}"
TABLE_FILE = Path(__file__).with_name("water_values.json")


def loss_title(loss):
    """Presentation bands only; preserve the unrounded signed loss."""
    if not isinstance(loss, (int, float)) or isinstance(loss, bool) or not math.isfinite(loss):
        return {"lossTier": None, "title": None}
    for tier, (upper, title) in enumerate(((20, "自律狂人"), (60, "精打细算"),
                                         (120, "随性挥霍"), (240, "上头豪客"),
                                         (math.inf, "亏掉底裤")), 1):
        if loss <= upper:
            return {"lossTier": tier, "title": title}


def export_water_table(workbook_path: str | Path, output_path: str | Path = TABLE_FILE):
    """Explicit build-time extraction only; never modifies the source workbook."""
    import openpyxl
    source = Path(workbook_path)
    workbook = openpyxl.load_workbook(source, data_only=True, read_only=True)
    sheet = workbook["Sheet1"]
    rows = list(sheet.iter_rows(min_row=1, max_col=5, values_only=True))
    expected = ("起始水位", "免费10抽", "免费20抽", "实际抽数", "大保底概率")
    if tuple(rows[0]) != expected:
        raise ValueError("水位表列名发生变化，需要人工确认，未导出")
    result = {
        "version": "user-water-expectation-table-20261013",
        "source": {"filename": source.name,
                   "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                   "sheet": "Sheet1", "range": "A1:E62", "columns": list(expected)},
        "semantics": {
            "free10": "下一新池免费10抽时，得到首UP的永久抽期望",
            "free20": "下一新池免费20抽时，得到首UP的永久抽期望",
            "draws": "不抵扣免费资源的主池抽数期望",
            "hard120Probability": "原表所列大保底概率，规划亏损未使用",
            "lookup": "只查原表，不插值、外推或新跑模拟",
        },
        "rows": [{"pity": row[0], "free10": row[1], "free20": row[2],
                  "draws": row[3], "hard120Probability": row[4]}
                 for row in rows[1:] if row[0] is not None],
    }
    if [r["pity"] for r in result["rows"]] != list(range(61)):
        raise ValueError("水位表范围不是预期的0至60，需要人工确认")
    for row in result["rows"]:
        if not all(isinstance(row[k], (int, float)) and math.isfinite(row[k])
                   for k in ("free10", "free20", "draws", "hard120Probability")):
            raise ValueError("水位表存在空白或非数值")
    workbook.close()
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def _integer(value, minimum=0, maximum=None):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and int(value) == value and value >= minimum
            and (maximum is None or value <= maximum))


def _pity_at(position, events, initial_pity):
    previous = max((e["at"] for e in events if e["at"] <= position), default=None)
    if previous is not None:
        return position - previous
    return initial_pity + position if _integer(initial_pity, 0, 79) else None


def _next_is_contiguous(first, second):
    return (not second.get('interruptionBefore') and _integer(first.get("index")) and _integer(second.get("index"))
            and second["index"] == first["index"] + 1)


def _known_empty_gap(previous, pool, character):
    return (previous is not None and not pool.get('interruptionBefore')
            and character.get('completeHistory') is True
            and _integer(previous.get('index')) and _integer(pool.get('index'))
            and pool['index'] > previous['index'] + 1)


def _pool_free(pool, previous, character):
    if _integer(pool.get("freeAllowance")) and pool["freeAllowance"] in (0, 10, 20):
        return int(pool["freeAllowance"]), "explicit"
    if previous is not None and _next_is_contiguous(previous, pool) and _integer(previous.get("total")):
        return (20 if previous["total"] >= 60 else 10), "previous-banner-60-node"
    if _known_empty_gap(previous, pool, character):
        return 10, "known-skipped-banner"
    # Index zero is the first banner in the game, not the first uploaded row.
    if pool.get("index") == 0:
        return 10, "launch-banner-default"
    return None, "unknown-previous-banner"


def _source_row(pool, previous, character, prior_pity):
    row = {"id": pool.get("id"), "banner": pool.get("banner"), "index": pool.get("index"),
           "total": pool.get("total"),
           "status": "partial", "warnings": [], "localLoss": None,
           "planningExempt": pool.get("planningExempt") is True,
           "countedLoss": None, "exemptedLoss": 0,
           "permanentDelta": None, "waterValueDelta": None, "rewardValueDelta": None,
           "missedFree": None, "branch": None, "anchor": None, "idealStop": None}
    warnings = row["warnings"]
    total = pool.get("total")
    free, free_source = _pool_free(pool, previous, character)
    row["freeAllowance"] = free
    row["freeSource"] = free_source
    row.update(ended=True, endedSource="recorded-stop")
    if not _integer(total):
        warnings.append("主池总抽数未知或不是非负整数")
        return row
    total = int(total)
    if free is not None:
        row["missedFree"] = max(free - total, 0)
        row["unusedFreeAtSnapshot"] = max(free - total, 0)
    if free is None:
        warnings.append("紧邻上一期的60节点未知，无法确定本期免费10/20抽")
        return row
    if pool.get("complete") is False:
        warnings.append("本池记录缺段，无法确定最后UP或参考水位")
        return row
    # Any unresolved identity/position error can change the last-UP anchor. Do not
    # keep an OCR-code whitelist: new recognizer errors must fail closed too.
    # Quota errors explicitly scoped only to five stars do not affect this branch.
    def affects_planning(issue):
        if not isinstance(issue, dict) or issue.get("severity") != "error":
            return False
        axes = issue.get("axes")
        if axes is None:
            return True
        return bool(set(axes) & {"up", "characterSix", "planning"})
    blockers = [i for i in (pool.get("issues") or []) if affects_planning(i)]
    if blockers:
        warnings.extend(i.get("message", "主池记录冲突") for i in blockers)
        return row
    up = pool.get("up")
    if not isinstance(up, str) or not up:
        warnings.append("当期UP未知")
        return row
    events = pool.get("events")
    if not isinstance(events, list):
        warnings.append("主池六星事件未知")
        return row
    if any(not isinstance(e, dict) or e.get("source", "main") != "main"
           or not _integer(e.get("at"), 1, total) for e in events):
        warnings.append("主池六星位置无效或混入非主池事件")
        return row
    events = sorted(events, key=lambda e: e["at"])
    if len({e["at"] for e in events}) != len(events):
        warnings.append("同一主池抽数位置出现重复六星事件")
        return row
    if any(not isinstance(e.get("character"), str) or not e["character"] for e in events):
        warnings.append("六星身份未知，不能可靠判断最后当期UP")
        return row
    initial = pool.get("initialPity")
    if initial is None and pool is character["pools"][0]:
        initial = character.get("initialPity")
    if initial is None and previous is not None and (
            _next_is_contiguous(previous, pool) or _known_empty_gap(previous, pool, character)):
        initial = previous.get("tail")
        if initial is None:
            initial = prior_pity
    last = 0
    for event in events:
        waiting = event["at"] - last + (initial if last == 0 and _integer(initial, 0, 79) else 0)
        if waiting > 80:
            warnings.append("六星等待段超过80抽，疑有漏读事件")
            return row
        last = event["at"]
    actual_pity = _pity_at(total, events, initial)
    if actual_pity is not None and not _integer(actual_pity, 0, 79):
        warnings.append("事件重建的期末水位超出0–79，疑有漏读六星")
        return row
    if pool.get("tail") is not None and actual_pity is not None and pool["tail"] != actual_pity:
        warnings.append("截图期末水位与六星事件重建结果冲突")
        return row
    if actual_pity is None and _integer(pool.get("tail"), 0, 79):
        actual_pity = pool["tail"]
    anchors = [{"at": e["at"], "source": "main", "forced": bool(e.get("forced"))}
               for e in events if e["character"] == up]
    tokens = pool.get("tokens", [])
    if not isinstance(tokens, list) or any(not isinstance(t, dict) or not _integer(t.get("at"), 240, total)
                                         or t["at"] % 240 for t in tokens):
        warnings.append("信物节点缺失位置或不在240的整数倍")
        return row
    if len({t["at"] for t in tokens}) != len(tokens):
        warnings.append("信物节点重复")
        return row
    if total >= 240 and {t["at"] for t in tokens} != set(range(240, total + 1, 240)):
        warnings.append("240/480等信物节点未全部确认")
        return row
    anchors.extend({"at": t["at"], "source": "token"} for t in tokens)
    rush_used = pool.get("rushUsed")
    rush = pool.get("rush", [])
    if rush_used is not None and not isinstance(rush_used, bool):
        warnings.append("加急状态必须是已用、未用或未知")
        return row
    if not isinstance(rush, list) or any(not isinstance(e, dict) for e in rush):
        warnings.append("加急结果格式错误")
        return row
    if rush_used is not True and rush:
        warnings.append("存在加急出货记录，但加急使用状态冲突或未知")
        return row
    if rush_used is True and total < 30:
        warnings.append("主池未达30但记录加急已使用")
        return row
    if rush_used is None and total >= 30:
        warnings.append("是否实际使用加急未知，不能确认是否存在更晚UP锚点")
        return row
    if rush_used is True:
        raw_at = pool.get("rushAt")
        at = 30 if raw_at is None else raw_at
        if not _integer(at, 30, total):
            warnings.append("加急使用时点必须为30至本池总抽数之间的整数")
            return row
        row["rushAt"] = at
        row["rushAtSource"] = ("confirmed-default-after-main-30"
                               if raw_at is None or pool.get("rushAtSource") == "confirmed-default-after-main-30"
                               else "explicit")
        if any(not isinstance(e.get("character"), str) or not e["character"] for e in rush):
            warnings.append("加急六星身份未知")
            return row
        if any(e["character"] == up for e in rush):
            anchors.append({"at": at, "source": "rush"})
    if actual_pity is None:
        warnings.append("实际期末水位未知")
        return row
    attribution = pool.get("freeDrawPositions")
    if attribution is not None and (not isinstance(attribution, list)
            or any(not _integer(x, 1, total) for x in attribution)
            or len(attribution) != len(set(attribution))
            or len(attribution) != min(total, free)):
        warnings.append("限时免费抽位置列表无效")
        return row
    row["spendSource"] = "explicit-free-positions" if attribution is not None else "free-first-default"
    row["actual"] = {"stop": total, "pity": int(actual_pity),
                     "permanent": max(total - free, 0), "nextFree": 20 if total >= 60 else 10}
    row.update(status="ok", _events=events, _anchors=anchors, _initial=initial)
    return row


def _known_copies(timeline, known_opening, stop):
    counts = known_opening.copy()
    for at, _, name in timeline:
        if at > stop:
            break
        if name in actual_loss.LIMITED:
            counts[name] = min(counts.get(name, 0) + 1, opportunity.FULL_POTENTIAL_COPIES)
    return dict(counts)


def _reference_stop(row, pool, known_opening, owned, ownership_known):
    """Keep source validation independent from the candidate stopping rule."""
    events, anchors, initial = (row.pop(key) for key in ("_events", "_anchors", "_initial"))
    total, free, up = row["actual"]["stop"], row["freeAllowance"], pool["up"]
    timeline = [(int(event['at']), 'main', event['character']) for event in events]
    timeline.extend((int(row['rushAt']), 'rush', event['character']) for event in pool.get('rush', []))
    timeline.extend((int(token['at']), 'token', up) for token in pool.get('tokens', []))
    timeline.sort(key=lambda event: (event[0], event[1] != 'main'))

    known_copies = Counter(known_opening)
    limited_hits, new_hits, unknown_new = [], [], []
    rush_targets = []
    for at, source, name in timeline:
        if (source != 'token' and name != up and name in actual_loss.LIMITED
                and known_copies[name] < opportunity.FULL_POTENTIAL_COPIES):
            new = name not in owned
            hit = {'at': at, 'character': name, 'source': source}
            if new and ownership_known:
                new_hits.append(hit)
                hit = {**hit, 'kind': 'new-limited'}
            else:
                if new:
                    unknown_new.append(at)
                hit['kind'] = 'limited'
            limited_hits.append(hit)
        if source == 'rush' and (name == up or (
                name in actual_loss.LIMITED and known_copies[name] < opportunity.FULL_POTENTIAL_COPIES)):
            rush_targets.append((at, name))
        owned.add(name)
        if name in actual_loss.LIMITED:
            known_copies[name] = min(known_copies[name] + 1, opportunity.FULL_POTENTIAL_COPIES)

    natural_up = [anchor for anchor in anchors if anchor['source'] == 'main']
    tokens = [anchor for anchor in anchors if anchor['source'] == 'token']
    main_limited = [anchor for anchor in limited_hits if anchor['source'] == 'main']
    effective = natural_up + tokens if natural_up else anchors + limited_hits
    row.update(newLimitedHits=new_hits, unknownNewPositions=unknown_new,
               effectiveAcquisitions=effective)
    if natural_up:
        at = int(natural_up[0]['at'])
        row['target'] = {'kind': 'first-up', 'at': at,
                         'rush': not any(t < at and name == up for t, name in rush_targets)}
    elif main_limited:
        at = main_limited[0]['at']
        row['target'] = {'kind': 'first-effective-limited', 'at': at,
                         'rush': not any(t < at for t, _ in rush_targets)}
    else:
        row['target'] = None

    row['actual']['copies'] = dict(known_copies)
    anchor = max(effective, key=lambda hit: (hit['at'], hit['source'] == 'token',
                                            hit['source'] == 'main'), default=None)
    if anchor is None:
        stop = free
        row.update(branch="free-only-skip", idealStop=stop)
    else:
        at = int(anchor["at"])
        stop = max(free, 60 if 46 <= at <= 59 else at)
        row.update(branch="last-effective" if anchor.get('kind') else "last-up",
                   anchor=anchor, idealStop=stop)
        if at < free:
            row['stopRule'] = 'complete-free-allowance'
            row['reason'] = f"第{at}抽已获有效收获，仍应用完本池{free}抽免费额度。"

    missing = max(stop - total, 0)
    row["missingPity"] = missing
    row["referencePitySource"] = "early-stop-weighted" if missing else "observed-history"
    if missing:
        candidates = actual_loss.off_candidates(int(pool['index'])) if _integer(
            pool.get('index'), 0, len(actual_loss.SCHEDULE) - 1) else ()
        endpoints = actual_loss.ending_states(row["actual"]["pity"], missing,
                                               known_copies, up, candidates)
        states = [{"pity": pity, "copies": dict(copies), "probability": probability}
                  for pity, copies, probability in endpoints]
        row["reason"] = f"参考继续抽{missing}次，按出货概率加权其尾水和图鉴。"
    else:
        ref_pity = _pity_at(stop, events, initial)
        if not _integer(ref_pity, 0, 79):
            row["warnings"].append("参考期末水位未知或超出0–79")
            row["status"] = "partial"
            return known_copies
        states = [{"pity": int(ref_pity),
                   "copies": _known_copies(timeline, known_opening, stop),
                   "probability": 1.0}]

    ref_perm = max(stop - free, 0)
    if pool.get("freeDrawPositions") is not None:
        # Only the reference extension can use the not-yet-used free allowance.
        free_used = sum(x <= stop for x in pool["freeDrawPositions"])
        ref_perm = stop - free_used - min(missing, max(free - total, 0))
    pities = {state["pity"] for state in states}
    row["reference"] = {"stop": stop, "pity": next(iter(pities)) if len(pities) == 1 else None,
                        "permanent": int(ref_perm), "nextFree": 20 if stop >= 60 else 10,
                        "copies": states[0]["copies"] if len(states) == 1 else None,
                        "states": states, "pityIsValuation": bool(missing)}
    row["permanentDelta"] = row["actual"]["permanent"] - ref_perm
    return known_copies


def _quote_future(row, following, next_pool_index):
    target = following.get('target') if following else None
    target = target or {'kind': 'first-up', 'at': None, 'rush': True}
    use_limited = (target['kind'] == 'first-effective-limited'
                   and _integer(next_pool_index, 0, len(actual_loss.SCHEDULE) - 1))
    row['nextTarget'] = dict(target, index=next_pool_index)

    def paid(state, free):
        eligible = actual_loss.eligible_off_count(int(next_pool_index), state['copies']) if use_limited else 0
        return actual_loss.expected_paid(state['pity'], free, eligible, rush=target['rush'])

    actual, reference = row['actual'], row['reference']
    actual_base = paid(actual, 10)
    actual_paid = actual_base if actual['nextFree'] == 10 else paid(actual, actual['nextFree'])
    ref_base = math.fsum(state['probability'] * paid(state, 10)
                        for state in reference['states'])
    ref_paid = ref_base if reference['nextFree'] == 10 else math.fsum(
        state['probability'] * paid(state, reference['nextFree']) for state in reference['states'])
    water_delta = ref_base - actual_base
    reward_delta = (actual_base - actual_paid) - (ref_base - ref_paid)
    local_loss = row['permanentDelta'] + actual_paid - ref_paid
    row['actual']['futureCost'] = actual_paid
    row['reference']['futureCost'] = ref_paid
    row.update(waterValueDelta=water_delta, rewardValueDelta=reward_delta,
               localLoss=0.0 if abs(local_loss) < 1e-12 else local_loss)


def build_reference_rows(character: dict) -> dict:
    """Build planning references without invoking realized settlement."""
    table = json.loads(TABLE_FILE.read_text(encoding="utf-8"))
    result = {"version": VERSION, "tableVersion": table["version"], "tableSource": table["source"],
              "pools": [], "summary": {}, "warnings": []}
    if not isinstance(character, dict) or not isinstance(character.get("pools"), list):
        result["warnings"].append("缺少标准化角色账本")
        return result
    pools = character["pools"]
    if any(not isinstance(p, dict) for p in pools):
        result["warnings"].append("角色卡池格式错误")
        return result
    if any(_integer(a.get("index")) and _integer(b.get("index")) and a["index"] >= b["index"]
           for a, b in zip(pools, pools[1:])):
        result["warnings"].append("角色卡池必须按不重复的时间顺序排列")
        return result

    initial_owned = character.get('initialOwned')
    ownership_known = isinstance(initial_owned, list) and all(isinstance(n, str) and n for n in initial_owned)
    owned = set(initial_owned) if ownership_known else set()
    known_copies = Counter(owned & actual_loss.LIMITED)
    prior_pity = None
    for i, pool in enumerate(pools):
        previous = pools[i - 1] if i else None
        if pool.get('interruptionBefore') or (previous is not None
                and not _next_is_contiguous(previous, pool) and not character.get('completeHistory')):
            ownership_known = False
        if pool.get('interruptionBefore'):
            catalog = pool.get('interruptionCatalog') or {}
            names = catalog.get('ownedSixStars', [])
            owned.update(names)
            for name in names:
                if name in actual_loss.LIMITED:
                    known_copies[name] = max(1, known_copies[name])
            ownership_known = catalog.get('catalogComplete') is True

        row = _source_row(pool, previous, character, prior_pity)
        source_status = row['status']
        prior_pity = row.get('actual', {}).get('pity')
        if source_status == 'ok':
            known_copies = _reference_stop(row, pool, known_copies, owned, ownership_known)
        else:
            # Missing source events can hide prior ownership in subsequent pools.
            ownership_known = False
        up = pool.get('up')
        target_copies = known_copies[up] if isinstance(up, str) else 0
        row['opportunity'] = opportunity.quote(pool, {**row, 'status': source_status}, target_copies)
        result['pools'].append(row)

    for i, (pool, row) in enumerate(zip(pools, result['pools'])):
        if row['status'] != 'ok':
            continue
        following = (result['pools'][i + 1] if i + 1 < len(pools)
                     and _next_is_contiguous(pool, pools[i + 1]) else None)
        next_index = int(pool['index']) + 1 if _integer(pool.get('index')) else None
        _quote_future(row, following, next_index)
        row['exemptedLoss'] = max(row['localLoss'], 0) if row['planningExempt'] else 0
        row['countedLoss'] = row['localLoss'] - row['exemptedLoss']
    completed = [r for r in result["pools"] if r["status"] == "ok"]
    total = sum(r["countedLoss"] for r in completed)
    complete = bool(pools) and len(completed) == len(pools) and math.isfinite(total)
    result["summary"] = {
        "poolCount": len(pools), "calculatedPools": len(completed),
        "provisionalPools": sum(r["status"] == "provisional" for r in result["pools"]),
        "partialPools": sum(r["status"] == "partial" for r in result["pools"]),
        "localLossSignedSum": total,
        "rawLocalLossSignedSum": sum(r["localLoss"] for r in completed),
        "exemptedPools": sum(r["exemptedLoss"] > 0 for r in completed),
        "exemptedLossSum": sum(r["exemptedLoss"] for r in completed),
        "sumIsPartial": len(completed) != len(pools),
        "localLossPositiveSum": sum(max(r["countedLoss"], 0) for r in completed),
        "localGainMagnitudeSum": sum(max(-r["countedLoss"], 0) for r in completed),
        "missedFreeKnown": sum(r["missedFree"] for r in result["pools"] if r["missedFree"] is not None),
        "accountCounterfactualLoss": None,
        "score": None,
        **(loss_title(total) if complete else {"lossTier": None, "title": None}),
        "scoreRule": "直接显示已结束卡池计入的有符号净亏损抽数，越低越好；豁免只免除所选池的正亏损，负收益保留，不从120倒扣。完整记录按未四舍五入计入值分为≤20、(20,60]、(60,120]、(120,240]、>240抽五档；缺项不生成称号。",
        "note": "按停点永久抽差与后续目标的期望自费差合计。尚未抽到参考停点时按真实六星概率扩展参照，并按各分支的尾水、图鉴和赠券计算期望。",
    }
    quotes = [r['opportunity'] for r in result['pools']]
    known = [q['value'] for q in quotes if q['status'] == 'ok' and math.isfinite(q['value'])]
    quoted_sum = sum(known)
    result['summary']['opportunity'] = {
        'total': quoted_sum if known and math.isfinite(quoted_sum) else None,
        'calculatedPools': len(known), 'poolCount': len(pools),
        'partialPools': sum(q['status'] == 'partial' for q in quotes),
        'provisionalPools': sum(q['status'] == 'provisional' for q in quotes),
        'complete': bool(pools) and len(known) == len(pools) and math.isfinite(quoted_sum),
        'approximate': True, 'note': '机会亏损独立展示，主称号沿用期望亏损。',
    }
    return result


def score_planning(character: dict) -> dict:
    """Score all three metrics without changing normalized records."""
    result = build_reference_rows(character)
    if result['summary']:
        result['actualLoss'] = actual_loss.score_actual_loss(character, reference_rows=result['pools'])
        # Branch identities are used inside the scorer; a saved result only
        # needs the aggregate valuation and its explanation.
        for row in result['pools']:
            row.get('actual', {}).pop('copies', None)
            reference = row.get('reference', {})
            reference.pop('copies', None)
            reference.pop('states', None)
    return result
