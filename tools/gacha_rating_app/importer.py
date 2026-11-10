"""Evidence-preserving Xiaohēihé screenshot adapter; never imports test answers.

The old prototype remains untouched. OCR is fresh on every analyze_image call.
Only build_ledger converts reverse-chronological display intervals to main-pull
positions, restores carried pity, and marks mechanical 120 guarantees.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import sys
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROTOTYPE = ROOT.parent / "gacha_ocr_prototype"
BANNERS = {
    "熔火灼痕": "莱万汀", "轻飘飘的信使": "洁尔佩塔", "热烈色彩": "伊冯",
    "河流的女儿": "汤汤", "狼珀": "洛茜", "春雷动，万物生": "庄方宜",
    "拳出无悔": "弭弗", "逐罪者": "卡缪", "临渊望北": "诀",
    "晨星于此闪耀": "梨诺", "冬猎": "提弗洛斯", "万物更新": "祀",
    "烟火邀星河": "明河",
}
CHAR_AXES = ["characterSix", "up", "limited", "five"]
WEAPON_AXES = ["weaponSix", "signature"]
RECOGNITION_VERSION = 'card-boundary-review-v7-pity-source-20261109'
DERIVED_REVIEW_VERSIONS = {RECOGNITION_VERSION, 'card-boundary-review-v6-minghe-20261105',
                           'card-boundary-review-v5-20261024', 'live-ledger-validation-v4-20261024',
                           'avatar-review-migration-v3-20261023'}


def issue(code, message, severity="warning", axes=None, **context):
    result = {"code": code, "message": message, "severity": severity}
    if axes is not None:
        result["axes"] = axes
    result.update(context)
    return result


def _prototype():
    if str(PROTOTYPE) not in sys.path:
        sys.path.insert(0, str(PROTOTYPE))
    import recognize
    return recognize


def create_engine():
    return _prototype().RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1, use_cls=False)


def _clean(text):
    return re.sub(r"\s+", "", str(text))


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _int_after(pattern, text):
    match = re.search(pattern, _clean(text))
    return int(match[1]) if match else None


def _same_line(rows, y, tolerance=22):
    return sorted((r for r in rows if abs(r["y"] - y) < tolerance), key=lambda r: r["x"])


def _rush_timing(raw, total, rush_used):
    """Apply the user's after-main-30 convention, not an OCR observation.

    This never infers *use* from unlocking. Explicit malformed inputs survive
    in the ledger with an error rather than being silently replaced by 30.
    """
    at = raw.get("rushAt")
    evidence = raw.get("rush_timing_evidence") or raw.get("rushTimingEvidence")
    issues = []
    if at is None:
        if rush_used is True and _integer(total) and total >= 30:
            return 30, "user-default-after-main-30", issues
        return None, None, issues
    if not _integer(at) or at < 30 or (_integer(total) and at > total):
        issues.append(issue("rush_timing_invalid", "加急主池时点必须是30至本池总抽数之间的整数，原值保留待核对。", "error", ["limited"]))
    if rush_used is False:
        issues.append(issue("rush_timing_without_use", "存在加急时点但标记为未使用，原值保留待核对。", "error", ["limited"]))
    if evidence in (None, "separate_panel_no_main_timeline"):
        evidence = "provided-main-position"
    return at, evidence, issues


def _column(rows, label):
    labels = [r for r in rows if abs(r["y"] - label["y"]) < 25
              and _clean(r["text"]) in ("限定", "复刻", "武器", "庆典", "常驻")]
    left = max((r["x"] for r in labels if r["x"] < label["x"] - 40), default=-300)
    right = min((r["x"] for r in labels if r["x"] > label["x"] + 40), default=1300)
    xmin, xmax = (left + label["x"]) / 2, (right + label["x"]) / 2
    return [r for r in rows if xmin <= r["x"] <= xmax and label["y"] < r["y"] < label["y"] + 235]


def _average_key(value):
    """Compare decimal OCR strings and numeric fields without float rounding."""
    try:
        number = Decimal(str(value))
        return number if number.is_finite() else str(value)
    except (InvalidOperation, ValueError):
        return str(value)


def _average_number(value):
    """Use a JSON number for the UI; exact inference reparses its decimal text."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return None
    try:
        number = Decimal(str(value).strip())
        if not number.is_finite() or not math.isfinite(float(number)):
            return None
        return int(number) if number == number.to_integral_value() else float(number)
    except (InvalidOperation, ValueError, OverflowError):
        return None


def _read_up_average(rows):
    """Read only the number aligned immediately above its UP平均 caption.

    The total count is a different row and column. Count-pair alignment, when
    available, additionally keeps a missing mean from falling back to a total.
    Duplicate identical OCR boxes are harmless; conflicting evidence is kept
    unavailable instead of silently choosing a value.
    """
    readings = []
    pair_rows = [r for r in rows if re.fullmatch(r"\d+[/／]\d+", _clean(r.get("text", "")))]
    for label in rows:
        label_text = _clean(label.get("text", "")).replace("．", ".")
        inline = re.fullmatch(r"UP平均[:：]?(\d+(?:\.\d+)?)", label_text, re.I)
        if inline:
            readings.append({"value": inline[1], "rows": [label]})
            continue
        if not re.fullmatch(r"UP平均[:：]?", label_text, re.I):
            continue
        if not all(isinstance(label.get(axis), (int, float)) for axis in ("x", "y")):
            continue
        candidates = []
        for number in rows:
            value = _clean(number.get("text", "")).replace("．", ".")
            if not re.fullmatch(r"\d+(?:\.\d+)?", value):
                continue
            if not all(isinstance(number.get(axis), (int, float)) for axis in ("x", "y")):
                continue
            dx, dy = abs(number["x"] - label["x"]), label["y"] - number["y"]
            if dx > 45 or not 0 < dy <= 85:
                continue
            if pair_rows and not any(abs(number["y"] - pair["y"]) <= 24 for pair in pair_rows):
                continue
            candidates.append((dx * dx + dy * dy, value, number))
        if candidates:
            best_distance = min(item[0] for item in candidates)
            nearest = [item for item in candidates if item[0] == best_distance]
            if len({_average_key(item[1]) for item in nearest}) != 1:
                return None
            readings.append({"value": nearest[0][1], "rows": [label, nearest[0][2]]})
    if not readings or len({_average_key(r["value"]) for r in readings}) != 1:
        return None
    value = _average_number(readings[0]["value"])
    return {"value": value, "evidence": [row for r in readings for row in r["rows"]]} if value is not None else None


def recover_weapon_average(weapon):
    """Read a saved mean without mutating the ledger or repeating OCR.

    An explicit upAverage, including a user-cleared None, owns the value.
    Only older records without that key may recover it from retained rows.
    """
    if not isinstance(weapon, dict):
        return None
    if "upAverage" in weapon:
        value = _average_number(weapon["upAverage"])
        if value is None:
            return None
        return {"value": value, "source": "weapon.upAverage",
                "evidence": copy.deepcopy(weapon.get("upAverageEvidence"))}
    evidence = weapon.get("evidence")
    rows = evidence.get("rows") if isinstance(evidence, dict) else None
    if not isinstance(rows, list):
        return None
    recovered = _read_up_average(rows)
    return {**copy.deepcopy(recovered), "source": "weapon.evidence.rows"} if recovered else None


def _summary_label(rows, label_text):
    # An individual result can also carry a "限定" badge. Only a header
    # aligned with other category columns or their count caption is a summary.
    categories = {"限定", "复刻", "武器", "庆典", "常驻"}
    for label in rows:
        if _clean(label["text"]) != label_text:
            continue
        if any(_clean(row["text"]) in categories - {label_text}
               and abs(row["y"] - label["y"]) < 25 and abs(row["x"] - label["x"]) > 40
               for row in rows):
            return label
        if any("出卡数" in row["text"] for row in _column(rows, label)):
            return label
    return None


def _has_detail_layout(rows):
    """Recognize a cropped card from its left-hand title and aligned statistics."""
    titles = []
    for row in rows:
        if row["box"][0] > 250:
            continue
        text = _clean(row["text"])
        if any(banner in text for banner in BANNERS) or re.match(r"^[\u3400-\u9fff]{1,12}申领", text):
            titles.append(row)
    for row in rows:
        if row["box"][0] > 250 or not re.search(r"合计\s*\d+\s*抽", row["text"]):
            continue
        if not any(0 < row["y"] - title["y"] < 120 for title in titles):
            continue
        line = "".join(item["text"] for item in _same_line(rows, row["y"]))
        if re.search(r"垫\s*\d+|产出", line):
            return True
    return False


def parse_summary(rows, label_text):
    """Handles both '550抽' and separately recognized '550' / '抽'."""
    label = _summary_label(rows, label_text)
    if not label:
        return None
    col = sorted(_column(rows, label), key=lambda r: r["y"])
    candidates = [r for r in col if re.fullmatch(r"\d+抽?", _clean(r["text"]))
                  and r["y"] < label["y"] + 125]
    total = int(re.search(r"\d+", candidates[0]["text"])[0]) if candidates else None
    pair = next((r for r in col if re.search(r"\d+\s*[/／]\s*\d+", r["text"])), None)
    six = off = None
    if pair:
        match = re.search(r"(\d+)\s*[/／]\s*(\d+)", pair["text"])
        six, off = int(match[1]), int(match[2])
    result = {"N": total, "K6": six, "off": off,
            "KU": six - off if six is not None and off is not None else None,
            "evidence": {"label": label, "rows": col}}
    if label_text == "武器":
        average = _read_up_average(col)
        result["upAverage"] = average["value"] if average else None
        result["upAverageEvidence"] = average["evidence"] if average else None
    return result


def parse_identity(rows):
    uid_row = next((r for r in rows if re.search(r"UID\s*[:：]?\s*\d{6,}", r["text"], re.I)), None)
    uid = re.search(r"UID\s*[:：]?\s*(\d{6,})", uid_row["text"], re.I)[1] if uid_row else None
    name = None
    if uid_row:
        near = [r for r in rows if abs(r["y"] - uid_row["y"]) < 60 and 100 < r["x"] < uid_row["x"] - 100
                and not re.search(r"UID|官服|设置|明日方舟|小黑盒|总抽|总消", r["text"], re.I)]
        if near:
            name = min(near, key=lambda r: abs(r["y"] - uid_row["y"]))["text"]
    return {"uid": uid, "name": name, "evidence": uid_row}


def parse_weapon(rows):
    summary = parse_summary(rows, "武器")
    headings = []
    for row in rows:
        text = _clean(row["text"])
        if "申领" in text and row.get("box", [row["x"]])[0] < 350:
            if not any(abs(row["y"] - h["y"]) < 30 for h in headings):
                headings.append(row)
    sections = []
    for heading in headings:
        total_rows = [r for r in rows if heading["y"] < r["y"] < heading["y"] + 125 and "合计" in r["text"]]
        header = "".join(r["text"] for r in _same_line(rows, total_rows[0]["y"])) if total_rows else ""
        sections.append({"banner": re.split(r"[0-9]", _clean(heading["text"]))[0],
                         "total": _int_after(r"合计(\d+)抽", header), "header_raw": header,
                         "evidence": heading})
    if not summary and not sections:
        return None
    result = {"N": summary["N"] if summary else None, "K6": summary["K6"] if summary else None,
              "KU": summary["KU"] if summary else None, "B": None, "H80": None,
              "upAverage": summary.get("upAverage") if summary else None,
              "upAverageEvidence": summary.get("upAverageEvidence") if summary else None,
              "sections": sections, "evidence": summary["evidence"] if summary else {}, "issues": []}
    if sections and all(_integer(s["total"]) for s in sections):
        section_total = sum(s["total"] for s in sections)
        result["detailTotal"] = section_total
        if result["N"] is None:
            result["N"] = section_total
        if result["N"] == section_total:
            result["B"] = sum(s["total"] > 0 for s in sections)
        else:
            result["issues"].append(issue("weapon_detail_total_mismatch", "武器明细抽数与顶部汇总不一致，池数暂不确定。", "error", WEAPON_AXES))
    if result["N"] == 0 and not sections:
        result["B"] = 0
    if result["KU"] is not None and result["KU"] < 0:
        result["issues"].append(issue("weapon_off_exceeds_six", "武器歪数大于六星数。", "error", WEAPON_AXES))
    return result


def augment_pools(pools, rows):
    """Fixes unknown-vs-zero semantics without altering prototype implementation."""
    for pool in pools:
        header = pool.get("header_raw", "")
        # Tile overlaps can produce both '产出13760' and a contained '13760'
        # box. Flattening those boxes corrupts Q into 1376013760. Read the
        # actual geometric header rows instead; never split a repeated number
        # string in half or use a screenshot-specific correction.
        heading = next((r for r in rows if r["text"] == pool.get("banner_raw")), None)
        total_y = (pool.get('cardBoundary') or {}).get('totalY')
        quota_rows = [r for r in rows if '产出' in r['text'] and (
            abs(r['y']-total_y) < 22 if isinstance(total_y, (int,float)) else
            heading and heading['y'] < r['y'] < heading['y']+120)]
        quota_values, quota_evidence = [], []
        for quota_row in quota_rows:
            value = _int_after(r"产出[^0-9]*(\d+)", quota_row["text"])
            evidence = [quota_row]
            if value is None:
                right_numbers = [r for r in _same_line(rows, quota_row["y"])
                                 if r["x"] > quota_row["box"][2] - 4
                                 and re.fullmatch(r"\d+", _clean(r["text"]))]
                if right_numbers:
                    nearest = min(right_numbers, key=lambda r: r["box"][0])
                    value = int(_clean(nearest["text"]))
                    evidence.append(nearest)
            if value is not None:
                quota_values.append(value)
                quota_evidence.extend(evidence)
        distinct_quota = set(quota_values)
        pool["quota"] = next(iter(distinct_quota)) if len(distinct_quota) == 1 else (
            _int_after(r"产出[^0-9]*(\d+)", header) if not rows else None)
        pool["quota_evidence"] = quota_evidence
        pool["tail"] = _int_after(r"垫(\d+)", header)
        pool["tail_known"] = pool["tail"] is not None
        total = pool.get("total")
        has_rush_data = bool(pool.get("rush")) or "rush_no_six" in pool
        pool["rushUsed"] = True if pool.get("rush_present") and has_rush_data else (
            False if _integer(total) and total < 30 and not pool.get("rush_present") else None)
        rush_at, rush_evidence, rush_issues = _rush_timing(pool, total, pool["rushUsed"])
        pool["rushAt"] = rush_at
        pool["rush_timing_evidence"] = rush_evidence
        pool["issues"] = []
        pool["issues"].extend(rush_issues)
        if len(distinct_quota) > 1:
            pool["issues"].append(issue("quota_ocr_conflict", "同一池头部配额的OCR数值冲突，不能猜选。", "error", ["five"]))
        if pool["rushUsed"] is None:
            pool["issues"].append(issue("rush_usage_unknown", "加急使用状态不完整，不能由达到30抽推定使用。", "error", CHAR_AXES))
        if pool["quota"] is None:
            pool["issues"].append(issue("quota_missing", "未读到本池武库配额产出，五星轴待确认。", "error", ["five"]))
        for event in pool.get("events", []) + pool.get("rush", []):
            event.setdefault("identitySource", "avatar" if event.get("off") or event in pool.get("rush", []) else "banner_and_badge")
        for code in pool.get("needs_review", []):
            pool["issues"].append(issue(code, "识别器保留待核对项：" + code, "error", CHAR_AXES))
    return pools


def attach_pool_image_evidence(pools, rows, source_path, output_dir):
    """Crop whole pool panels from saved OCR geometry, without running OCR.

    OCR coordinates use normalized width 1000. Crops retain original pixels;
    the source image is opened read-only and is never modified. Missing title
    geometry is not guessed: that pool keeps its full-source fallback only.
    """
    from PIL import Image

    source_path, output_dir = Path(source_path), Path(output_dir)
    title_rows, used = [], set()
    for index, pool in enumerate(pools):
        evidence = pool.setdefault("evidence", {})
        evidence["sourceImage"] = str(source_path.resolve())
        title = pool.get("banner_raw")
        candidates = [(i, r) for i, r in enumerate(rows)
                      if i not in used and title and r.get("text") == title
                      and len(r.get("box", [])) == 4 and r["box"][0] <= 250]
        if candidates:
            row_index, heading = min(candidates, key=lambda item: item[1]["y"])
            used.add(row_index)
            title_rows.append((index, heading))
        else:
            boundary = pool.get('cardBoundary') or {}
            start = boundary.get('startY')
            if isinstance(start, (int,float)) and math.isfinite(start):
                # A total-anchored card has a known boundary even when its
                # title OCR was blank. Include it in neighboring crop limits.
                title_rows.append((index, {'y':start, 'box':[0, start-17, 1000, start+17]}))
        if pool.get('cardBoundary'):
            evidence['cardBoundary'] = copy.deepcopy(pool['cardBoundary'])
    if not title_rows:
        return
    title_rows.sort(key=lambda item: item[1]["y"])
    with Image.open(source_path) as source:
        width, height = source.size
        scale = width / 1000
        for n, (pool_index, heading) in enumerate(title_rows):
            top = max(0, round((heading["box"][1] - 18) * scale))
            bottom = (min(height, round((title_rows[n + 1][1]["box"][1] - 18) * scale))
                      if n + 1 < len(title_rows) else height)
            if not 0 <= top < bottom <= height:
                continue
            output_dir.mkdir(parents=True, exist_ok=True)
            crop = output_dir / f"pool_{pool_index:02d}.png"
            if not crop.exists():
                source.crop((0, top, width, bottom)).save(crop)
            pools[pool_index]["evidence"].update({
                "crop": str(crop.resolve()), "box": [0, top, width, bottom],
                "coordinateSpace": "source-image", "sourceSize": [width, height],
            })


def analyze_image(path: Path, output_dir: Path, engine=None) -> dict:
    path, output_dir = Path(path), Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    recognize = _prototype()
    image = recognize.read_image(path)
    source_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    model_started = time.perf_counter()
    if engine is None:
        engine = create_engine()
    model_seconds = time.perf_counter() - model_started
    tick = time.perf_counter()
    rows = recognize.ocr_tiles(engine, image)
    ocr_seconds = time.perf_counter() - tick
    raw_path = output_dir / "ocr_raw.json"
    raw_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    tick = time.perf_counter()
    source_ok = any("小黑盒" in r["text"] for r in rows) or _has_detail_layout(rows)
    summary = parse_summary(rows, "限定")
    weapon = parse_weapon(rows) if source_ok else None
    pools = augment_pools(recognize.parse(image, rows, output_dir), rows) if source_ok else []
    attach_pool_image_evidence(pools, rows, path, output_dir / "pool_evidence")
    if weapon:
        weapon.setdefault("evidence", {})["sourceImage"] = str(path.resolve())
    kind = "character" if pools else "weapon" if weapon and weapon["sections"] else "unsupported"
    issues = []
    if kind == "unsupported":
        issues.append(issue("unsupported_layout", "未识别到卡池明细，请保留池名和下方的合计行。", "error", CHAR_AXES + WEAPON_AXES))
    if pools and summary:
        actual = {"N": sum(p["total"] for p in pools) if all(_integer(p.get("total")) for p in pools) else None,
                  "K6": sum(len(p["events"]) for p in pools),
                  "off": sum(bool(e.get("off")) for p in pools for e in p["events"])}
        for key in actual:
            if actual[key] is not None and summary[key] is not None and actual[key] != summary[key]:
                issues.append(issue("character_summary_mismatch", f"角色顶部{key}与明细不一致，可能有漏图或识别遗漏。", "error", CHAR_AXES,
                                    field=key, overview=summary[key], detail=actual[key]))
    result = {"file": path.name, "sourcePath": str(path.resolve()), "source_sha256": source_sha,
              "kind": kind, "pools": pools, "weapon": weapon,
              "overview": {"character": summary, "weapon": parse_summary(rows, "武器") if source_ok else None},
              "identity": parse_identity(rows), "issues": issues,
              "rawOcrPath": str(raw_path.resolve()),
              "timing": {"model_seconds": model_seconds, "ocr_seconds": ocr_seconds,
                         "parse_seconds": time.perf_counter() - tick,
                         "total_seconds": time.perf_counter() - started, "ocr_cache_used": False}}
    (output_dir / "record.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def _pool_signature(pool):
    # Crop coordinates / OCR scores are deliberately not semantic identity.
    compact = {k: pool.get(k) for k in ("banner", "total", "tail", "quota", "token_count", "rushUsed", "rushAt")}
    if "rushUsed" not in pool:
        compact["rushUsed"] = True if pool.get("rush_present") and (pool.get("rush") or pool.get("rush_no_six")) else (
            False if _integer(pool.get("total")) and pool["total"] < 30 else None)
    compact["rushAt"] = _rush_timing(pool, pool.get("total"), compact["rushUsed"])[0]
    compact["events"] = [{k: e.get(k) for k in ("pulls", "pity", "character", "off")} for e in pool.get("events", [])]
    compact["rush"] = [{k: e.get(k) for k in ("pulls", "character")} for e in pool.get("rush", [])]
    return json.dumps(compact, ensure_ascii=False, sort_keys=True)


def _event_evidence(event, doc):
    return {"source_sha256": doc.get("source_sha256"), "file": doc.get("file"),
            "crop": event.get("crop"), "raw": event.get("raw_text"),
            "avatar": event.get("avatar_match"), "interval": event.get("pulls"),
            "inheritedPityLabel": event.get("pity"), "identitySource": event.get("identitySource"),
            "needsReview": event.get("needs_review"), "avatarLocation": copy.deepcopy(event.get("avatar_location")),
            "offBadgeObserved": event.get("offBadgeObserved", event.get("off"))}


def _unresolved_card_sources(documents):
    """Stable source-qualified IDs retain cards whose title is still unknown."""
    result = {}
    for document in documents:
        for index, raw in enumerate(document.get('pools', [])):
            if raw.get('banner') in BANNERS:
                continue
            local_id = raw.get('cardId') or 'unknown-'+str(index)
            source = document.get('source_sha256') or document.get('file') or 'unknown-source'
            card_id = str(source)+':'+str(local_id)
            result.setdefault(card_id, (raw, document))
    return result


def _unresolved_cards(documents):
    cards = []
    for card_id, (raw, document) in _unresolved_card_sources(documents).items():
        events, rush = [], []
        for kind, target in (('events', events), ('rush', rush)):
            for index, (event, at) in enumerate(_original_event_rows(raw, kind)):
                evidence = copy.deepcopy(_event_evidence(event, document))
                evidence.update(unresolvedCardId=card_id, cardEventId=kind+'-'+str(index))
                row = {'character':event.get('character'), 'source':'main' if kind == 'events' else 'rush',
                       'forced':False, 'identitySource':event.get('identitySource'), 'evidence':evidence}
                if kind == 'events':
                    row['at'] = at
                target.append(row)
        originals = _original_event_rows(raw, 'events')
        first_pity = originals[0][0].get('pity') if originals else None
        total = raw.get('total')
        rush_used = raw.get('rushUsed')
        if 'rushUsed' not in raw:
            rush_used = True if raw.get('rush_present') and (raw.get('rush') or raw.get('rush_no_six')) else (
                False if _integer(total) and total < 30 and not raw.get('rush_present') else None)
        rush_at, _, _ = _rush_timing(raw, total, rush_used)
        tokens = [{'at':240*(i+1) if _integer(total) and 240*(i+1) <= total else None, 'source':'token',
                   'evidence':{'source_sha256':document.get('source_sha256'), 'unresolvedCardId':card_id,
                               'inferredFrom':'recognized_gift_and_fixed_240_node'}}
                  for i in range(raw.get('token_count') or 0)]
        cards.append({'id':card_id, 'cardId':raw.get('cardId'), 'bannerRaw':raw.get('banner_raw'),
                      'source_sha256':document.get('source_sha256'), 'file':document.get('file'),
                      'total':total, 'tail':raw.get('tail'), 'localTail':raw.get('tail'), 'quota':raw.get('quota'),
                      'initialPity':first_pity, 'events':events, 'rush':rush, 'rushUsed':rush_used,
                      'rushAt':rush_at, 'tokens':tokens,
                      'evidence':{**copy.deepcopy(raw.get('evidence') or {}),
                                  'source_sha256':document.get('source_sha256'), 'file':document.get('file'),
                                  'sourceImage':document.get('sourceImage') or (raw.get('evidence') or {}).get('sourceImage'),
                                  'cardBoundary':copy.deepcopy(raw.get('cardBoundary')),
                                  'header':raw.get('header_raw')}})
    return cards


def _bound_card_pool(documents, ledger, card_id):
    source = _unresolved_card_sources(documents).get(card_id)
    if source is None:
        return None
    raw, document = source
    candidates = [pool for pool in ledger.get('character', {}).get('pools', [])
                  if (pool.get('evidence') or {}).get('unresolvedCardId') == card_id]
    if len(candidates) != 1:
        return None
    pool = candidates[0]
    evidence = pool.get('evidence') or {}
    if (evidence.get('manual') is not True or pool.get('banner') not in BANNERS
            or pool.get('index') != list(BANNERS).index(pool['banner'])
            or pool.get('up') != BANNERS[pool['banner']]
            or _summary_source_key(evidence) != _summary_source_key(document)):
        return None
    # Binding a title cannot waive real source rows. Every main/rush event
    # must remain represented once in the same list, even without crop files.
    for kind in ('events', 'rush'):
        originals = _original_event_rows(raw, kind)
        matched = set()
        for event in pool.get(kind, []):
            event_evidence = event.get('evidence') or {}
            if _summary_source_key(event_evidence) != _summary_source_key(document):
                continue
            saved_id = event_evidence.get('cardEventId')
            if event_evidence.get('unresolvedCardId') == card_id and saved_id is not None:
                indexes = [i for i in range(len(originals)) if saved_id == kind+'-'+str(i)]
                match_index = indexes[0] if len(indexes) == 1 else None
            else:
                original, _ = _match_original_event(event, originals, kind)
                match_index = next((i for i, row in enumerate(originals) if row[0] is original), None)
            if match_index is not None:
                if match_index in matched:
                    return None
                matched.add(match_index)
        if len(matched) != len(originals):
            return None
    if raw.get('token_count', 0) > len(pool.get('tokens', [])):
        return None
    return pool


def _summary_source_key(value):
    """A hash identifies the evidence; filename is only a hash-less fallback."""
    digest = value.get('source_sha256')
    return ('sha256', digest) if digest else ('file', value.get('file'))


def character_summary_issues(documents, pools, overrides=None):
    """Compare screenshot headers with the CURRENT main-pool ledger.

    OCR documents remain immutable evidence. Main-pool summaries exclude rush
    recruits and milestone tokens; neither belongs to the screenshot's top card.
    Unknown fields are left to ordinary ledger validation, never treated as zero.
    """
    if not isinstance(pools, list) or any(not isinstance(p, dict) for p in pools):
        return []
    # The screenshot only covers the prefix preceding a remembered extension.
    # Edited screenshot rows within that prefix still participate in every check.
    covered = []
    for pool in pools:
        extra = pool.get('manualSupplementDraws', 0)
        if extra and _integer(pool.get('total')):
            source_total = pool['total'] - extra
            events = pool.get('events')
            if isinstance(events, list):
                events = [event for event in events if not isinstance(event, dict)
                          or not _integer(event.get('at')) or event['at'] <= source_total]
            covered.append({**pool, 'total': source_total, 'events': events})
        else:
            covered.append(pool)
    pools = covered
    totals_known = all(_integer(p.get('total')) and p['total'] >= 0 for p in pools)
    events_known = all(isinstance(p.get('events'), list)
                       and all(isinstance(e, dict) for e in p['events']) for p in pools)
    identities_known = events_known and all(
        isinstance(p.get('up'), str) and bool(p['up'])
        and all(isinstance(e.get('character'), str) and bool(e['character']) for e in p['events'])
        for p in pools)
    summary = {
        'N': sum(p['total'] for p in pools) if totals_known else None,
        'K6': sum(len(p['events']) for p in pools) if events_known else None,
        'off': sum(e['character'] != p['up'] for p in pools for e in p['events'])
               if identities_known else None,
    }
    labels = {'N': '主池总抽数', 'K6': '主池六星数', 'off': '歪出次数'}
    choices = {_summary_source_key(item): item for item in (overrides or [])}
    issues, seen = [], set()
    for doc in documents:
        digest = doc.get('source_sha256')
        if digest and digest in seen:
            continue
        if digest:
            seen.add(digest)
        overview = doc.get('overview', {}).get('character')
        if not isinstance(overview, dict):
            continue
        choice = choices.get(_summary_source_key(doc), {})
        mode = choice.get('mode')
        for field, actual in summary.items():
            original_expected = overview.get(field)
            expected = choice.get(field, original_expected) if mode == 'override' else original_expected
            if actual is not None and _integer(expected) and actual != expected:
                details_only = mode == 'details'
                origin = '手动修正的顶部汇总' if mode == 'override' else '截图顶部汇总'
                suffix = '；已明确选择以逐条明细为准，此差异不阻止评分。' if details_only else '，两者不符。'
                issues.append(issue('character_summary_mismatch',
                    f'当前记录的{labels[field]}为{actual}，{origin}为{expected}{suffix}',
                    'warning' if details_only else 'error', CHAR_AXES,
                    field=field, overview=expected, detail=actual,
                    file=doc.get('file'), source_sha256=digest, basis='current-ledger',
                    **({'summaryMode': mode, 'originalOverview': original_expected,
                        'resolution': 'manual-details-authoritative' if details_only else 'manual-header-correction'}
                       if mode else {})))
    return issues


EVENT_REVIEW_CODES = frozenset(('event_needs_review', 'events_need_review'))


def _legal_pool_characters(banner):
    names = list(BANNERS)
    if banner not in BANNERS:
        return set()
    index = names.index(banner)
    previous = (1, 2) if index == 0 else (0, 2) if index == 1 else (index - 1, index - 2)
    return {BANNERS[banner], *(BANNERS[names[i]] for i in previous),
            '余烬', '黎风', '艾尔黛拉', '别礼', '骏卫'}


def _canonical_character(name):
    return '骏卫' if name == '俊卫' else name


def _event_has_manual_identity(event):
    evidence = event.get('evidence') or {}
    source = event.get('identitySource', evidence.get('identitySource'))
    return (isinstance(source, str) and source.startswith(('manual', 'reviewed'))
            or event.get('identityReviewed') is True)


def _raw_pool_for_current(documents, pool):
    evidence = pool.get('evidence') or {}
    card_id = evidence.get('unresolvedCardId')
    source = _unresolved_card_sources(documents).get(card_id)
    if (source is not None and evidence.get('manual') is True
            and _summary_source_key(evidence) == _summary_source_key(source[1])):
        return source
    candidates = [(raw, doc) for doc in documents for raw in doc.get('pools', [])
                  if raw.get('banner') == pool.get('banner')
                  and (not evidence.get('source_sha256') or doc.get('source_sha256') == evidence['source_sha256'])
                  and (evidence.get('source_sha256') or not evidence.get('file') or doc.get('file') == evidence['file'])]
    # Repeated identical source files do not make evidence ambiguous.
    unique = {}
    for raw, doc in candidates:
        unique.setdefault((_summary_source_key(doc), _pool_signature(raw)), (raw, doc))
    return next(iter(unique.values())) if len(unique) == 1 else (None, None)


def _original_event_rows(raw, kind):
    rows, at = [], 0
    for event in reversed(raw.get(kind, [])):
        interval = event.get('pulls')
        at = at + interval if at is not None and _integer(interval) and interval > 0 else None
        rows.append((event, at if kind == 'events' else None))
    return rows


def _match_original_event(event, rows, kind, card_id=None):
    evidence = event.get('evidence') or {}
    if card_id and evidence.get('unresolvedCardId') == card_id:
        saved_id = evidence.get('cardEventId')
        for index, row in enumerate(rows):
            if saved_id == kind+'-'+str(index):
                return row
    crop = event.get('crop') or evidence.get('crop')
    if crop:
        # JSON exports may convert an absolute crop path to /data/... . The
        # basename is used only within this uniquely identified source+pool.
        leaf = str(crop).replace('\\', '/').rsplit('/', 1)[-1]
        matches = [row for row in rows if str(row[0].get('crop', '')).replace('\\', '/').rsplit('/', 1)[-1] == leaf]
        return matches[0] if len(matches) == 1 else (None, None)
    matches = []
    if evidence.get('raw') is not None or evidence.get('interval') is not None:
        matches = [row for row in rows
                   if (evidence.get('raw') is None or row[0].get('raw_text') == evidence['raw'])
                   and (evidence.get('interval') is None or row[0].get('pulls') == evidence['interval'])
                   and (evidence.get('avatar') is None or row[0].get('avatar_match') == evidence['avatar'])]
    elif kind == 'events' and _integer(event.get('at')):
        matches = [row for row in rows if row[1] == event['at']]
    return matches[0] if len(matches) == 1 else (None, None)


def migrate_legacy_ledger(documents, ledger, *, reviewed=False):
    """Recheck saved event-review diagnostics against the edited ledger.

    No pixels, OCR, scoring, or writes. Source documents remain immutable. A
    different valid current identity is a manual edit; the one automatic
    identity repair requires an unchanged legacy banner inference plus saved,
    accepted avatar/frame evidence. Global review is not event confirmation.
    """
    before = copy.deepcopy(ledger)
    character = ledger.get('character') or {}
    pools = character.get('pools') or []
    # Screenshot water levels are derived from the captured draw history, not
    # independent game state. Only identify unchanged legacy values here;
    # carrying a later manual extension remains an explicit editor operation.
    legacy_water = [pool for pool in pools if 'initialPitySource' not in pool
                    and _integer(pool.get('initialPity')) and 0 <= pool['initialPity'] < 80
                    and (pool.get('evidence') or {}).get('manual') is not True]
    if legacy_water:
        original_pools = build_ledger(documents).get('character', {}).get('pools', [])
        for pool in legacy_water:
            raw, document = _raw_pool_for_current(documents, pool)
            if raw is None or document is None:
                continue
            originals = [original for original in original_pools
                         if original.get('index') == pool.get('index')
                         and original.get('banner') == pool.get('banner')
                         and _summary_source_key(original.get('evidence') or {}) == _summary_source_key(document)]
            if len(originals) == 1 and pool['initialPity'] == originals[0].get('initialPity'):
                pool['initialPitySource'] = 'record-derived'
    corrected, resolved, pending_total = 0, 0, 0
    root_reviews = [i for i in ledger.get('issues', []) if i.get('code') in EVENT_REVIEW_CODES]
    all_event_sources_resolved = bool(pools)
    for pool in pools:
        raw, document = _raw_pool_for_current(documents, pool)
        old_reviews = [i for i in pool.get('issues', []) if i.get('code') in EVENT_REVIEW_CODES]
        raw_reviews = [i for i in (raw or {}).get('issues', []) if i.get('code') in EVENT_REVIEW_CODES]
        generic_review = bool(old_reviews or raw_reviews or (raw or {}).get('needs_review')
                              and any(c in EVENT_REVIEW_CODES for c in raw['needs_review']))
        allowed = _legal_pool_characters(pool.get('banner'))
        pending, changed_identity = [], False
        for kind in ('events', 'rush'):
            originals = _original_event_rows(raw, kind) if raw else []
            for index, event in enumerate(pool.get(kind, [])):
                original, original_at = _match_original_event(event, originals, kind,
                    card_id=(pool.get('evidence') or {}).get('unresolvedCardId'))
                evidence = event.get('evidence') or {}
                event_source = evidence.get('source_sha256')
                if event_source and document is not None and event_source != document.get('source_sha256'):
                    original, original_at = None, None
                name = _canonical_character(event.get('character'))
                old_name = _canonical_character((original or {}).get('character'))
                explicit_manual = _event_has_manual_identity(event)
                manual_identity = explicit_manual or (original is not None and name != old_name and name in allowed)
                derived_review = event.get('reviewDiagnosticsVersion') in DERIVED_REVIEW_VERSIONS
                reason = ((original or {}).get('needs_review') or evidence.get('needsReview')
                          or (event.get('needsReview') if not derived_review else None) or event.get('needs_review'))
                avatar = (original or {}).get('avatar_match') or evidence.get('avatar') or {}
                location = (original or {}).get('avatar_location') or evidence.get('avatarLocation') or {}
                avatar_name = _canonical_character(avatar.get('character'))
                reliable_avatar = (avatar_name in allowed and avatar.get('needs_review') is False
                                   and location.get('needs_review') is False)
                badge = (original or {}).get('offBadgeObserved', (original or {}).get('off'))
                old_source = (original or {}).get('identitySource') or evidence.get('identitySource')
                untouched = (original is not None and not reviewed and not manual_identity
                             and name == old_name and (kind == 'rush' or event.get('at') == original_at)
                             and event.get('identitySource', old_source) == old_source)
                legacy_inference = (kind == 'events' and old_source == 'banner_and_badge'
                                    and old_name == pool.get('up') and badge is False)
                if untouched and legacy_inference and reliable_avatar and avatar_name != name:
                    event['character'] = name = avatar_name
                    event['identitySource'] = 'avatar-saved-evidence'
                    event['identityMigration'] = {'version': RECOGNITION_VERSION,
                                                  'previousCharacter': old_name,
                                                  'basis': 'unchanged-banner-inference-and-accepted-avatar'}
                    changed_identity = True
                    corrected += 1
                position_valid = (kind == 'rush' or _integer(event.get('at'))
                                  and _integer(pool.get('total')) and 1 <= event['at'] <= pool['total'])
                problems = []
                if event_source and document is not None and event_source != document.get('source_sha256'):
                    problems.append('出货证据来源与本池来源不一致')
                if name not in allowed:
                    problems.append('角色身份缺失或不属于本池')
                if not position_valid:
                    problems.append('累计出货位置缺失或无效')
                if not manual_identity:
                    if avatar.get('needs_review') is True or location.get('needs_review') is True:
                        problems.append('保存的头像或定位证据尚未确认')
                    if reliable_avatar and name != avatar_name:
                        problems.append('当前角色与保存的可靠头像不一致')
                    if badge is True and name == pool.get('up'):
                        problems.append('歪字标记与当期UP身份冲突')
                    known_reasons = ('avatar_disagrees_with_missing_off_badge', 'missing_character_or_pulls',
                                     'avatar_frame_not_found_check_source_or_manual_entry',
                                     'avatar_conflicts_with_off_badge', 'avatar_character_not_in_banner',
                                     'banner_identity_unknown')
                    if reason and reason not in known_reasons:
                        problems.append('保留未确认的识别疑点：' + str(reason))
                    elif reason and not reliable_avatar and reason != 'missing_character_or_pulls':
                        problems.append('缺少可解除原识别疑点的头像证据')
                if original is None and generic_review and not explicit_manual:
                    problems.append('无法唯一关联原出货证据，请确认此行')
                if problems:
                    entry = {'source': 'main' if kind == 'events' else 'rush', 'index': index,
                             'at': event.get('at') if kind == 'events' else pool.get('rushAt', 30),
                             'character': event.get('character'), 'reason': '；'.join(dict.fromkeys(problems))}
                    pending.append(entry)
                    event['needsReview'] = entry['reason']
                    event['reviewDiagnosticsVersion'] = RECOGNITION_VERSION
                elif reason or generic_review:
                    event.pop('needsReview', None)
                    event.pop('needs_review', None)
                    event.pop('reviewDiagnosticsVersion', None)
                    event['reviewResolution'] = {'version': RECOGNITION_VERSION,
                        'basis': ('saved-avatar-correction' if event.get('identitySource') == 'avatar-saved-evidence'
                                  and name == avatar_name else 'manual-identity' if manual_identity
                                  else 'current-ledger-and-saved-evidence')}
        if changed_identity:
            saw_up = False
            for event in pool.get('events', []):
                is_up = event.get('character') == pool.get('up')
                event['forced'] = event.get('at') == 120 and not saw_up and is_up
                saw_up |= is_up
        # The per-pool review dialog explicitly confirms every displayed row.
        # A boolean on its own, a numeric edit, or deleting all rows cannot
        # stand in for that confirmation when source evidence is unavailable.
        current_rows = pool.get('events', []) + pool.get('rush', [])
        main_positions = [e.get('at') for e in pool.get('events', [])]
        explicit_pool_confirmation = (
            pool.get('eventReviewConfirmed') is True and bool(current_rows) and not pending
            and all(e.get('identityReviewed') is True for e in current_rows)
            and len(main_positions) == len(set(main_positions)))
        manual_pool = (raw is None and (pool.get('evidence') or {}).get('manual') is True
                       and not pending and (bool(current_rows) or not generic_review)
                       and all(_event_has_manual_identity(event) for event in current_rows))
        all_event_sources_resolved &= raw is not None or explicit_pool_confirmation or manual_pool
        if generic_review and raw is None and not pending and not explicit_pool_confirmation and not manual_pool:
            pending.append({'source': 'pool', 'at': None, 'reason': '缺少原出货证据，旧审核标记待确认'})
        pool['issues'] = [i for i in pool.get('issues', []) if i.get('code') not in EVENT_REVIEW_CODES]
        if pending:
            positions = '、'.join(('加急' if e['source'] == 'rush' else '累计第' + str(e['at']) + '抽')
                                  if e['at'] is not None else '待定位记录' for e in pending)
            pool['issues'].append(issue('event_needs_review',
                f"{pool.get('banner', '卡池')}：{positions}存在待确认出货，请查看对应角色与证据。",
                'error', CHAR_AXES, basis='current-ledger', events=pending))
        else:
            resolved += len(old_reviews)
        pending_total += len(pending)
    # Pool diagnostics now own event review. Unassociated root markers survive
    # when the original sources cannot be verified; provenance is never waived.
    if all_event_sources_resolved:
        ledger['issues'] = [i for i in ledger.get('issues', []) if i.get('code') not in EVENT_REVIEW_CODES]
        character['issues'] = [i for i in character.get('issues', []) if i.get('code') not in EVENT_REVIEW_CODES]
        resolved += len(root_reviews)
    ledger['eventReviewMigrationVersion'] = RECOGNITION_VERSION
    return {'changed': ledger != before, 'correctedIdentities': corrected,
            'resolvedIssues': resolved, 'pendingEvents': pending_total}


def revalidate_ledger_issues(documents, ledger):
    """Keep immutable provenance checks; recalculate editable totals separately.

    Never trust a client's cleared issues list or overwrite reviewed event data
    with the original OCR interpretation. Account/source/overlap conflicts are
    still rebuilt from the saved evidence, exactly as before.
    """
    provenance = build_ledger(documents)
    issues = [i for i in provenance.get('issues', [])
              if i.get('code') != 'character_summary_mismatch'
              and not (i.get('code') == 'unrecognized_pool_card'
                       and _bound_card_pool(documents, ledger, i.get('cardId')) is not None)
              and not (ledger.get('eventReviewMigrationVersion') == RECOGNITION_VERSION
                       and i.get('code') in EVENT_REVIEW_CODES)]
    if ledger.get('eventReviewMigrationVersion') == RECOGNITION_VERSION:
        issues.extend(copy.deepcopy(i) for i in ledger.get('issues', []) if i.get('code') in EVENT_REVIEW_CODES)
    character = ledger.get('character') or {}
    for current_issue in issues:
        if (current_issue.get('code') == 'unrecognized_pool_card'
                and any((pool.get('evidence') or {}).get('unresolvedCardId') == current_issue.get('cardId')
                        for pool in character.get('pools', []))):
            current_issue['message'] = ('本卡片已选择卡池，但原图明细或来源未完整保留；'
                                        '请移除误选的手动池，再从待确认卡片重新选择并核对全部出货。')
    overrides = character.get('summaryOverrides') or []
    known_sources = {_summary_source_key(doc) for doc in documents
                     if isinstance(doc.get('overview', {}).get('character'), dict)}
    if any(_summary_source_key(item) not in known_sources for item in overrides):
        raise ValueError('顶部汇总修正未关联到原始角色截图，请重新打开识别结果。')
    issues.extend(character_summary_issues(documents, character.get('pools', []), overrides))
    return issues


CURRENT_POOL_CODES = {
    'missing_total', 'pool_total_missing', 'event_interval_missing',
    'character_identity_missing', 'events_exceed_pool_total', 'local_tail_conflict',
    'tail_pity_out_of_range', 'initial_pity_out_of_range', 'six_wait_exceeds_80',
    'missing_120_up', 'rush_before_unlock', 'rush_usage_unknown',
    'rush_timing_unknown', 'rush_timing_invalid', 'rush_timing_without_use',
    'rush_records_without_use', 'rush_event_invalid', 'quota_missing',
    'quota_ocr_conflict', 'token_position_unknown', 'token_count_mismatch',
    'inherited_pity_conflict', 'event_source_invalid', 'duplicate_event_position',
    'free_allowance_invalid', 'pool_identity_invalid',
    'raw_pity_plus_pulls_exceeds_80_do_not_autocorrect',
    'banner_identity_unknown', 'rush_interval_exceeds_10',
}
CURRENT_WEAPON_CODES = {'weapon_field_missing', 'weapon_off_exceeds_six',
    'weapon_count_invalid', 'weapon_total_invalid', 'weapon_draw_unit_invalid',
    'weapon_profile_invalid', 'weapon_loss_draws_invalid', 'weapon_pool_count_missing'}


def _remaining_evidence_issues(current, original, replaced):
    """Keep source/opaque evidence even if an old save acknowledged all errors."""
    remaining, seen = [], set()
    for value in [*original, *current]:
        if not isinstance(value, dict):
            raise ValueError('待核对信息格式错误。')
        if value.get('code') in replaced:
            continue
        entry = copy.deepcopy(value)
        if entry.get('resolution') == 'saved-edited-record' and entry.get('originalSeverity') == 'error':
            entry['severity'] = 'error'
            for key in ('reviewed', 'resolution', 'originalSeverity'):
                entry.pop(key, None)
        key = (entry.get('code'), entry.get('field'), entry.get('message'))
        if key not in seen:
            remaining.append(entry)
            seen.add(key)
    return remaining


def _allows_missing_quota(character):
    # Remembered, unquantified five-stars make only the five-star axis partial.
    return (character.get('quotaSummary') is not None or
            any(p.get('manualSupplementFiveUnknown') is True and
                isinstance(p.get('manualSupplementQuotaEvidence'), dict) and
                isinstance(p['manualSupplementQuotaEvidence'].get('summary'), dict) and
                p['manualSupplementQuotaEvidence']['summary'].get('scope') == 'all-pools'
                for p in character.get('pools', [])))


def _current_pool_issues(pool, *, allow_missing_quota=False):
    """Rebuild editable facts from current rows, never from old OCR intervals."""
    result = []
    def add(code, message, axes=CHAR_AXES, **context):
        result.append(issue(code, message, 'error', axes, basis='current-ledger', **context))
    def number(value, low=0, high=2**53 - 1):
        return _integer(value) and low <= value <= high
    total, opening, tail = pool.get('total'), pool.get('initialPity'), pool.get('tail')
    total_valid = number(total, 0, 10000)
    if not total_valid:
        add('pool_total_missing', '卡池总抽数缺失或无效。')
    quota = pool.get('quota')
    if not number(quota) and not ((allow_missing_quota or pool.get('manualSupplementFiveUnknown') is True)
                                  and quota is None):
        add('quota_missing', '武库配额须为非负整数。', ['five'])
    if pool.get('freeAllowance') is not None and (type(pool['freeAllowance']) is not int or pool['freeAllowance'] not in (0, 10, 20)):
        add('free_allowance_invalid', '本池免费额度只支持0、10或20抽。', ['five'])
    if opening is not None and not number(opening, 0, 79):
        add('initial_pity_out_of_range', '期初水位须为0—79的整数，未知时可留空。')
    if tail is not None and not number(tail, 0, 79):
        add('tail_pity_out_of_range', '期末水位须为0—79的整数，未知时可留空。')
    allowed = _legal_pool_characters(pool.get('banner'))
    if pool.get('up') != BANNERS.get(pool.get('banner')) or not allowed:
        add('pool_identity_invalid', '卡池名称或当期UP不在支持名单中。')
    events, rush = pool.get('events', []), pool.get('rush', [])
    positions = [e.get('at') for e in events]
    valid_positions = total_valid and all(number(at, 1, total) for at in positions)
    if not valid_positions and events:
        add('event_interval_missing', '六星累计出货位置须为1至本池总抽数的整数。')
    if total_valid and any(_integer(at) and at > total for at in positions):
        add('events_exceed_pool_total', '六星累计出货位置超过本池总抽数。')
    if len(positions) != len(set(positions)):
        add('duplicate_event_position', '同一累计抽数重复出现六星记录。')
    for kind, rows in (('main', events), ('rush', rush)):
        for index, event in enumerate(rows):
            if _canonical_character(event.get('character')) not in allowed:
                add('character_identity_missing', '六星角色缺失或不属于本池可出名单。',
                    ['up', 'limited'], source=kind, index=index)
            if event.get('source') != kind and not (kind == 'rush' and event.get('source') is None):
                add('event_source_invalid', '六星出货来源与所在列表不一致。', source=kind, index=index)
            if kind == 'rush' and event.get('forced') is True:
                add('rush_event_invalid', '加急出货不能标记为120强制保底。', index=index)
            interval = (event.get('evidence') or {}).get('interval')
            if kind == 'rush' and _integer(interval) and interval > 10:
                add('rush_interval_exceeds_10',
                    f'加急十连中保存了{interval}抽的出货间隔，疑似下一张卡片误并；请按原图移至正确池的主池或删除误录行。',
                    index=index, source='rush', interval=interval)
    if len(rush) > 10:
        add('rush_event_invalid', '独立加急十连最多出现10个六星。')
    used, rush_at = pool.get('rushUsed'), pool.get('rushAt')
    if type(used) is not bool:
        add('rush_usage_unknown', '加急使用状态未知。')
    elif used and total_valid and total < 30:
        add('rush_before_unlock', '本池不足30抽却有加急记录。')
    elif not used and rush:
        add('rush_records_without_use', '未使用加急但存在加急出货。')
    if rush_at is not None:
        if used is False:
            add('rush_timing_without_use', '未使用加急但仍填写了加急时点。')
        elif not total_valid or not number(rush_at, 30, total):
            add('rush_timing_invalid', '加急时点须在30至本池总抽数之间。')
    if valid_positions and len(positions) == len(set(positions)):
        previous = 0
        for event in sorted(events, key=lambda e: e['at']):
            wait = event['at'] - previous + (opening if previous == 0 and number(opening, 0, 79) else 0)
            if wait > 80:
                add('six_wait_exceeds_80', f"累计第{event['at']}抽的六星等待段超过80抽。", at=event['at'])
            previous = event['at']
        derived = total - max(positions) if positions else total + opening if number(opening, 0, 79) else None
        if derived is not None and tail != derived:
            add('local_tail_conflict', f'期末水位与当前主池记录不一致，应为{derived}。', expected=derived, observed=tail)
        if derived is not None and derived >= 80 or derived is None and not events and total >= 80:
            add('tail_pity_out_of_range', '未出六星段达到80抽，疑似漏录六星。')
        if derived is None and number(tail, 0, 79) and tail < total:
            add('local_tail_conflict', '期末水位小于本池已观察到的未出抽数。')
    if total_valid and total >= 120 and not any(
            e.get('character') == pool.get('up') and number(e.get('at'), 1, 120) for e in events):
        add('missing_120_up', '前120抽缺少主池当期UP记录。')
    tokens = pool.get('tokens', [])
    if total_valid:
        expected = list(range(240, total + 1, 240))
        if [t.get('at') for t in tokens] != expected:
            add('token_position_unknown', '信物数量或位置与每240抽的固定节点不一致。', ['limited'])
    return result


def revalidate_current_ledger(documents, ledger, *, reviewed=False):
    """Shared read-only computation for draft validation, save, and restore.

    Returns a fresh ledger copy. It never reads images, calculates
    scores, writes records, or advances session revisions. Source evidence is
    retained while current, repairable diagnostics are replaced each time.
    """
    from service import validate_ledger
    validate_ledger(ledger)
    ledger = copy.deepcopy(ledger)
    ledger['unresolvedCards'] = _unresolved_cards(documents)
    character = ledger.get('character') or {}
    pools = character.get('pools', [])
    for pool in pools:
        for key in ('events', 'rush', 'tokens'):
            if any(not isinstance(row, dict) for row in pool.get(key, [])):
                raise ValueError('出货和信物明细须为对象列表。')
        if not _integer(pool.get('index')):
            raise ValueError('卡池序号须为整数。')
    weapon = ledger.get('weapon')
    if weapon is not None and not isinstance(weapon, dict):
        raise ValueError('武器记录格式错误。')
    migrate_legacy_ledger(documents, ledger, reviewed=reviewed)
    for pool in pools:
        raw, _ = _raw_pool_for_current(documents, pool)
        if ((pool.get('evidence') or {}).get('unresolvedCardId') and raw is not None
                and raw.get('banner') not in BANNERS
                and all(_integer(event.get('at')) for event in pool.get('events', []))):
            saw_up = False
            for event in sorted(pool.get('events', []), key=lambda event:event['at']):
                is_up = event.get('character') == pool.get('up')
                event['forced'] = event['at'] == 120 and not saw_up and is_up
                saw_up |= is_up
        current = pool.get('issues', [])
        remaining = _remaining_evidence_issues(current, (raw or {}).get('issues', []),
                                              CURRENT_POOL_CODES | EVENT_REVIEW_CODES)
        # This specific legacy placeholder was cleared only by the existing
        # explicit per-pool save confirmation, never by typing a numeric field.
        rows = pool.get('events', []) + pool.get('rush', [])
        confirmed = (pool.get('eventReviewConfirmed') is True and bool(rows)
                     and all(e.get('identityReviewed') is True for e in rows)
                     and not any(i.get('code') in EVENT_REVIEW_CODES for i in current))
        if confirmed:
            remaining = [i for i in remaining if i.get('code') != 'placeholder_needs_review']
        pool['issues'] = (remaining + [i for i in current if i.get('code') in EVENT_REVIEW_CODES]
                          + _current_pool_issues(pool, allow_missing_quota=_allows_missing_quota(character)))
    ordered = sorted(pools, key=lambda p: p['index'])
    for index, pool in enumerate(ordered):
        before = ordered[index - 1] if index else None
        linked = before and pool['index'] > before['index'] and (
            pool['index'] == before['index'] + 1 or character.get('completeHistory') is True)
        expected = before.get('tail') if linked else character.get('initialPity') if not index else None
        if expected is not None and pool.get('initialPity') is not None and expected != pool['initialPity']:
            pool['issues'].append(issue('inherited_pity_conflict', '本池期初水位与已填写的前序期末水位不一致。',
                                         'error', CHAR_AXES, basis='current-ledger', expected=expected, observed=pool['initialPity']))
    if weapon is not None:
        source_weapon = build_ledger(documents).get('weapon') or {}
        weapon['issues'] = _remaining_evidence_issues(weapon.get('issues', []), source_weapon.get('issues', []), CURRENT_WEAPON_CODES)
        def weapon_error(code, message, **context):
            weapon['issues'].append(issue(code, message, 'error', WEAPON_AXES, basis='current-ledger', **context))
        for name in ('N', 'K6', 'KU'):
            if not _integer(weapon.get(name)):
                weapon_error('weapon_field_missing', f'武器{name}须为整数。', field=name)
        n, six, up = (weapon.get(name) for name in ('N', 'K6', 'KU'))
        if all(_integer(v) for v in (n, six, up)):
            if not 0 < n <= 30000:
                weapon_error('weapon_total_invalid', '武器总抽数须为1至30000。')
            if not 0 <= up <= six <= n:
                weapon_error('weapon_count_invalid', '武器数量须满足0 ≤ 专武数 ≤ 六星数 ≤ 总抽数。')
            if n % 10 and weapon.get('allowIndividualDraws') is not True:
                weapon_error('weapon_draw_unit_invalid', '截图武器总抽数须为10的倍数；单次申领须明确标记。')
        # Detail/header disagreements remain evidence conflicts until the
        # current total actually reconciles them. B is not used by this score.
        if _integer(n) and n == weapon.get('detailTotal'):
            weapon['issues'] = [i for i in weapon['issues'] if i.get('code') != 'weapon_detail_total_mismatch']
        from weapon_scoring import loss_draws, validated_profile
        try:
            validated_profile(weapon)
        except ValueError as exc:
            weapon_error('weapon_profile_invalid', str(exc))
        try:
            loss_draws(weapon)
        except ValueError as exc:
            weapon['issues'].append(issue('weapon_loss_draws_invalid', str(exc), 'error', ['signature'], basis='current-ledger'))
        weapon['issues'] = [i for i in weapon['issues'] if not (
            i.get('code') == 'weapon_summary_conflict' and i.get('field') == 'upAverage')]
    ledger['issues'] = revalidate_ledger_issues(documents, ledger)
    if ordered:
        first = ordered[0]
        history = character.get('firstPoolHistory') or {}
        first_known = (history.get('poolId') == first.get('id') and history.get('isFirstPool') is True
                       or not history and first['index'] == 0)
        contiguous = all(current['index'] == previous['index']+1 for previous, current in zip(ordered, ordered[1:]))
        exact_zero_gaps = (first['index'] == 0
                           and character.get('historyEvidence') == 'launch_and_exact_category_totals_zero_pull_gaps'
                           and not any(i.get('code') == 'character_summary_mismatch' and i.get('severity') == 'error'
                                       for i in ledger['issues']))
        complete = character.get('completeHistory') is True and (first_known and contiguous or exact_zero_gaps)
        current_issues = character.get('issues', [])
        if complete:
            character['issues'] = [i for i in current_issues if i.get('code') != 'incomplete_history']
        elif not any(i.get('code') == 'incomplete_history' for i in current_issues):
            character.setdefault('issues', []).append(issue('incomplete_history',
                '仅覆盖部分历史：未知开头等待段不计六星等待分，限定不猜期初New；其余已知记录正常评分。',
                'warning', ['characterSix', 'up', 'limited']))
    # Preserve observed fields and source totals in the persisted ledger. Only
    # replace diagnostics of retained pools with their selected scoring scope.
    from history_interruption import project_ledger, refresh_projected_mechanics
    effective, correction = project_ledger(ledger)
    if correction['enabled']:
        refresh_projected_mechanics(effective)
        by_index = {pool['index']: pool for pool in effective['character']['pools']}
        for pool in pools:
            if pool['index'] in by_index:
                pool['issues'] = copy.deepcopy(by_index[pool['index']]['issues'])
    return ledger


def build_ledger(documents) -> dict:
    docs, seen, root_issues = [], set(), []
    for doc in documents:
        sha = doc.get("source_sha256")
        if sha and sha in seen:
            root_issues.append(issue("duplicate_source_ignored", "重复图片已去重。", file=doc.get("file")))
            continue
        if sha:
            seen.add(sha)
        docs.append(doc)
        # A partial image can disagree with the top card until its other pieces
        # are imported. Re-evaluate that comparison against the merged ledger.
        for item in doc.get("issues", []):
            if item.get("code") != "character_summary_mismatch":
                entry = copy.deepcopy(item)
                entry.setdefault("file", doc.get("file"))
                entry.setdefault("source_sha256", doc.get("source_sha256"))
                root_issues.append(entry)
    uids = {str(d["identity"]["uid"]) for d in docs if d.get("identity", {}).get("uid")}
    if len(uids) > 1:
        root_issues.append(issue("account_mismatch", "图片来自不同UID，禁止混合评分。", "error", CHAR_AXES + WEAPON_AXES))
    elif len(docs) > 1 and any(not d.get("identity", {}).get("uid") for d in docs):
        root_issues.append(issue("account_unverified", "部分图片没有识别到UID，需确认同账号后才能合并。", "error", CHAR_AXES + WEAPON_AXES))
    selected = {}
    for doc in docs:
        for raw_pool in doc.get("pools", []):
            banner = raw_pool.get("banner")
            if banner not in BANNERS:
                continue
            if banner in selected:
                old, _ = selected[banner]
                if _pool_signature(old) == _pool_signature(raw_pool):
                    root_issues.append(issue("overlapping_pool_deduplicated", "重叠截图的相同池已去重。", banner=banner))
                else:
                    root_issues.append(issue("overlapping_pool_conflict", "同一卡池的重叠截图数据不同，不能自动拼接或累加。", "error", CHAR_AXES, banner=banner))
                continue
            selected[banner] = (raw_pool, doc)
    names = list(BANNERS)
    selected_indices = sorted(names.index(name) for name in selected)
    complete = bool(selected_indices) and selected_indices == list(range(selected_indices[-1] + 1))
    history_proof = "contiguous_launch_banners" if complete else None
    if selected_indices and selected_indices[0] == 0 and not complete:
        # Some applications omit zero-pull banners. Exact same-category header
        # N and K6 accounting proves they did not hide additional main draws;
        # a mismatched or unreadable card cannot supply that evidence.
        totals_known = all(_integer(raw.get("total")) for raw, _ in selected.values())
        if totals_known:
            total_main = sum(raw["total"] for raw, _ in selected.values())
            total_six = sum(len(raw.get("events", [])) for raw, _ in selected.values())
            cards = [d.get("overview", {}).get("character") for d in docs]
            matching = [s for s in cards if s and s.get("N") == total_main and s.get("K6") == total_six]
            conflicting = [s for s in cards if s and ((s.get("N") is not None and s["N"] != total_main)
                                                     or (s.get("K6") is not None and s["K6"] != total_six))]
            if matching and not conflicting and not any(i.get("severity") == "error" for i in root_issues):
                complete = True
                history_proof = "launch_and_exact_category_totals_zero_pull_gaps"
    character_issues = []
    if selected and not complete:
        character_issues.append(issue("incomplete_history", "仅覆盖部分历史：未知开头等待段不计六星等待分，限定不猜期初New；其余已知记录正常评分。", "warning", ["characterSix", "up", "limited"]))
    previous_pity = 0 if complete else None
    pools = []
    for index in selected_indices:
        raw, doc = selected[names[index]]
        total = raw.get("total")
        local_tail = raw.get("tail")
        # Accept old cached records only when a literal tail label exists.
        if "tail_known" not in raw:
            local_tail = _int_after(r"垫(\d+)", raw.get("header_raw", ""))
        # The formerly unknown default timing now has an explicit user rule.
        # Rebuild timing diagnostics below, including for saved old OCR drafts.
        pool_issues = copy.deepcopy([i for i in raw.get("issues", [])
                                     if i.get("code") not in ("rush_timing_unknown", "rush_timing_invalid", "rush_timing_without_use")])
        initial = previous_pity
        chronological = list(reversed(raw.get("events", [])))
        if chronological and chronological[0].get("pity") is not None:
            explicit = chronological[0]["pity"]
            if initial is not None and explicit != initial:
                pool_issues.append(issue("inherited_pity_conflict", "首个出货的已垫标注与上一池累积水位不一致。", "error", CHAR_AXES,
                                         expected=initial, observed=explicit))
            if initial is None:
                initial = explicit
        events, at, saw_up = [], 0, False
        for event in chronological:
            interval = event.get("pulls")
            if not _integer(interval) or interval < 1:
                pool_issues.append(issue("event_interval_missing", "出货间隔缺失或无效，不能推算累计位置。", "error", CHAR_AXES))
                at = None
            elif at is not None:
                at += interval
            character = event.get("character")
            forced = at == 120 and not saw_up and character == BANNERS[names[index]]
            if character == BANNERS[names[index]]:
                saw_up = True
            if not character:
                pool_issues.append(issue("character_identity_missing", "六星身份尚未确定。", "error", ["up", "limited"]))
            events.append({"at": at, "character": character, "forced": forced, "source": "main",
                           "evidence": _event_evidence(event, doc)})
        if not _integer(total) or total < 0:
            pool_issues.append(issue("pool_total_missing", "卡池总抽数缺失或无效。", "error", CHAR_AXES))
        if _integer(total) and at is not None:
            calculated_local_tail = total - at
            if calculated_local_tail < 0:
                pool_issues.append(issue("events_exceed_pool_total", "出货间隔之和超过本池总抽数。", "error", CHAR_AXES))
            elif local_tail is not None and local_tail != calculated_local_tail:
                pool_issues.append(issue("local_tail_conflict", "池尾垫抽与总抽数减去出货间隔不一致。", "error", CHAR_AXES,
                                         expected=calculated_local_tail, observed=local_tail))
            if local_tail is None and calculated_local_tail >= 0:
                local_tail = calculated_local_tail
        tail = (local_tail if events else initial + total if initial is not None and _integer(total) else None)
        if tail is not None and not 0 <= tail < 80:
            pool_issues.append(issue("tail_pity_out_of_range", "恢复的末水位超出0—79。", "error", CHAR_AXES))
        last = 0
        for event in events:
            if event["at"] is not None and initial is not None:
                wait = event["at"] - last + (initial if last == 0 else 0)
                if wait > 80:
                    pool_issues.append(issue("six_wait_exceeds_80", "出货等待段超过80，保留原始矛盾。", "error", CHAR_AXES))
                last = event["at"]
        if _integer(total) and total >= 120 and not any(e["character"] == BANNERS[names[index]] and e["at"] is not None and e["at"] <= 120 for e in events):
            pool_issues.append(issue("missing_120_up", "已达120抽却未识别到前120抽内的主池UP。", "error", CHAR_AXES))
        rush_used = raw.get("rushUsed")
        if "rushUsed" not in raw:
            rush_used = True if raw.get("rush_present") and (raw.get("rush") or raw.get("rush_no_six")) else False if _integer(total) and total < 30 else None
        rush = [{"character": e.get("character"), "evidence": _event_evidence(e, doc)} for e in reversed(raw.get("rush", []))]
        if rush_used and _integer(total) and total < 30:
            pool_issues.append(issue("rush_before_unlock", "本池不足30抽却有加急记录。", "error", CHAR_AXES))
        if rush_used is None and not any(i["code"] == "rush_usage_unknown" for i in pool_issues):
            pool_issues.append(issue("rush_usage_unknown", "加急使用状态未知。", "error", CHAR_AXES))
        rush_at, rush_evidence, rush_issues = _rush_timing(raw, total, rush_used)
        pool_issues.extend(rush_issues)
        quota = raw.get("quota", _int_after(r"产出[^0-9]*(\d+)", raw.get("header_raw", "")))
        if quota is None and not any(i["code"] == "quota_missing" for i in pool_issues):
            pool_issues.append(issue("quota_missing", "缺少本池武库配额产出。", "error", ["five"]))
        token_count = raw.get("token_count", 0)
        tokens = []
        for n in range(token_count):
            token_at = 240 * (n + 1)
            if not _integer(total) or token_at > total:
                token_at = None
                pool_issues.append(issue("token_position_unknown", "信物数量与节点不符，不能猜填位置。", "error", ["limited"]))
            tokens.append({"at": token_at, "source": "token", "evidence": {"source_sha256": doc.get("source_sha256"), "inferredFrom": "recognized_gift_and_fixed_240_node"}})
        if _integer(total) and total // 240 != token_count:
            pool_issues.append(issue("token_count_mismatch", "已达信物节点但识别数量不符，规划结果需核对。", axes=[]))
        pool = {"id": f"banner-{index}", "banner": names[index], "index": index, "up": BANNERS[names[index]],
                "total": total, "tail": tail, "localTail": local_tail, "quota": quota,
                "initialPity": initial, "initialPitySource": "record-derived",
                "events": events, "rushUsed": rush_used, "rushAt": rush_at,
                "rushTimingEvidence": rush_evidence,
                "rush": rush, "tokens": tokens, "issues": pool_issues,
                "evidence": {**copy.deepcopy(raw.get("evidence", {})),
                             "source_sha256": doc.get("source_sha256"), "file": doc.get("file"),
                             "sourceImage": doc.get("sourceImage", raw.get("evidence", {}).get("sourceImage")),
                             "header": raw.get("header_raw")}}
        pools.append(pool)
        previous_pity = tail
    if pools:
        root_issues.extend(character_summary_issues(docs, pools))
    # Weapon top cards on a character screenshot may enrich a weapon screenshot,
    # but cannot supply B. Never add top-card totals across overlapping images.
    weapon_candidates = []
    for document in docs:
        if document.get("weapon"):
            candidate = copy.deepcopy(document["weapon"])
            recovered = recover_weapon_average(candidate)
            if recovered:
                candidate["upAverage"] = recovered["value"]
                candidate["upAverageEvidence"] = recovered["evidence"]
            candidate.setdefault("evidence", {}).update({
                "sourceImage": document.get("sourceImage", candidate.get("evidence", {}).get("sourceImage")),
                "source_sha256": document.get("source_sha256"), "file": document.get("file"),
            })
            weapon_candidates.append(candidate)
    weapon = None
    if weapon_candidates:
        weapon = max(weapon_candidates, key=lambda w: (w.get("B") is not None, len(w.get("sections", []))))
        weapon.setdefault("issues", [])
        weapon["issues"] = [i for i in weapon["issues"] if i.get("code") != "weapon_pool_count_missing"]
        for other in weapon_candidates:
            for key in ("N", "K6", "KU", "upAverage"):
                if weapon.get(key) is None:
                    weapon[key] = other.get(key)
                    if key == "upAverage" and other.get(key) is not None:
                        weapon["upAverageEvidence"] = copy.deepcopy(other.get("upAverageEvidence"))
                elif key != "upAverage" and other.get(key) is not None and weapon[key] != other[key]:
                    weapon["issues"].append(issue("weapon_summary_conflict", "多张截图的武器汇总不同，不能混用。", "error", WEAPON_AXES, field=key))
        if weapon.get("B") is None:
            weapon["issues"].append(issue("weapon_pool_count_missing", "实际武器池数未知，普通模式可用固定10池参照；精确保底修正需补齐。", "warning", WEAPON_AXES))
        for key in ("N", "K6", "KU"):
            if weapon.get(key) is None:
                weapon["issues"].append(issue("weapon_field_missing", f"武器{key}未识别。", "error", WEAPON_AXES, field=key))
    unresolved_cards = _unresolved_cards(docs)
    for card in unresolved_cards:
        root_issues.append(issue('unrecognized_pool_card',
            '发现独立卡片但未确认卡池名称，内容已隔离保留；请选择对应卡池并核对本卡出货。',
            'error', CHAR_AXES, cardId=card['id'], bannerRaw=card['bannerRaw'],
            total=card['total'], evidence=copy.deepcopy(card['evidence'])))
    return {"schemaVersion": "gacha-ledger-v1", "identity": {"uid": next(iter(uids)) if len(uids) == 1 else None},
            "sources": [{"file": d.get("file"), "source_sha256": d.get("source_sha256"), "kind": d.get("kind"),
                         "sourceImage": d.get("sourceImage"), "timing": d.get("timing")} for d in docs],
            "character": {"pools": pools, "initialPity": 0 if complete else None,
                          "initialOwned": [] if complete else None, "completeHistory": complete,
                          "historyEvidence": history_proof, "issues": character_issues},
            "weapon": weapon, "issues": root_issues, "unresolvedCards":unresolved_cards}
