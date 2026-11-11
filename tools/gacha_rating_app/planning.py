"""Retrospective, per-banner planning loss using the user's fixed water table.

This is not a counterfactual replay of the account. Pool rows retain signed loss;
complete records display signed net loss directly, with user-defined loss bands.
No random simulation or interpolation is used. Input is the normalized ledger.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

VERSION = "planning-stopped-pools-v2.3-20261104"
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


def _pool_free(pool, previous):
    if _integer(pool.get("freeAllowance")) and pool["freeAllowance"] in (0, 10, 20):
        return pool["freeAllowance"], "explicit"
    if previous is not None and _next_is_contiguous(previous, pool) and _integer(previous.get("total")):
        return (20 if previous["total"] >= 60 else 10), "previous-banner-60-node"
    # Index zero is the first banner in the game, not the first uploaded row.
    if pool.get("index") == 0:
        return 10, "launch-banner-default"
    return None, "unknown-previous-banner"


def _row(pool, previous, character, values, acquisition_context=None):
    row = {"id": pool.get("id"), "banner": pool.get("banner"), "index": pool.get("index"),
           "total": pool.get("total"),
           "status": "partial", "warnings": [], "localLoss": None,
           "planningExempt": pool.get("planningExempt") is True,
           "countedLoss": None, "exemptedLoss": 0,
           "permanentDelta": None, "waterValueDelta": None, "rewardValueDelta": None,
           "missedFree": None, "branch": None, "anchor": None, "idealStop": None}
    warnings = row["warnings"]
    total = pool.get("total")
    free, free_source = _pool_free(pool, previous)
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
    if initial is None and previous is not None and _next_is_contiguous(previous, pool):
        initial = previous.get("tail")
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
    if acquisition_context is not None:
        new_hits = acquisition_context['newLimitedHits']
        unknown = acquisition_context['unknownNewPositions']
        anchors.extend({**hit, "kind": "new-limited"} for hit in new_hits)
        row.update(newLimitedHits=new_hits, unknownNewPositions=unknown,
                   effectiveAcquisitions=anchors)
        if any(at > max(free, max((e['at'] for e in anchors), default=-1)) for at in unknown):
            warnings.append("最后有效收获之后的歪限定New状态未知，无法确定理想停点")
            return row
    if anchors:
        # All copies and tokens count. Do not invent a full-potential overflow exception.
        anchor = max(anchors, key=lambda e: (e["at"], e["source"] == "token"))
        # Free draws must be exhausted even after an early effective acquisition.
        # Their carry-over water is the baseline, not a negative-consumption gain.
        stop = max(free, 60 if 46 <= anchor["at"] <= 59 else anchor["at"])
        row.update(branch="last-effective" if anchor.get('kind') == 'new-limited' else "last-up",
                   anchor=anchor, idealStop=stop)
        if anchor['at'] < free:
            row['stopRule'] = 'complete-free-allowance'
            row['reason'] = f"第{anchor['at']}抽已获有效收获，仍应用完本池{free}抽免费额度；剩余免费抽不计额外收益。"
    else:
        stop = free
        row.update(branch="free-only-skip", idealStop=stop)
    missing_pity = max(stop - total, 0)
    row["missingPity"] = missing_pity
    # A user-defined asset valuation, not simulated future pulls. Extend the
    # observed ending pity without adding events or changing later real pools.
    ref_pity = (actual_pity + missing_pity if actual_pity is not None else None) if missing_pity else _pity_at(stop, events, initial)
    row["referencePitySource"] = ("early-stop-water-extension" if missing_pity else "observed-history")
    if ref_pity is None or actual_pity is None:
        warnings.append("参考或实际期末水位未知")
        return row
    if not _integer(ref_pity, 0, 79):
        warnings.append("提前停手的水位估值超出合法0–79范围，未外推" if missing_pity else "参考停点水位超出0–79，疑有漏读六星")
        return row
    actual_perm, ref_perm = max(total - free, 0), max(stop - free, 0)
    # Default is free-first. Explicit source-attributed late free draws can override
    # the permanent subtotal, without pretending OCR established payment timing.
    attribution = pool.get("freeDrawPositions")
    if attribution is not None:
        if (not isinstance(attribution, list)
                or any(not _integer(x, 1, total) for x in attribution)
                or len(attribution) != len(set(attribution))
                or len(attribution) != min(total, free)):
            warnings.append("限时免费抽位置列表无效")
            return row
        actual_perm = total - len(attribution)
        # Positions contain observed draws only. Remaining free allowance up to
        # a later reference stop is free too, not an invented paid expenditure.
        reference_unused_free = min(missing_pity, max(free - total, 0))
        ref_perm = stop - sum(x <= stop for x in attribution) - reference_unused_free
        row["spendSource"] = "explicit-free-positions"
    else:
        row["spendSource"] = "free-first-default"
    row["actual"] = {"stop": total, "pity": actual_pity, "permanent": actual_perm,
                     "nextFree": 20 if total >= 60 else 10}
    row["reference"] = {"stop": stop, "pity": ref_pity, "permanent": ref_perm,
                        "nextFree": 20 if stop >= 60 else 10,
                        "pityIsValuation": bool(missing_pity)}
    row["permanentDelta"] = actual_perm - ref_perm
    if actual_pity == ref_pity and row["actual"]["nextFree"] == row["reference"]["nextFree"]:
        # Exact cancellation needs no extrapolated value, even outside the table.
        water_delta = reward_delta = 0.0
    else:
        if actual_pity not in values or ref_pity not in values:
            warnings.append("固定水位表缺少本池所需水位，未外推")
            return row
        a, r = values[actual_pity], values[ref_pity]
        water_delta = r["free10"] - a["free10"]
        actual_reward = a["free10"] - a["free20"] if total >= 60 else 0.0
        ref_reward = r["free10"] - r["free20"] if stop >= 60 else 0.0
        reward_delta = actual_reward - ref_reward
        row["actual"]["futureCost"] = a["free20" if total >= 60 else "free10"]
        row["reference"]["futureCost"] = r["free20" if stop >= 60 else "free10"]
    row.update(waterValueDelta=water_delta, rewardValueDelta=reward_delta,
               localLoss=(actual_perm - ref_perm) - water_delta - reward_delta,
               status="ok")
    if missing_pity:
        row["reason"] = (f"提前停手少积累{missing_pity}抽水位，估值参考水位{actual_pity}→{ref_pity}；"
                         + ("漏用免费抽按水位表价值差计损。" if row["branch"] == "free-only-skip" else
                            "合并少花的永久抽、水位和60节点赠券价值净差。")
                         + "参考水位仅用于规划估值，不代表实际补抽或预测出货。")
    return row


def score_planning(character: dict) -> dict:
    """Evaluate independent local comparisons; never mutate the input ledger."""
    table = json.loads(TABLE_FILE.read_text(encoding="utf-8"))
    values = {r["pity"]: r for r in table["rows"]}
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
    from importer import BANNERS
    from opportunity import quote
    limited = set(BANNERS.values())
    initial_owned = character.get('initialOwned')
    ownership_known = isinstance(initial_owned, list) and all(isinstance(n, str) and n for n in initial_owned)
    owned = set(initial_owned) if ownership_known else set()
    for i, pool in enumerate(pools):
        previous = pools[i-1] if i else None
        if pool.get('interruptionBefore') or (previous is not None and not _next_is_contiguous(previous, pool) and not character.get('completeHistory')):
            ownership_known = False
        if pool.get('interruptionBefore'):
            catalog = pool.get('interruptionCatalog') or {}
            owned.update(catalog.get('ownedSixStars', []))
            ownership_known = catalog.get('catalogComplete') is True
        held = pool.get('up') in owned if ownership_known or pool.get('up') in owned else None
        # Validate the original resource ledger first. New uncertainty is an A-only
        # ambiguity, not a source conflict, and must not suppress a valid B quote.
        source_row = _row(pool, previous, character, values)
        context = {'newLimitedHits': [], 'unknownNewPositions': []}
        if source_row['status'] != 'partial':
            hits = [(e, e['at'], 'main') for e in pool['events']]
            hits += [(e, source_row.get('rushAt', 30), 'rush') for e in pool.get('rush', [])]
            for event, at, source in sorted(hits, key=lambda hit: (hit[1], hit[2] == 'rush')):
                name = event['character']
                if name in limited and name != pool['up'] and name not in owned:
                    if ownership_known:
                        context['newLimitedHits'].append({'at': at, 'character': name, 'source': source})
                    else:
                        context['unknownNewPositions'].append(at)
                owned.add(name)
            row = _row(pool, previous, character, values, context)
        else:
            row = source_row
            # Missing source events can hide prior ownership in subsequent pools.
            ownership_known = False
        row['opportunity'] = quote(pool, source_row, held)
        if row['status'] == 'ok':
            row['exemptedLoss'] = max(row['localLoss'], 0) if row['planningExempt'] else 0
            row['countedLoss'] = row['localLoss'] - row['exemptedLoss']
        result['pools'].append(row)
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
        "note": "有符号合计汇总已结束且可计算的局部净差，有未算项时为部分合计，不是全账号重规划反事实亏损。早于最优停点时，以真实尾水加未到停点的抽数作为估值水位；漏用免费抽的水位价值差纳入亏损，补60仍合并永久抽、水位与赠券净差，不重复另扣漏用抽数。",
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
        'approximate': True, 'note': '独立机会估值，不与资源损耗A相加，不参与主称号。',
    }
    return result
