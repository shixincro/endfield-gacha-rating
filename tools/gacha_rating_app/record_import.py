"""Import supported local draw exports without OCR, network access or file writes.

Every source row remains in the returned document. Source rarity encodings are
format-specific; derived pity and exporter overview totals are never trusted as
game state. Unproved opening scope never supplies missing milestone rewards.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
import copy
import hashlib
import json
from pathlib import PurePath
import time
import uuid

from importer import BANNERS, CHAR_AXES, WEAPON_AXES, RECOGNITION_VERSION, build_ledger

MAX_ROWS = 100000
WEAPON_UPS = {
    '熔铸申领': '熔铸火焰', '迅行申领': '使命必达', '染赤申领': '镀红祝福',
    '新芽申领': '落草', '绯珀申领': '狼之绯', '行舟申领': '孤舟',
    '绛结申领': '赤缨', '军列申领': '四二式·肃阵', '明曜申领': '曜夜的首演',
    '幽寒申领': '寒夜幽影', '点绘申领': '艺术暴君', '篆玉申领': '玉中身',
    '星声申领': '沧溟星梦', '坚冰申领': '赫拉芬格', '远途申领': '不知归',
    '崇山申领': '负山', '雷鸣申领': '大雷斑',
}
CONSTANT_WEAPONS = {'星声申领', '坚冰申领', '远途申领', '崇山申领', '雷鸣申领'}


class UnsupportedRecordFormat(ValueError):
    code = 'record_format_unrecognized'

    def __init__(self):
        super().__init__('暂不支持此记录格式，请联系作者协助适配。')


def _integer(value, label, minimum=0):
    if isinstance(value, bool):
        raise ValueError(f'{label}不是有效整数。')
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{label}不是有效整数。') from None
    if str(number) != str(value) or number < minimum:
        raise ValueError(f'{label}不是有效整数。')
    return number


def _boolean(value, label):
    if value in (True, False, 0, 1) and type(value) in (bool, int):
        return bool(value)
    raise ValueError(f'{label}须为 true/false 或 0/1。')


def _decimal(value):
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise ValueError('批次时间戳无效。') from None
    if not number.is_finite():
        raise ValueError('批次时间戳无效。')
    return number


def _name(value):
    return value.strip() if isinstance(value, str) else ''


def _unknown_name(value):
    return not value or str(value).startswith('未知') or str(value).lower() in ('unknown', 'unidentified', '?')


def _character_scope(definition, group):
    """Rerun and celebration records remain auxiliary, even with a reused name."""
    metadata = [definition]
    metadata.extend(row['sourceRow'] for row in group if isinstance(row.get('sourceRow'), dict))
    values = [str(definition.get(key, '')) for key in ('name', 'id', 'type', 'sourcePoolType', 'sourceGroup')]
    for item in metadata:
        values.extend(str(item.get(key, '')) for key in
                      ('poolName', 'poolType', 'sourcePoolType', 'sourcePoolTypeRequest', 'sourceGroup'))
    text = ' '.join(values).lower()
    if ('复刻' in text or 'rerun' in text or 'reprint' in text or definition['name'] == '绚丽异彩'
            or any(item.get('isRerun') is True or item.get('isReprint') is True for item in metadata)):
        return 'auxiliary-reprint'
    if ('庆典' in text or 'celebration' in text
            or any(item.get('isCelebration') is True for item in metadata)):
        return 'auxiliary-celebration'
    return 'regular-character' if definition['name'] in BANNERS else 'auxiliary-character'


def _problem(code, message, axes=(), severity='warning', **extra):
    return {'code': code, 'message': message, 'severity': severity, 'axes': list(axes), **extra}


def _base_row(kind, banner, name, rarity, rush, source, **extra):
    if kind not in ('character', 'weapon') or not isinstance(banner, str) or not banner.strip():
        raise ValueError('记录缺少卡池名称或类别。')
    if rarity is not None:
        rarity = _integer(rarity, '稀有度')
    return {'kind': kind, 'banner': banner.strip(), 'name': _name(name), 'rarity': rarity,
            'isRush': _boolean(rush, '加急标记'), 'sourceRow': copy.deepcopy(source), **extra}


def _parse_batch(data):
    wrapped = isinstance(data.get('data'), dict) and isinstance(data.get('info'), dict)
    batches = data['data'] if wrapped else data
    if not batches or not all(isinstance(v, dict) and 'c' in v and 'p' in v for v in batches.values()):
        raise UnsupportedRecordFormat()
    rows, definitions = [], {}
    for stamp, batch in sorted(batches.items(), key=lambda item: _decimal(item[0])):
        entries = batch['c']
        if not isinstance(entries, list) or not entries:
            raise ValueError('批次没有有效抽取条目。')
        banner = batch['p']
        kind = 'weapon' if batch.get('ci') == '__weapon' or str(banner).endswith('申领') else 'character'
        expected = 3 if kind == 'weapon' else 4
        sequence = _integer(batch['seq'], '批次末序号', 1) if batch.get('seq') is not None else None
        if sequence is not None and sequence < len(entries):
            raise ValueError('批次末序号小于批次条目数。')
        pid = str(batch.get('pi') or banner)
        definitions.setdefault(pid, {'name': banner, 'kind': kind, 'id':pid,
                                     'sourcePoolType':batch.get('ci')})
        for index, entry in enumerate(entries):
            if not isinstance(entry, list) or len(entry) != expected:
                raise ValueError(f'{banner}的批次条目应有{expected}列。')
            rarity = _integer(entry[1], '源稀有度')
            if rarity not in (2, 3, 4, 5):
                raise ValueError('此批次格式的源稀有度应为 2—5。')
            rows.append(_base_row(kind, banner, entry[0], rarity + 1, entry[3] if kind == 'character' else False,
                entry, poolId=pid, sourceId=f'batch:{stamp}:{index+1}', timestamp=str(stamp),
                sequence=sequence-len(entries)+index+1 if sequence is not None else None,
                batchId=str(stamp), isNew=_boolean(entry[2], 'New标记')))
    info = data.get('info', {}) if wrapped else {}
    identity = {'uid': str(info['uid']) if info.get('uid') else None,
                'name': _name(info.get('nickName') or info.get('name')), 'server': info.get('channel')}
    return rows, definitions, identity, 'timestamp-batch-json', True, False


def _parse_txt(text):
    batches = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split(',', 2)
        if len(fields) != 3:
            if not batches:
                raise UnsupportedRecordFormat()
            raise ValueError(f'TXT 第{number}行不是“时间戳,卡池,条目”的记录格式。')
        stamp, banner, encoded = fields
        try:
            _decimal(stamp)
        except ValueError:
            if not batches:
                raise UnsupportedRecordFormat() from None
            raise
        if stamp in batches:
            raise ValueError(f'TXT 第{number}行时间戳重复，无法安全合并。')
        weapon = banner.endswith('申领')
        entries = []
        for item in encoded.split('@'):
            values = item.rsplit('-', 2 if weapon else 3)
            if len(values) != (3 if weapon else 4):
                raise ValueError(f'TXT 第{number}行条目列数不正确。')
            entries.append([values[0], *[_integer(v, f'TXT第{number}行数值') for v in values[1:]]])
        batches[stamp] = {'p': banner, 'c': entries}
    rows, definitions, identity, _, _, partial = _parse_batch(batches)
    return rows, definitions, identity, 'timestamp-batch-txt', False, partial


def _parse_v3(data):
    if not isinstance(data.get('pools'), list) or not isinstance(data.get('history'), list):
        raise ValueError('internal_json_v3 缺少 pools/history 列表。')
    accounts = data.get('accounts', [])
    if not isinstance(accounts, list) or len(accounts) > 1:
        raise ValueError('此文件含多个账号，请按账号分别导出后导入。')
    uids = {str(r.get('gameUid')) for r in data['history'] if isinstance(r, dict) and r.get('gameUid') is not None}
    if len(uids) > 1:
        raise ValueError('此文件含多个游戏 UID，请按账号分别导出后导入。')
    definitions = {}
    for definition in data['pools']:
        if not isinstance(definition, dict) or not definition.get('id') or not definition.get('name'):
            raise ValueError('卡池定义缺少 id/name。')
        pid = str(definition['id'])
        if pid in definitions:
            raise ValueError('卡池定义的 id 重复。')
        definitions[pid] = {**definition, 'kind': 'weapon' if definition.get('type') == 'weapon' else 'character'}
    rows, seen = [], set()
    for raw in data['history']:
        if not isinstance(raw, dict):
            raise ValueError('抽取记录不是对象。')
        pid = str(raw.get('poolId', ''))
        if pid not in definitions:
            raise ValueError(f'记录引用了未定义的卡池：{pid}。')
        definition = definitions[pid]
        seq = _integer(raw.get('seqId'), '抽取序号', 1)
        key = (pid, seq)
        if key in seen:
            raise ValueError(f'{definition["name"]}有重复序号，无法安全合并。')
        seen.add(key)
        rows.append(_base_row(definition['kind'], definition['name'], raw.get('name'), raw.get('rarity'),
            raw.get('isFree', False), raw, poolId=pid, sourceId=str(raw.get('id', f'{pid}:{seq}')),
            sequence=seq, timestamp=raw.get('timestamp'), batchId=raw.get('batchId'),
            isNew=raw.get('isNew'), explicitReward=raw.get('specialType') == 'gift'))
    account = accounts[0] if accounts else {}
    identity = {'uid': next(iter(uids), None), 'name': _name(account.get('nickName') or account.get('nickname') or account.get('name')),
                'server': account.get('server') or account.get('serverTag') or account.get('channelName')}
    return rows, definitions, identity, 'internal-json-v3', False, False


def _parse_api(data, enduid=False):
    container = data.get('data')
    definitions, rows, seen = {}, [], set()
    if enduid:
        if not isinstance(container, dict) or not all(isinstance(group, list) for group in container.values()):
            raise ValueError('EndUID data 须为按类别分组的列表。')
        raw_rows = [(group, row) for group, values in container.items() for row in values]
        identity = {'uid': str(data['uid']) if data.get('uid') else None, 'name': _name(data.get('nickName'))}
        partial = False
    else:
        if data.get('code', 0) != 0 or not isinstance(container, dict) or not isinstance(container.get('list'), list):
            raise ValueError('接口导出缺少有效 data.list，或接口返回错误。')
        raw_rows = [('', row) for row in container['list']]
        identity = {'uid': None, 'sourceUid': container.get('uid'),
                    'name': _name(container.get('nickName')), 'server': container.get('server')}
        partial = container.get('hasMore') is True
    for group, raw in raw_rows:
        if not isinstance(raw, dict):
            raise ValueError('抽取记录不是对象。')
        kind = 'weapon' if 'weaponName' in raw or group.startswith('武器寻访-') else 'character'
        if 'weaponName' in raw and 'charName' in raw:
            raise ValueError('同一记录同时含角色和武器字段，无法确定类别。')
        seq = _integer(raw.get('seqId'), '抽取序号', 1)
        if (kind, seq) in seen:
            raise ValueError('同类别出现重复抽取序号，无法安全合并。')
        seen.add((kind, seq))
        pid = str(raw.get('poolId') or raw.get('poolName') or '')
        banner = raw.get('poolName')
        definitions.setdefault(pid, {'name': banner, 'kind': kind, 'id':pid, 'sourceGroup':group,
                                     'sourcePoolType':raw.get('sourcePoolType') or raw.get('poolType')})
        if raw.get('kind') not in (None, 'draw', 'gift_intel_book'):
            raise UnsupportedRecordFormat()
        rows.append(_base_row(kind, banner, raw.get('weaponName') if kind == 'weapon' else raw.get('charName') or raw.get('nameText'),
            raw.get('rarity'), raw.get('isFree', False), raw, poolId=pid,
            sourceId=f'{kind}:{seq}', sequence=seq, timestamp=raw.get('gachaTs'), batchId=raw.get('gachaTs'),
            isNew=raw.get('isNew'), explicitTicket=raw.get('kind') == 'gift_intel_book'))
    return rows, definitions, identity, 'enduid-json' if enduid else 'api-list-json', True, partial


def _sequence_evidence(rows, global_sequence, allow_cross_pool_duplicates=False):
    """Return observable sequence gaps, never add missing draws."""
    groups = defaultdict(list)
    for row in rows:
        if row.get('sequence') is not None:
            groups[row['kind'] if global_sequence else row['poolId']].append(row)
    gaps, starts = [], {}
    for category, group in groups.items():
        ordered = sorted(group, key=lambda r:r['sequence'])
        starts[category] = ordered[0]['sequence']
        last = 0
        previous = None
        for row in ordered:
            seq = row['sequence']
            if seq <= last:
                if allow_cross_pool_duplicates and seq == last and previous['poolId'] != row['poolId']:
                    previous=row
                    continue
                raise ValueError('同类别抽取序号重复或重叠，无法安全合并。')
            if seq > last + 1:
                gaps.append({'scope': category, 'kind': row['kind'], 'from':last+1, 'through':seq-1,
                             'beforePool':row['banner'], 'beforeSourceId':row['sourceId'],
                             'afterPool':previous['banner'] if previous else None,
                             'afterSourceId':previous['sourceId'] if previous else None})
            last = seq
            previous = row
    return gaps, starts


def import_record_text(text, filename='记录.json', *, confirmed_complete_pools=()):
    """Return one unsaved session. Reject unrecognized formats and mixed accounts.

    ``confirmed_complete_pools`` must come from a user's explicit prior scope
    confirmation for this exact file, never from a similar player or pool.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError('记录文件为空。')
    if len(text.encode('utf-8')) > 8 * 1024 * 1024:
        raise ValueError('单份记录不能超过8 MB。')
    original_text = text
    text = text.lstrip('\ufeff').strip()
    source = None
    if text.startswith(('{', '[')):
        try:
            source = json.loads(text, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('JSON含非有限数值。')))
        except (json.JSONDecodeError, RecursionError) as exc:
            raise ValueError('JSON 内容无效或嵌套过深，请检查导出文件。') from exc
        if not isinstance(source, dict):
            raise UnsupportedRecordFormat()
        if source.get('formatId') == 'internal_json_v3':
            parsed = _parse_v3(source)
        elif isinstance(source.get('data'), dict) and 'list' in source['data']:
            parsed = _parse_api(source)
        elif 'uid' in source and isinstance(source.get('data'), dict) and all(isinstance(v,list) for v in source['data'].values()):
            parsed = _parse_api(source, True)
        else:
            parsed = _parse_batch(source)
    else:
        parsed = _parse_txt(text)
    rows, definitions, identity, format_id, global_sequence, partial = parsed
    if not rows or len(rows) > MAX_ROWS:
        raise ValueError(f'记录须包含1至{MAX_ROWS}条条目。')
    digest = hashlib.sha256(original_text.encode('utf-8')).hexdigest()
    gaps, starts = _sequence_evidence(rows, global_sequence or format_id=='internal-json-v3',
                                     allow_cross_pool_duplicates=format_id=='internal-json-v3')
    groups = defaultdict(list)
    for row in rows:
        groups[row['poolId']].append(row)
    scopes = {pid:_character_scope(definitions[pid], group) if group[0]['kind']=='character' else 'weapon'
              for pid,group in groups.items()}
    v3_reset_categories=set()
    if format_id=='internal-json-v3':
        for kind in ('character','weapon'):
            restarting=[group for pid,group in groups.items() if group[0]['kind']==kind
                        and scopes[pid] not in ('auxiliary-reprint','auxiliary-celebration')
                        and min(r['sequence'] for r in group)==1
                        and max(r['sequence'] for r in group)>1]
            if len(restarting)>1:
                v3_reset_categories.add(kind)
    warnings, pools, sections, auxiliary, audit = [], [], [], [], []
    all_issues, weapon_issues = [], []
    if partial:
        warnings.append('源接口 hasMore=true，仅导入当前页；请补齐后再核对评分。')
    if any(r.get('sequence') is None for r in rows):
        warnings.append('部分记录没有抽取序号，按批次时间和批内顺序恢复；不能证明历史完整。')
    known_beginning = (global_sequence and starts.get('character') == 1 and
                       all(r.get('sequence') is not None for r in rows if r['kind']=='character'))
    if format_id == 'internal-json-v3':
        # Verified v3 files use category sequences, with some repeated IDs in
        # different pools. A later-window pool alone never proves its opening.
        character_rows = [r for r in rows if r['kind']=='character']
        known_beginning = bool(character_rows) and min(r['sequence'] for r in character_rows) == 1
    copies = Counter()
    profile_uncertain = False
    confirmed_complete_pools = set(confirmed_complete_pools)
    for pid, group in groups.items():
        definition = definitions[pid]
        banner, kind = definition['name'], definition['kind']
        scope = scopes[pid]
        if all(r.get('sequence') is not None for r in group):
            group.sort(key=lambda r:r['sequence'])
        up = BANNERS.get(banner) if kind == 'character' else _name(definition.get('up_character')) or WEAPON_UPS.get(banner)
        if scope == 'regular-character' and definition.get('up_character') and definition['up_character'] != up:
            raise ValueError(f'{banner}的源UP定义与现有目录冲突，请先核对。')
        if kind == 'weapon' and definition.get('up_character') and banner in WEAPON_UPS and definition['up_character'] != WEAPON_UPS[banner]:
            raise ValueError(f'{banner}的源UP定义与已确认映射冲突，请先核对。')
        limited_weapon = definition.get('isLimitedWeapon')
        if not isinstance(limited_weapon, bool):
            limited_weapon = not (banner in CONSTANT_WEAPONS or pid.startswith('weaponbox_constant_'))
        complete_pool = banner in confirmed_complete_pools or (not partial and (
            (global_sequence or format_id=='internal-json-v3' and kind not in v3_reset_categories)
            and starts.get(kind) == 1 and all(r.get('sequence') is not None for r in group)))
        # A v3 export whose earliest history predates this pool's opening has
        # an observed start boundary, even when category sequence IDs continue.
        start_time = definition.get('start_time')
        timestamps = [str(r['timestamp']) for r in rows if r.get('timestamp')]
        if format_id == 'internal-json-v3' and start_time and timestamps and min(timestamps) <= str(start_time):
            complete_pool = True
        pool_gaps = [g for g in gaps if g['beforePool'] == banner and g['from'] != 1]
        # Gap-of-one reward omissions are retained as evidence, not interpreted
        # as missing draw(s). Larger gaps invalidate the assumed pool opening.
        if any(g['through']-g['from']+1 > 1 for g in pool_gaps):
            complete_pool = banner in confirmed_complete_pools
        events, rush_events, rush_at, active, rewards, pending = [], [], [], [], [], []
        at = last = 0
        batch_sizes = Counter(r.get('batchId') for r in group)
        batch_seen = Counter()
        local_issues = []
        for row in group:
            row['mainBefore'] = at
            batch = row.get('batchId')
            batch_seen[batch] += 1
            extra = bool(batch and batch_sizes[batch] == 11 and batch_seen[batch] == 11)
            name, rarity = row['name'], row['rarity']
            reward = None
            if row.get('explicitTicket'):
                reward = 'next-banner-ticket'
            elif row.get('explicitReward'):
                reward = 'explicit-gift'
            elif kind == 'character' and not row['isRush'] and at == 60 and rarity == 3 and name in ('', '未知', '未知角色', '寻访情报书'):
                reward = 'next-banner-ticket'
            elif extra and not row['isRush']:
                if kind == 'character' and at > 0 and at % 240 == 0 and name in ('', up):
                    reward = 'character-token'
                elif kind == 'weapon' and at >= 180 and (at-180) % 160 == 0 and name in ('', up):
                    reward = 'signature-gift'
                elif kind == 'weapon' and at >= 100 and (at-100) % 160 == 0 and name.startswith('补充武库箱'):
                    reward = 'weapon-supply-box'
            if reward:
                row['classification'] = reward
                actual_name = up if not name and reward in ('character-token','signature-gift') else name
                rewards.append({'at':at,'name':actual_name,'kind':reward,'sourceId':row['sourceId'],
                    'classificationMethod':'source-explicit' if row.get('explicitReward') or row.get('explicitTicket') else 'node-and-extra-row',
                    'sourceRow':copy.deepcopy(row['sourceRow'])})
                if row.get('explicitReward') and kind == 'weapon' and (at < 100 or (at-100) % 80):
                    warnings.append(f'{banner}赠品标在第{at}抽，偏离固定节点；按源赠品标记单列，未补造抽数。')
                continue
            if rarity not in (4,5,6):
                row['classification'] = 'pending'
                pending.append(row)
                message = f'{banner}存在无法确定是否为赠品的条目（源序号{row.get("sequence") or row["sourceId"]}），保留待核对。'
                if scope in ('regular-character','weapon'):
                    warnings.append(message)
                    local_issues.append(_problem('structured_ambiguous_row',message,CHAR_AXES if kind=='character' else WEAPON_AXES,'error'))
                continue
            row['classification'] = 'draw'
            active.append(row)
            evidence = f'源序号{row.get("sequence") or row["sourceId"]}；{row.get("timestamp") or "时间未知"}'
            if row['isRush']:
                if kind == 'weapon':
                    raise ValueError('武器记录不能标为角色加急。')
                rush_at.append(at)
                if rarity == 6:
                    rush_events.append({'character':name or None,'pulls':10,'identitySource':'structured-record',
                                        'sourceId':row['sourceId'],'raw_text':evidence+'；独立加急'})
                continue
            at += 1
            if rarity == 6:
                if kind == 'weapon' and _unknown_name(name):
                    message=f'{banner}有六星武器名称缺失，不能判为歪出；请核对武器身份及专武数量。'
                    warnings.append(message)
                    local_issues.append(_problem('structured_weapon_identity_unknown',message,WEAPON_AXES,'error'))
                    profile_uncertain=True
                events.append({'character':name or None,'pulls':at-last,'off':name!=up,'at':at,
                    'identitySource':'structured-record','sourceId':row['sourceId'],'sourceNewFlag':row.get('isNew'),
                    'raw_text':evidence+f'；本池第{at}抽'})
                last = at
        counts = Counter(r['rarity'] for r in active)
        item = {'banner':banner,'poolId':pid,'kind':kind,'sourceRows':len(group),'main':at,'rush':len(rush_at),
                'six':counts[6],'five':counts[5],'rewards':rewards,'pendingRows':pending,'openingConfirmed':complete_pool}
        if scope == 'regular-character':
            rush_used = len(rush_at)==10 and len(set(rush_at))==1
            if rush_at and not rush_used:
                message = f'{banner}加急记录不是同一位置的完整10抽，需核对加急使用情况与配额。'
                warnings.append(message)
                local_issues.append(_problem('structured_partial_rush',message,CHAR_AXES,'error'))
            tokens = [r for r in rewards if r['kind']=='character-token' or r['kind']=='explicit-gift' and r['name']==up]
            token_count = at//240 if complete_pool else len(tokens)
            if at >= 240 and not complete_pool and len(tokens) < at//240:
                warnings.append(f'{banner}未证明从第1抽开始，未补计源文件缺少的信物；请核对池起点与信物。')
            quota = sum({4:20,5:200,6:2000}[r['rarity']] for r in active)
            pools.append({'banner':banner,'total':at,'tail':at-last,'tail_known':True,'quota':quota,
                'events':list(reversed(events)),'rush':list(reversed(rush_events)),
                'rushUsed':rush_used if rush_at else False,'rushAt':rush_at[0] if rush_used else None,
                'token_count':token_count,'issues':local_issues,
                'header_raw':f'逐条记录：主池{at}抽，加急{len(rush_at)}抽，配额{quota}',
                'evidence':{'sourceKind':format_id,'sourcePoolId':pid,'sourceRewards':rewards,
                            'openingConfirmed':complete_pool,'pendingRows':pending}})
            item['scoreScope']='regular-character'
        elif kind == 'weapon' and (limited_weapon or counts[6]>0):
            weapon_issues.extend(local_issues)
            if not up:
                message = f'{banner}没有已确认的UP名称；武器明细保留，请核对专武数量与潜能配置。'
                warnings.append(message)
                weapon_issues.append(_problem('structured_weapon_up_unknown',message,WEAPON_AXES,'error'))
                profile_uncertain=True
            direct_gifts = [r for r in rewards if up and r['name']==up]
            if complete_pool and up:
                # Do not add a second copy when explicit gift positions were
                # shifted by an exporter; only fill genuinely missing count.
                missing = max(0,len(range(180,at+1,160))-len(direct_gifts))
                for node in range(180,at+1,160):
                    if missing and not any(r['at']==node for r in direct_gifts):
                        direct_gifts.append({'at':node,'name':up,'kind':'signature-gift',
                                             'classificationMethod':'confirmed-opening-fixed-node','sourceListed':False})
                        missing-=1
            elif at>=180 and len(direct_gifts)<len(range(180,at+1,160)):
                profile_uncertain=True
                message=f'{banner}未证明从第1抽开始，源文件未列出的赠送专武未补计；武器潜能修正需核对。'
                warnings.append(message)
                weapon_issues.append(_problem('structured_weapon_profile_scope_unknown',message,WEAPON_AXES))
            section = {'banner':banner,'up':up,'total':at,'tail':at-last,'five':counts[5],
                'sourcePoolId':pid,'isLimitedWeapon':limited_weapon,'excludedRewards':rewards,'signatureGifts':direct_gifts,
                'eventsNewestFirst':[{'wait':e['pulls'],'at':e['at'],'weapon':e['character'],
                    'isUp':e['character']==up if up and not _unknown_name(e['character']) else None,'raw':e['raw_text'],'sourceId':e['sourceId']}
                    for e in reversed(events)]}
            sections.append(section)
            copies.update(e['character'] for e in events if up and e['character']==up)
            copies.update(up for _ in direct_gifts)
            item['scoreScope']='weapon'
        else:
            item['scoreScope']='auxiliary-constant-weapon-without-six' if kind=='weapon' else scope
            item['sourceRowsDetailed']=copy.deepcopy(group)
            auxiliary.append(item)
        audit.append(item)
    # User-confirmed import policy: one absent source slot at a known reward
    # node may represent an omitted reward. The pool opening must be known,
    # earlier gaps must be resolved, and an existing reward cannot be counted
    # again. Other gaps invalidate positions inside the affected pool.
    uncertain_pools=set()
    reset_pools=set()
    unexpected_gaps=False
    audit_by_pid={item['poolId']:item for item in audit}
    pool_by_banner={pool['banner']:pool for pool in pools}
    section_by_banner={section['banner']:section for section in sections}
    for gap in gaps:
        before=next((r for r in rows if r['sourceId']==gap['beforeSourceId'] and r['banner']==gap['beforePool']),None)
        after=next((r for r in rows if r['sourceId']==gap.get('afterSourceId') and r['banner']==gap.get('afterPool')),None)
        if (before and after and before['poolId']==after['poolId'] and
                scopes[before['poolId']] in ('auxiliary-reprint','auxiliary-celebration')):
            gap['classification']='excluded-pool-gap'
            continue
        if not before or gap['from']==1:
            gap['classification']='unobserved-prefix'
            continue
        n=gap['through']-gap['from']+1
        # Mixed batch exports may supplement all missing IDs with timestamped
        # rows. The exact count AND both observed time boundaries must agree.
        # A partial match remains unresolved (it is not rounded to complete).
        if after and format_id=='timestamp-batch-json':
            between=[r for r in rows if r['kind']==gap['kind'] and r.get('sequence') is None
                     and _decimal(after['timestamp'])<_decimal(r['timestamp'])<_decimal(before['timestamp'])]
            if len(between)==n:
                gap['classification']='filled-by-complete-timestamped-batches'
                continue
        # Rewards can be omitted immediately before switching to another pool.
        boundary=before['mainBefore'] if after and before['poolId']==after['poolId'] else (
            after['mainBefore']+int(after.get('classification')=='draw' and not after['isRush']) if after else None)
        kind=gap['kind']
        boundary_banner=before['banner'] if after and before['poolId']==after['poolId'] else after['banner'] if after else None
        boundary_pid=before['poolId'] if after and before['poolId']==after['poolId'] else after['poolId'] if after else None
        owner=audit_by_pid.get(boundary_pid,{})
        reward_kind=None
        reward_name=None
        ordinal=1
        if kind=='character' and owner.get('scoreScope')=='regular-character':
            if boundary==60:
                reward_kind,reward_name='next-banner-ticket','寻访情报书'
            elif boundary is not None and boundary>0 and boundary%240==0:
                reward_kind,reward_name='character-token',BANNERS[boundary_banner]
                ordinal=boundary//240
        elif kind=='weapon' and owner.get('kind')=='weapon' and boundary is not None:
            if boundary>=100 and (boundary-100)%160==0:
                reward_kind,reward_name='weapon-supply-box','补充武库箱'
                ordinal=(boundary-100)//160+1
            elif boundary>=180 and (boundary-180)%160==0:
                reward_name=section_by_banner.get(boundary_banner,{}).get('up')
                reward_kind='signature-gift' if reward_name else None
                ordinal=(boundary-180)//160+1
        corresponding=[]
        for reward in owner.get('rewards',[]):
            if boundary is None or reward['at']>boundary:
                continue
            category=reward.get('kind')
            matches=(category==reward_kind or
                     category=='explicit-gift' and (
                         reward_kind in ('character-token','signature-gift') and reward.get('name')==reward_name
                         or reward_kind=='weapon-supply-box' and str(reward.get('name','')).startswith('补充武库箱')))
            if (matches or reward.get('at')==boundary and category=='explicit-gift'
                    or category=='explicit-gift' and _unknown_name(reward.get('name'))
                    and boundary-10<=reward['at']<=boundary):
                corresponding.append(reward)
        reward_exists=(len(corresponding)>=ordinal or
                       any(reward.get('at')==boundary for reward in corresponding))
        safe_node=(owner.get('openingConfirmed') is True and boundary_banner not in uncertain_pools
                   and boundary_banner not in reset_pools)
        if n==1 and reward_kind:
            gap['candidateReward']=True
            if safe_node and not reward_exists:
                gap.update(classification='omitted-reward-slot-at-confirmed-node',
                           rewardKind=reward_kind,rewardAt=boundary,rewardBanner=boundary_banner,
                           ruleBasis='user-confirmed-single-missing-reward-slot')
                reward={'at':boundary,'name':reward_name,'kind':reward_kind,'sourceListed':False,
                        'classificationMethod':'user-confirmed-single-missing-reward-slot',
                        'sourceSequenceGap':{'from':gap['from'],'through':gap['through'],'kind':kind}}
                owner['rewards'].append(reward)
                if reward_kind=='character-token':
                    # The fixed-node count may already include this token.
                    pool=pool_by_banner[boundary_banner]
                    pool['token_count']=max(pool['token_count'],ordinal)
                elif reward_kind=='signature-gift':
                    section=section_by_banner[boundary_banner]
                    inferred=next((g for g in section['signatureGifts'] if g.get('at')==boundary
                                   and g.get('sourceListed') is False),None)
                    if inferred is None:
                        section['signatureGifts'].append(reward)
                    else:
                        inferred.update(reward)
                continue
            gap['rewardInferenceBlockedBy']='existing-reward' if reward_exists else 'unconfirmed-opening-or-earlier-gap'
            warnings.append(f'{boundary_banner}节点附近缺少1条源序号，但已有对应赠品或池起点/前段不明确，保留待核对。')
        gap['classification']='unknown-missing-entries'
        unexpected_gaps = unexpected_gaps or kind=='character'
        if after and before['poolId']==after['poolId']:
            uncertain_pools.add(before['banner'])
        else:
            reset_pools.add(before['banner'])
            if n==1 and reward_kind:
                uncertain_pools.add(boundary_banner)
    resolved_reward_gaps=sum(g.get('classification')=='omitted-reward-slot-at-confirmed-node' for g in gaps)
    if resolved_reward_gaps:
        warnings.append(f'{resolved_reward_gaps}处节点缺号按已确认规则作为漏导奖励处理；未增加抽数或随机出货。')
    if any(g.get('classification') in ('unknown-missing-entries','unobserved-prefix') for g in gaps):
        warnings.append('源记录有未解释的序号缺口或缺失开头；未补造抽取，受影响范围保留待核对。')
    # Mixed exports added rows without sequence IDs. They cannot be assumed to
    # fill a known sequence gap merely because the banner list now looks full.
    for kind in ('character','weapon'):
        no_sequence={r['banner'] for r in rows if r['kind']==kind and r.get('sequence') is None}
        if no_sequence and any(g['kind']==kind and g.get('classification')=='unknown-missing-entries' for g in gaps):
            uncertain_pools.update(no_sequence)
    if format_id=='internal-json-v3':
        for kind in ('character','weapon'):
            reset_groups=[g for pid,g in groups.items() if g[0]['kind']==kind
                          and scopes[pid] not in ('auxiliary-reprint','auxiliary-celebration') and
                          min(r['sequence'] for r in g)==1 and max(r['sequence'] for r in g)>1]
            if len(reset_groups)>1:
                uncertain_pools.update(g[0]['banner'] for g in reset_groups)
                unexpected_gaps = unexpected_gaps or kind=='character'
                warnings.append('多个池的序号都从1重启，无法确认是否采用已支持的类别序号口径；保留明细待核对。')
    for pool in pools:
        if pool['banner'] in uncertain_pools:
            message=f'{pool["banner"]}存在未解释的源序号缺口，出货位置和总抽数可能不完整；请补齐来源或使用中断修正排除此池。'
            warnings.append(message)
            pool['issues'].append(_problem('structured_history_gap',message,CHAR_AXES,'error'))
            pool['evidence']['openingConfirmed']=False
            pool['token_count']=sum(r['kind']=='character-token' or r['kind']=='explicit-gift' and r['name']==BANNERS[pool['banner']]
                                    for r in pool['evidence']['sourceRewards'])
    for section in sections:
        if section['banner'] in uncertain_pools:
            message=f'{section["banner"]}存在未解释的源序号缺口，武器统计需核对。'
            warnings.append(message)
            weapon_issues.append(_problem('structured_history_gap',message,WEAPON_AXES,'error'))
            profile_uncertain=True
            section['openingConfirmed']=False
            section['signatureGifts']=[g for g in section['signatureGifts'] if g.get('sourceListed') is not False]
    for item in audit:
        if item['banner'] in uncertain_pools:
            item['openingConfirmed']=False
    copies=Counter(e['weapon'] for section in sections for e in section['eventsNewestFirst'] if e['isUp'] is True)
    for section in sections:
        copies.update(section['up'] for _ in section['signatureGifts'])
    skipped=sum(item['scoreScope'] in ('auxiliary-reprint','auxiliary-celebration') for item in auxiliary)
    if not pools and not sections and not skipped:
        raise ValueError('文件内没有当前支持的常规限定角色池或已出货武器池；原文件未导入。')
    weapon = None
    if sections:
        missing_up = any(not s['up'] for s in sections) or any(i['code']=='structured_weapon_identity_unknown' for i in weapon_issues)
        weapon = {'N':sum(s['total'] for s in sections),'K6':sum(len(s['eventsNewestFirst']) for s in sections),
            'KU':None if missing_up else sum(e['isUp'] is True for s in sections for e in s['eventsNewestFirst']),
            'B':len(sections),'sections':sections,'allowIndividualDraws':True,'lossDraws':None,'issues':weapon_issues,
            'evidence':{'sourceKind':format_id,'profileCopies':dict(copies),'profileNeedsReview':profile_uncertain}}
        full = [name for name, n in copies.items() if n>=6]
        if copies and not profile_uncertain:
            weapon['potentialConfig']={'totalTypes':len(copies),
                'counts':[sum(n==p+1 for n in copies.values()) for p in range(1,5)]+[len(full)],
                'overflowCopies':sum(max(0,n-6) for n in copies.values()),
                'overflowByType':[copies[name]-6 for name in full]}
            weapon['evidence']['fullPotentialNames']=full
    display_name=identity.get('name') or ('UID '+identity['uid'] if identity.get('uid') else PurePath(filename).stem or '导入记录')
    identity['name']=display_name
    warnings=list(dict.fromkeys(warnings))
    notes=['按逐条记录重建主池及独立加急；源pity/汇总不作为游戏状态。',
           '角色信物、赠券和直接赠送武器另列，不计实际抽数、随机六星或配额。',
           '常驻武器池出六星后纳入；复刻、庆典、基础角色记录辅助保留。']
    doc={'file':filename,'kind':'structured-character-and-weapon','originalFile':filename,'source_sha256':digest,
         'identity':identity,'pools':pools,'weapon':weapon,'issues':all_issues,'sourceRows':rows,
         'sourceSequenceGaps':gaps,'auxiliaryRecords':auxiliary,'importNotes':notes,'importWarnings':warnings,
         'importAudit':audit,'sourceExport':source} if source is not None else {
         'file':filename,'kind':'structured-character-and-weapon','originalFile':filename,'source_sha256':digest,
         'identity':identity,'pools':pools,'weapon':weapon,'issues':all_issues,'sourceRows':rows,
         'sourceSequenceGaps':gaps,'auxiliaryRecords':auxiliary,'importNotes':notes,'importWarnings':warnings,
         'importAudit':audit,'sourceText':original_text}
    ledger=build_ledger([doc])
    ledger['identity'].update(identity)
    character=ledger['character']
    if not known_beginning or partial or unexpected_gaps:
        character.update(initialPity=None,initialOwned=None,completeHistory=False,
                         historyEvidence='structured-opening-unproved')
    ordered=character['pools']
    for i,pool in enumerate(ordered):
        if i==0:
            pool['initialPity']=0 if known_beginning and pool['index']==0 and not partial else None
        else:
            pool['initialPity']=ordered[i-1]['tail'] if pool['index']==ordered[i-1]['index']+1 else None
        if pool['banner'] in uncertain_pools or pool['banner'] in reset_pools:
            pool['initialPity']=None
        if not pool['events']:
            pool['tail']=pool['initialPity']+pool['total'] if pool['initialPity'] is not None else None
        pool['initialPitySource']='record-derived'
        pool['ended']=True
    if confirmed_complete_pools:
        doc['userConfirmations']={'fullPoolHistories':sorted(confirmed_complete_pools)}
    return {'schemaVersion':'gacha-rating-session-v1','id':uuid.uuid4().hex,'revision':1,'documents':[doc],
        'ledger':ledger,'reviewed':False,'recognitionVersion':RECOGNITION_VERSION,'scoringScenario':{'enabled':False},
        'updatedAt':time.time(),'displayName':display_name,'sourceSHA256':digest,'importMethod':format_id,
        'importSummary':{'format':format_id,'sourceRows':len(rows),'characterPools':len(pools),'weaponPools':len(sections),
            'auxiliaryPools':len(auxiliary),'warnings':warnings,
            'message':f'已读取{len(rows)}条来源条目，{len(pools)}个限定角色池、{len(sections)}个武器池。'
                      +(f'已跳过{skipped}个复刻／庆典池的评分。' if skipped else '')}}
