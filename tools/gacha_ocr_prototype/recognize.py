"""Local, no-LLM Xiaohēihé character-record prototype. No scoring.

Recognition never imports truth_*.json. Coordinates refer to normalized width 1000.
"""
from __future__ import annotations
import argparse
import difflib
import hashlib
import json
import re
import time
from pathlib import Path

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR
from avatar_locator import locate_avatar

ROOT = Path(__file__).resolve().parent
BANNERS = {
    "烟火邀星河": "明河",
    "万物更新": "祀",
    "冬猎": "提弗洛斯", "晨星于此闪耀": "梨诺", "临渊望北": "诀",
    "逐罪者": "卡缪", "拳出无悔": "弭弗", "春雷动，万物生": "庄方宜",
    "狼珀": "洛茜", "河流的女儿": "汤汤", "热烈色彩": "伊冯",
    "轻飘飘的信使": "洁尔佩塔", "熔火灼痕": "莱万汀",
}
COMMON_CHARACTERS = frozenset(("余烬", "黎风", "艾尔黛拉", "别礼", "骏卫"))


def banner_characters(banner):
    """Legal six-star identities, including the first two banners' exceptions."""
    ordered = list(reversed(BANNERS))
    if banner not in BANNERS:
        return frozenset()
    index = ordered.index(banner)
    limited = ordered[:3] if index < 2 else ordered[index-2:index+1]
    return COMMON_CHARACTERS | {BANNERS[name] for name in limited}


def resolve_avatar_identity(banner, match, off_badge, location_ok=True):
    """Use an accepted legal portrait; missing text is not evidence of an UP.

    The matcher's acceptance thresholds remain unchanged and are not calibrated
    probabilities. A candidate alone, or a fallback crop, cannot fill identity.
    """
    result = {"character": None, "off": None, "identitySource": "unknown",
              "offBadgeObserved": bool(off_badge)}
    if not location_ok:
        result["needs_review"] = "avatar_frame_not_found_check_source_or_manual_entry"
    elif not match.get("character") or match.get("needs_review") is not False:
        result["needs_review"] = "avatar_identity_unresolved"
    elif match["character"] not in banner_characters(banner):
        result["needs_review"] = "avatar_character_not_in_banner"
    else:
        result.update(character=match["character"],
                      off=match["character"] != BANNERS[banner], identitySource="avatar")
        # An observed contradictory badge still warrants review. Its absence
        # must never override an accepted off-banner portrait.
        if off_badge and not result["off"]:
            result["needs_review"] = "avatar_conflicts_with_off_badge"
    return result

def read_image(path):
    im = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if im is None:
        raise ValueError(f"Cannot read {path}")
    return cv2.resize(im, (1000, round(im.shape[0] * 1000 / im.shape[1])), interpolation=cv2.INTER_AREA)

def save_image(path, im):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode(path.suffix, im)[1].tofile(path)

def ocr_tiles(engine, im):
    found = []
    height = im.shape[0]
    for y in range(0, height, 1250):
        crop = im[y:min(y+1450, height)]
        if crop.shape[0] < 40:
            continue
        rows, _ = engine(crop, use_cls=False)
        for pts, txt, conf in rows or []:
            pts = np.array(pts)
            pts[:, 1] += y
            x0, yy0 = pts.min(axis=0)
            x1, yy1 = pts.max(axis=0)
            cy = float((yy0+yy1)/2)
            cx = float((x0+x1)/2)
            item = dict(text=txt, confidence=float(conf), box=[float(x0),float(yy0),float(x1),float(yy1)], x=cx,y=cy)
            duplicate = next((r for r in found if abs(r['y']-cy)<12 and abs(r['x']-cx)<25), None)
            if duplicate:
                if item['confidence']>duplicate['confidence']:
                    duplicate.update(item)
            else:
                found.append(item)
    return sorted(found,key=lambda r:(r['y'],r['x']))

def clean(text):
    return re.sub(r"[^\u4e00-\u9fff0-9]", "", text)

def banner_from_text(text):
    text = clean(text)
    matches = []
    for banner in BANNERS:
        b = clean(banner)
        score = 1.0 if b in text else difflib.SequenceMatcher(None, b, text[:len(b)]).ratio()
        if score >= 0.65 and len(text)>=len(b)-1:
            matches.append((score, banner))
    return max(matches,default=(0,None))

def _compact_bar_column(mask, im):
    """Find a compact results column using its portraits, then recover fused rows."""
    # In a wide layout the card stretches horizontally while pull rows remain
    # compact. Use the row height for geometry; five-star thumbnail strips
    # below a result do not have a large square portrait beside the strip.
    compact_mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 5), np.uint8))
    contours, _ = cv2.findContours(compact_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    anchors = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if (x >= 95 or h < 15 or not 1.9*h <= x <= 3.3*h or w < 1.8*h
                or cv2.contourArea(contour)/(w*h) <= .7):
            continue
        if not locate_avatar(im, (x, y, w, h))['needs_review']:
            anchors.append((x, h))
    if not anchors:
        return [], 0

    def neighbours(anchor):
        left, height = anchor
        return [(x, h) for x, h in anchors if abs(x-left) <= 3 and abs(h-height) <= .2*height]

    aligned = max((neighbours(anchor) for anchor in anchors), key=len)
    left, height = np.median(aligned, axis=0).round().astype(int)
    compact_mask[:, :left] = 0
    separated, _ = cv2.findContours(compact_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bars = []
    for contour in separated:
        x, y, w, h = cv2.boundingRect(contour)
        if (abs(x-left) <= 3 and .8*height <= h <= 1.2*height and w >= 1.8*h
                and cv2.contourArea(contour)/(w*h) > .7):
            bars.append([x,y,w,h])
    return bars, len(aligned)


def find_bars(im):
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    # Saturated coloured result bars; erase letters but do not join separate rows.
    color_mask = ((hsv[:,:,1]>105)&(hsv[:,:,2]>120)).astype(np.uint8)*255
    mask = cv2.morphologyEx(color_mask, cv2.MORPH_CLOSE, np.ones((3,13),np.uint8))
    contours,_ = cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    bars=[]
    for c in contours:
        x,y,w,h=cv2.boundingRect(c)
        if 95 <= x <= 300 and 95<=w<=750 and 25<=h<=85 and w/h>=1.5:
            fill=cv2.contourArea(c)/(w*h)
            if fill>.7:
                bars.append([x,y,w,h])
    compact_bars, compact_support = _compact_bar_column(color_mask, im)
    if compact_support:
        # A summary badge is not a vote for the regular layout. Compare the
        # strongest columns using independently located portrait frames in both.
        regular_lefts = [b[0] for b in bars if not locate_avatar(im, b)['needs_review']]
        regular_support = max((sum(abs(other-x) <= 3 for other in regular_lefts)
                               for x in regular_lefts), default=0)
        if compact_support > regular_support:
            return sorted(compact_bars, key=lambda b: b[1])
    # A coloured portrait can touch a bar after closing and turn it into a
    # too-wide component. Learn the common bar column from intact rows, split
    # off everything to its left, and recover only previously absent rows.
    if len(bars) >= 3:
        left = int(round(float(np.median([b[0] for b in bars]))))
        split_mask = mask.copy()
        split_mask[:, :left] = 0
        separated, _ = cv2.findContours(split_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in separated:
            x,y,w,h = cv2.boundingRect(contour)
            if (abs(x-left) <= 4 and 95 <= w <= 750 and 25 <= h <= 85
                    and w/h >= 1.5 and cv2.contourArea(contour)/(w*h) > .7
                    and not any(abs((y+h/2)-(b[1]+b[3]/2)) < max(h,b[3])*.5 for b in bars)):
                bars.append([x,y,w,h])
    return sorted(bars,key=lambda b:b[1])

def nearby(rows, y, tolerance=24, xmin=0, xmax=1000):
    return sorted([r for r in rows if abs(r['y']-y)<tolerance and xmin<=r['x']<=xmax],key=lambda r:r['x'])

def first_number(text):
    m=re.search(r"\d+",text)
    return int(m.group()) if m else None

def overview(rows):
    label=next((r for r in rows if clean(r['text'])=='限定' and r['x']<400),None)
    result={'main_total':None,'main_six':None,'main_off':None}
    if not label:
        return result
    col=[r for r in rows if abs(r['x']-label['x'])<135 and label['y']<r['y']<label['y']+230]
    total=next((r for r in col if re.search(r'\d+\s*抽',r['text'])),None)
    if total:
        result['main_total']=first_number(total['text'])
    pair=next((r for r in col if re.search(r'\d+\s*/\s*\d+',r['text'])),None)
    if pair:
        a,b=re.search(r'(\d+)\s*/\s*(\d+)',pair['text']).groups()
        result.update(main_six=int(a),main_off=int(b))
    return result

def card_headings(im, rows):
    """Separate cards even when OCR cannot read their banner title.

    A total line supplies a boundary, never an identity. Only an independently
    located and accepted header portrait may recover a damaged title.
    """
    headings=[]
    for row in rows:
        if row['box'][0]>250:
            continue
        confidence, banner=banner_from_text(row['text'])
        if banner and not any(abs(row['y']-h['y'])<35 for h in headings):
            headings.append(dict(banner=banner,y=row['y'],confidence=confidence,raw=row['text']))
    totals=[]
    for row in sorted(rows,key=lambda r:r['y']):
        if row['box'][0]<=250 and re.search(r'合计\s*\d+\s*抽',row['text']):
            if totals and abs(totals[-1]['y']-row['y'])<18:
                if row.get('confidence',0)>totals[-1].get('confidence',0):
                    totals[-1]=row
            else:
                totals.append(row)
    for total in totals:
        previous=[h for h in headings if 0<=total['y']-h['y']<120 and 'totalRow' not in h]
        if previous:
            max(previous,key=lambda h:h['y'])['totalRow']=total
            continue
        from header_avatar import recover_header_banner
        portrait=recover_header_banner(im,total,{up:banner for banner,up in BANNERS.items()})
        banner=portrait.get('banner') if portrait.get('needs_review') is False else None
        if not banner and not headings:
            # Weapon-only/unsupported layouts can also contain totals.
            continue
        if banner and any(h['banner']==banner for h in headings):
            portrait={**portrait,'needs_review':True,'reason':'duplicate_banner_identity'}
            banner=None
        # Partial title text is retained as evidence, never guessed from dates.
        title_rows=[r for r in rows if r['box'][0]<=250 and 0<total['y']-r['y']<100
                    and not re.search(r'\d+\s*抽|免费.*[十连]',r['text'])
                    and banner_from_text(r['text'])[1] is None]
        title=max(title_rows,key=lambda r:r['y']) if title_rows else None
        headings.append({'banner':banner,'y':title['y'] if title else total['box'][1]-1,
                         'confidence':None,'raw':title['text'] if title else '',
                         'totalRow':total,'bannerIdentity':portrait})
    return sorted(headings,key=lambda h:h['y'])


def parse(im, rows, output_dir):
    headings=card_headings(im,rows)
    bars=find_bars(im)
    pools=[]
    for i, heading in enumerate(headings):
        start=heading['y']; end=headings[i+1]['y'] if i+1<len(headings) else im.shape[0]
        section=[r for r in rows if start<r['y']<end]
        total_row=heading.get('totalRow') or next((r for r in section if '合计' in r['text'] and r['y']<start+120),None)
        header=''.join(r['text'] for r in nearby(rows,total_row['y'],20,xmax=620)) if total_row else ''
        m=re.search(r'合计\s*(\d+)\s*抽',header)
        t=re.search(r'垫\s*(\d+)',header)
        pool=dict(banner=heading['banner'],total=int(m[1]) if m else None,tail=int(t[1]) if t else 0,
                  header_raw=header,banner_raw=heading['raw'],events=[],rush=[],rush_present=False,token_count=0,needs_review=[])
        total_y=total_row['y'] if total_row else start
        pool.update(cardId=f'card-{round(total_y)}',cardBoundary={'startY':start,'endY':end,'totalY':total_y})
        if heading.get('bannerIdentity') is not None:
            pool['evidence']={'bannerIdentity':heading['bannerIdentity']}
        if pool['banner'] is None:
            pool['needs_review'].append('banner_identity_unknown')
        rush_rows=[r for r in section if '免费' in r['text'] and ('十' in r['text'] or '连' in r['text'])]
        rush_y=min((r['y'] for r in rush_rows),default=end)
        pool['rush_present']=bool(rush_rows)
        pool_bars=[b for b in bars if start+35<b[1]<end]
        for j,(x,y,w,h) in enumerate(pool_bars):
            cy=y+h/2
            line=nearby(rows,cy,max(22,h*.6),xmin=x-10)
            inside=[r for r in line if r['box'][0]<x+min(w,180)]
            raw=''.join(r['text'] for r in inside)
            num=re.search(r'(\d+)\s*抽',raw)
            pulls=int(num[1]) if num else first_number(raw)
            texts=''.join(r['text'] for r in line)
            pity=re.search(r'已垫\s*(\d+)',texts)
            location=locate_avatar(im, [x,y,w,h])
            ax,ay,aw,ah=location['box']
            crop=im[ay:ay+ah,ax:ax+aw]
            # Unknown/no-hit portraits are greyscale; do not turn X/? into a character.
            sat=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)[:,:,1]
            is_hit=float(np.mean(sat>25))>.08
            entry=dict(pulls=pulls,pity=int(pity[1]) if pity else None,raw_text=texts,
                       box=[x,y,w,h],avatar_box=[ax,ay,aw,ah],avatar_location=location,
                       avatar_saturation=float(np.mean(sat>45)))
            crop_path=output_dir/'crops'/f'{i:02}_{j:02}.png'
            save_image(crop_path,crop)
            entry['crop']=str(crop_path.resolve())
            # Keep incomplete screenshot evidence even for a no-hit placeholder;
            # do not suppress its fallback warning by returning early below.
            if location['needs_review']:
                entry['needs_review']='avatar_frame_not_found_check_source_or_manual_entry'
            if not is_hit:
                entry['kind']='no_six'
                if cy<rush_y:
                    pool['open_interval']=entry
                else:
                    pool['rush_no_six']=entry
                continue
            entry['kind']='six'
            off_badge='歪' in texts
            try:
                from avatar_match import match_avatar
                match=match_avatar(crop)
            except (ImportError,FileNotFoundError) as exc:
                match={'needs_review':True,'reason':str(exc)}
            entry['avatar_match']=match
            if pool['banner'] is None:
                accepted=location.get('needs_review') is False and match.get('needs_review') is False and match.get('character')
                entry.update(character=match.get('character') if accepted else None,off=None,
                             identitySource='avatar' if accepted else 'unknown',offBadgeObserved=off_badge)
                entry.setdefault('needs_review','banner_identity_unknown' if accepted else 'avatar_identity_unresolved')
            else:
                entry.update(resolve_avatar_identity(pool['banner'], match, off_badge,
                                                      location_ok=location.get('needs_review') is False))
            if pulls is None:
                entry.setdefault('needs_review','missing_character_or_pulls')
            pool['rush' if cy>=rush_y else 'events'].append(entry)
        # A gift is not a random hit. Keep separately, and do not infer from a pull threshold.
        gifts=[r for r in section if clean(r['text'])=='赠' and r['y']<rush_y]
        pool['token_count']=len(gifts)
        if pool['total'] is None:
            pool['needs_review'].append('missing_total')
        if any(e.get('needs_review') for e in pool['events']+pool['rush']):
            pool['needs_review'].append('event_needs_review')
        if any(pool.get(key,{}).get('needs_review') for key in ('open_interval','rush_no_six')):
            pool['needs_review'].append('placeholder_needs_review')
        for event in pool['events']:
            if event['pity'] is not None and event['pulls'] is not None and event['pity']+event['pulls']>80:
                pool['needs_review'].append('raw_pity_plus_pulls_exceeds_80_do_not_autocorrect')
        pools.append(pool)
    return pools

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('inputs',nargs='+',type=Path)
    ap.add_argument('--output',type=Path,default=ROOT/'results')
    ap.add_argument('--reuse-ocr',action='store_true',help='DEBUG ONLY: excludes OCR work, never use as end-to-end benchmark')
    args=ap.parse_args()
    start=time.perf_counter()
    engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1,use_cls=False)
    model_init=time.perf_counter()-start
    summary=[]
    for path in args.inputs:
        tick=time.perf_counter()
        out=args.output/path.stem
        out.mkdir(parents=True,exist_ok=True)
        im=read_image(path)
        raw_path=out/'ocr_raw.json'
        reused=args.reuse_ocr and raw_path.exists()
        ocr_start=time.perf_counter()
        rows=json.loads(raw_path.read_text(encoding='utf-8')) if reused else ocr_tiles(engine,im)
        ocr_seconds=time.perf_counter()-ocr_start
        raw_path.write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
        parse_start=time.perf_counter()
        pools=parse(im,rows,out)
        result=dict(file=path.name,source_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),pools=pools,
                    timing=dict(ocr_seconds=ocr_seconds,parse_seconds=time.perf_counter()-parse_start,
                                total_seconds=time.perf_counter()-tick,ocr_cache_used=reused))
        result['counts']=dict(pools=len(pools),main_six=sum(len(p['events']) for p in pools),
                              main_off=sum(e.get('off') is True for p in pools for e in p['events']),rush_six=sum(len(p['rush']) for p in pools))
        result['overview']=overview(rows)
        result['validation']=[]
        for key in ('main_six','main_off'):
            if result['overview'][key] is not None and result['overview'][key]!=result['counts'][key]:
                result['validation'].append(f'overview_{key}_mismatch')
        if result['overview']['main_total'] is not None and all(p['total'] is not None for p in pools):
            if sum(p['total'] for p in pools)!=result['overview']['main_total']:
                result['validation'].append('overview_main_total_mismatch')
        (out/'record.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        summary.append(dict(file=path.name,**result['counts'],**result['timing']))
        print(json.dumps(summary[-1],ensure_ascii=False),flush=True)
    report=dict(model_init_seconds=model_init,batch_seconds=time.perf_counter()-start,files=summary,
                scope='characters only; no scoring; no five-star counts; no weapon parsing',prototype='v2-template-registration',
                code_sha256={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['recognize.py','avatar_match.py','avatar_locator.py']})
    (args.output/'run_summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    main()
