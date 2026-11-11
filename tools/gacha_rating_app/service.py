"""Local-only orchestration. No simulation, external API, or source-image upload."""
from __future__ import annotations
import copy
import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path

from importer import BANNERS

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'weapon_score_v2'))
from weapon_scoring import score_weapon_record, VERSION as WEAPON_VERSION

VERSION = 'gacha-rating-local-v1'
SCENARIO_VERSION = 'hypothetical-final-score-v1-20261024'
AXES = ['characterSix', 'up', 'limited', 'five', 'weaponSix', 'signature']
CHARACTERS = {*BANNERS.values(), '骏卫', '黎风', '别礼', '余烬', '艾尔黛拉'}

def unscored(reason):
    return {'score': None, 'status': 'unscored', 'reason': reason}


def reject_hypothetical_ledger(ledger):
    """Hypothesis output must never be accepted as an actual saved record."""
    def marked(value):
        if isinstance(value, dict):
            if value.get('hypothesis') or value.get('identitySource') == 'manual-hypothesis':
                return True
            return any(marked(child) for child in value.values())
        return isinstance(value, list) and any(marked(child) for child in value)
    if marked(ledger):
        raise ValueError('假设补抽结果不能保存为真实记录，请回到实际抽卡记录修改。')


def validate_ledger(ledger):
    if not isinstance(ledger, dict) or ledger.get('schemaVersion') != 'gacha-ledger-v1':
        raise ValueError('不支持的记录格式，请导入本工具保存的记录。')
    character = ledger.get('character') or {'pools': []}
    if not isinstance(character, dict):
        raise ValueError('角色记录格式错误。')
    from history_interruption import normalize_correction
    normalize_correction(character.get('interruptionCorrection'))
    pools = character.get('pools', [])
    if not isinstance(pools, list) or len(pools) > 80:
        raise ValueError('角色池列表异常（最多80池）。')
    identities = {key:set() for key in ('id', 'banner', 'index')}
    for pool in pools:
        if not isinstance(pool, dict):
            raise ValueError('卡池记录格式错误。')
        if 'planningExempt' in pool and type(pool['planningExempt']) is not bool:
            raise ValueError('亏损豁免选项必须为选中或未选中。')
        for key, values in identities.items():
            value = pool.get(key)
            if value is not None:
                if type(value) not in (str, int) or value in values:
                    raise ValueError('角色池的编号、名称或序号重复或无效，请检查新增卡池。')
                values.add(value)
        total = pool.get('total')
        if total is not None and (type(total) is not int or not 0 <= total <= 10000):
            raise ValueError('单池抽数必须是0—10000的整数。')
        extra_draws = pool.get('manualSupplementDraws', 0)
        if (type(extra_draws) is not int or extra_draws < 0 or
                extra_draws and (total is None or extra_draws > total)):
            raise ValueError('手动补充主抽数须为非负整数，不能超过本池总抽数。')
        for key in ('events', 'rush', 'tokens'):
            if not isinstance(pool.get(key, []), list) or len(pool.get(key, [])) > 10000:
                raise ValueError('出货明细格式或长度异常。')
    initial = character.get('initialPity')
    if initial is not None and (type(initial) is not int or not 0 <= initial <= 79):
        raise ValueError('期初水位须为0—79的整数，未知时留空。')
    owned = character.get('initialOwned')
    if owned is not None:
        if (not isinstance(owned, list) or len(owned) > len(CHARACTERS)
                or any(not isinstance(name, str) or ('骏卫' if name == '俊卫' else name) not in CHARACTERS for name in owned)
                or len({'骏卫' if name == '俊卫' else name for name in owned}) != len(owned)):
            raise ValueError('期初图鉴须为不重复的已支持六星角色列表，未知时留空。')
    history = character.get('firstPoolHistory')
    if history is not None:
        if (not isinstance(history, dict) or type(history.get('isFirstPool')) is not bool
                or not pools or type(history.get('poolId')) not in (str, int)
                or any(type(p.get('index')) is not int for p in pools)
                or history.get('poolId') != min(pools, key=lambda p: p['index']).get('id')):
            raise ValueError('首池确认信息无效或与当前首池不一致，请重新确认。')
    overrides = character.get('summaryOverrides', [])
    if not isinstance(overrides, list) or len(overrides) > 80:
        raise ValueError('顶部汇总修正格式异常。')
    seen = set()
    for entry in overrides:
        if not isinstance(entry, dict) or entry.get('mode') not in ('override', 'details'):
            raise ValueError('顶部汇总修正模式无效。')
        digest, file = entry.get('source_sha256'), entry.get('file')
        if ((digest is not None and (not isinstance(digest, str) or len(digest) > 128))
                or (file is not None and (not isinstance(file, str) or len(file) > 1024))
                or not (digest or file)):
            raise ValueError('顶部汇总修正缺少有效来源。')
        identity = ('sha256', digest) if digest else ('file', file)
        if identity in seen:
            raise ValueError('同一来源存在重复的顶部汇总修正。')
        seen.add(identity)
        for field in ('N', 'K6', 'off'):
            value = entry.get(field)
            if value is not None and (type(value) is not int or not 0 <= value <= 2**53 - 1):
                raise ValueError('顶部汇总须为非负整数；未知项留空。')
        for low, high in (('K6', 'N'), ('off', 'K6'), ('off', 'N')):
            if entry.get(low) is not None and entry.get(high) is not None and entry[low] > entry[high]:
                raise ValueError('顶部汇总须满足歪出次数≤主池六星数≤主池总抽数。')
    return ledger

def normalize_scoring_scenario(value):
    """Persist user choices only; calculated/claimed outcomes are never input."""
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool:
        raise ValueError('假设计分设置必须包含明确的开启或关闭选项。')
    if not value['enabled']:
        # Turning off must remain possible after the actual pool was removed or
        # the previously selected guarantee/characters are no longer valid.
        return {'enabled':False}
    pool_id, mode = value.get('poolId'), value.get('mode')
    if not isinstance(pool_id, str) or not pool_id or len(pool_id) > 128:
        raise ValueError('假设计分缺少有效的末池编号，请重新选择。')
    if mode not in ('first-up-120', 'next-six-80'):
        raise ValueError('假设计分模式无效，请重新选择保底方式。')
    choices = value.get('choices', {})
    if (not isinstance(choices, dict) or len(choices) > 3
            or any(not isinstance(at, str) or not at.isascii() or not at.isdecimal()
                   or not 1 <= int(at) <= 10000 or str(int(at)) != at
                   or not isinstance(name, str) or not name or len(name) > 32
                   for at, name in choices.items())):
        raise ValueError('假设计分的出货位置或角色选择格式错误。')
    five = value.get('additionalFive')
    if five is not None and (type(five) is not int or not 0 <= five <= 10000):
        raise ValueError('假设计分的追加五星数须为非负整数，未知时留空。')
    return {'enabled':True, 'poolId':pool_id, 'mode':mode,
            'choices':copy.deepcopy(choices), 'additionalFive':five}


def score_session_result(documents, ledger, scenario, *, reviewed=False):
    """Score actual facts or a selected extension without changing the facts."""
    reject_hypothetical_ledger(ledger)
    settings = normalize_scoring_scenario(scenario)
    if not settings['enabled']:
        result = score_ledger(ledger)
        result['scoringScenario'] = {'enabled':False, 'version':SCENARIO_VERSION}
        return result
    # preview_hypothesis calls score_ledger directly for both baselines. Keeping
    # the session wrapper separate avoids recursive application of the option.
    from hypothesis import preview_hypothesis
    preview = preview_hypothesis(documents, ledger, settings['poolId'], settings['mode'],
                                 choices=settings['choices'], additional_five=settings['additionalFive'],
                                 reviewed=reviewed)
    result = preview['after']
    result['scoringScenario'] = {'enabled':True, 'version':SCENARIO_VERSION,
                                'plan':copy.deepcopy(preview['plan']), 'notices':list(preview['notices'])}
    return result


def score_ledger(ledger):
    validate_ledger(ledger)
    from history_interruption import project_ledger, refresh_projected_mechanics
    planning_ledger, _ = project_ledger(ledger, for_planning=True)
    ledger, interruption = project_ledger(ledger)
    if interruption['enabled']:
        refresh_projected_mechanics(ledger)
        refresh_projected_mechanics(planning_ledger)
    start = time.perf_counter()
    warnings = []
    if interruption['enabled']:
        warnings.append('已按中断修正排除所选卡池；补充六星仅用于图鉴，补充水位仅用于欧非，亏损仍按0水位重置计算。')
    character = ledger.get('character') or {'pools': []}
    node = shutil.which('node')
    if not node:
        fallback = Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        node = str(fallback) if fallback.exists() else None
    if not node:
        raise RuntimeError('未找到Node运行环境，角色评分无法启动。')
    process = subprocess.run([node, str(ROOT/'score_cli.js')], input=json.dumps(character, ensure_ascii=False),
                             text=True, encoding='utf-8', capture_output=True, timeout=25,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if process.returncode:
        raise ValueError('角色评分校验失败：'+process.stderr.strip()[:500])
    chars = json.loads(process.stdout)
    axes = chars['axes']
    warnings.extend(chars.get('warnings', []))
    weapon = ledger.get('weapon')
    weapon_result = None
    if not weapon or not weapon.get('N'):
        reason = '未导入武器记录。'
        axes.update({key: unscored(reason) for key in AXES[-2:]})
    else:
        try:
            # Legacy pool-count/H80 metadata no longer selects a score branch.
            blockers = [i for i in weapon.get('issues', []) if isinstance(i,dict)
                        and i.get('severity')=='error'
                        and i.get('code') not in ('weapon_pool_count_missing', 'weapon_loss_draws_invalid')
                        and not (i.get('code') == 'weapon_summary_conflict' and i.get('field') == 'upAverage')]
            if blockers:
                raise ValueError('武器识别存在冲突，请核对原图。')
            weapon_result = score_weapon_record(weapon)
            for key, source in [('weaponSix','six_star'),('signature','signature')]:
                detail = weapon_result[source]
                if detail['score'] is None:
                    axes[key] = unscored(detail.get('reason', '有效武器抽数不足。'))
                else:
                    axes[key] = {'score':detail['score'], 'status':'ok', 'details':detail,
                                 'version':weapon_result['version']}
            warnings.extend(weapon_result.get('warnings', []))
        except (ValueError, ArithmeticError) as error:
            axes.update({key: unscored(str(error)) for key in AXES[-2:]})
    # Identity/source conflicts must never produce a plausible mixed-account radar.
    conflicts = [i for i in ledger.get('issues', []) if isinstance(i,dict) and i.get('severity')=='error']
    for issue in conflicts:
        for axis in issue.get('axes', AXES):
            if axis in axes:
                axes[axis] = unscored(issue.get('message', '导入记录存在冲突'))
    from planning import score_planning
    planning = score_planning(planning_ledger.get('character') or {'pools': []})
    planning_conflicts = [i for i in conflicts if not i.get('axes') or any(a in i['axes'] for a in ('characterSix','up','planning'))]
    if planning_conflicts:
        from opportunity import unavailable
        reasons = [i.get('message','来源冲突') for i in planning_conflicts]
        for row in planning.get('pools', []):
            row.update(status='partial',localLoss=None,countedLoss=None,exemptedLoss=0,
                       permanentDelta=None,waterValueDelta=None,rewardValueDelta=None)
            row['opportunity'] = unavailable()
            row.setdefault('warnings', []).extend(reasons)
        planning['summary']={'calculatedPools':0,'partialPools':len(planning.get('pools',[])),
                             'poolCount':len(planning.get('pools',[])), 'sumIsPartial':True,
                             'localLossSignedSum':None,'rawLocalLossSignedSum':None,
                             'localLossPositiveSum':None,'localGainMagnitudeSum':None,
                             'exemptedPools':0,'exemptedLossSum':0,'lossTier':None,'title':None,
                             'accountCounterfactualLoss':None,'score':None,
                             'opportunity':{'total':None,'calculatedPools':0,'complete':False,
                                            'poolCount':len(planning.get('pools',[])),
                                            'partialPools':len(planning.get('pools',[]))}}
        planning.setdefault('warnings',[]).extend(reasons)
    valid = [a.get('score') for a in axes.values() if isinstance(a.get('score'), (int,float)) and math.isfinite(a['score'])]
    return {'version':VERSION, 'weaponVersion':WEAPON_VERSION, 'axes':axes, 'mean':None,
            'interruptionCorrection':interruption,
            'scoredAxes':len(valid), 'warnings':warnings, 'planning':planning,
            'character':chars, 'weapon':weapon_result, 'elapsedSeconds':time.perf_counter()-start,
            'meanMeaning':'按用户要求不计算六维均分；各轴独立展示。'}

def public_document(document, data_root):
    """Replace evidence paths with bounded local URLs, not arbitrary filesystem reads."""
    def walk(value):
        if isinstance(value, dict):
            return {key:walk(v) for key,v in value.items()}
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, str):
            try:
                path = Path(value)
                if path.is_absolute() and path.exists() and path.is_relative_to(data_root):
                    return '/data/'+path.relative_to(data_root).as_posix()
            except (ValueError, OSError):
                pass
        return value
    return walk(copy.deepcopy(document))
