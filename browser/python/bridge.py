"""Browser worker adapter for the existing, deterministic record pipeline.

The original Python modules are copied unchanged into Pyodide's private file
system.  This adapter never starts a process, opens a socket, or writes a user
record.  Browser code owns persistence; only scoring crosses the Python/JS
boundary, using JSON strings to avoid leaking PyProxy objects.

Mount the repository layout at /app, register ``browser_scoring`` with synchronous
``score_character(text)`` (and optionally ``score_weapon(text)``), then call::

    import bridge
    bridge.initialize('/app')
    bridge.dispatch_json('{"op":"init"}')

Every request returns ``{"ok": true, "value": ...}`` or
``{"ok": false, "error": "...", "code": "..."}``.  The JS worker must
serialize requests; ordinary Python callbacks cannot await a second worker.
"""
from __future__ import annotations

import copy
import importlib
import json
from pathlib import Path
import re
import sys
import time
from types import SimpleNamespace
import uuid

MAX_RECORD_TEXT = 8 * 1024 * 1024
MAX_REQUEST_TEXT = 100 * 1024 * 1024
SESSION_SCHEMA = 'gacha-rating-session-v1'
_state = None


def _strict_json(text):
    def invalid(value):
        raise ValueError('记录包含非有限数值。')
    return json.loads(text, parse_constant=invalid)


def _call_score(callback, value, label):
    try:
        text = callback(json.dumps(value, ensure_ascii=False, allow_nan=False))
        if not isinstance(text, str):
            raise ValueError('评分接口未返回 JSON 文本。')
        result = _strict_json(text)
        if not isinstance(result, dict):
            raise ValueError('评分接口返回格式无效。')
        return result
    except Exception as exc:
        # JsException has a browser-dependent class. Normalize it so the source
        # service's existing per-axis error handling remains effective.
        raise ValueError(f'{label}：{exc}') from None


def initialize(source_root=None, *, character_scorer=None, weapon_scorer=None):
    """Bind local JS scoring without modifying a shared stdlib module.

    Explicit callbacks also make this adapter testable in ordinary CPython.
    There is deliberately no subprocess or network fallback.
    """
    global _state
    root = Path(source_root) if source_root else Path(__file__).resolve().parents[2]
    app = root / 'tools' / 'gacha_rating_app'
    if not (app / 'service.py').is_file():
        raise ValueError('浏览器计算文件不完整，请重新加载页面。')
    if character_scorer is None:
        scoring = importlib.import_module('browser_scoring')
        character_scorer = scoring.score_character
        weapon_scorer = getattr(scoring, 'score_weapon', None)
    if not callable(character_scorer):
        raise ValueError('角色计算模块尚未就绪。')
    if weapon_scorer is not None and not callable(weapon_scorer):
        raise ValueError('武器计算模块尚未就绪。')
    for path in (app, root / 'tools' / 'weapon_score_v2'):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    importer = importlib.import_module('importer')
    service = importlib.import_module('service')

    def run_character(_args, *, input, **_kwargs):
        try:
            result = _call_score(character_scorer, _strict_json(input), '角色评分失败')
            return SimpleNamespace(returncode=0, stdout=json.dumps(result, ensure_ascii=False, allow_nan=False), stderr='')
        except Exception as exc:
            return SimpleNamespace(returncode=1, stdout='', stderr=str(exc))

    # Only replace these names in service, not shutil.which or subprocess.run
    # globally. The service's orchestration, error policy, planning, hypotheses,
    # and interruption correction continue to use the original implementation.
    service.shutil = SimpleNamespace(which=lambda name: 'browser-js' if name == 'node' else None)
    service.subprocess = SimpleNamespace(run=run_character, CREATE_NO_WINDOW=0)
    weapon_module = importlib.import_module('weapon_scoring')
    if weapon_scorer is None:
        service.score_weapon_record = weapon_module.score_weapon_record
    else:
        service.score_weapon_record = lambda weapon: _call_score(weapon_scorer, weapon, '武器评分失败')
    _state = {'root': root, 'app': app, 'importer': importer, 'service': service}
    return configuration()


def _ready():
    if _state is None:
        raise RuntimeError('浏览器计算模块尚未初始化。')
    return _state


def configuration():
    state = _ready()
    planning = importlib.import_module('planning')
    history = importlib.import_module('history_interruption')
    version_source = (state['app'] / 'character_score.js').read_text(encoding='utf-8')
    match = re.search(r"const VERSION = '([^']+)'", version_source)
    if match is None:
        raise ValueError('角色算法版本信息缺失。')
    return {
        'token': 'browser-local', 'version': state['service'].VERSION,
        'localOnly': True, 'runtime': 'browser',
        'planningVersion': planning.VERSION, 'characterVersion': match[1],
        'weaponVersion': state['service'].WEAPON_VERSION,
        'recognitionVersion': state['importer'].RECOGNITION_VERSION,
        'scoringScenarioVersion': state['service'].SCENARIO_VERSION,
        'interruptionVersion': history.VERSION,
    }


def _checked_id(value):
    if not isinstance(value, str) or re.fullmatch(r'[a-f0-9]{32}', value) is None:
        raise ValueError('无效的记录编号。')
    return value


def _session(value):
    if (not isinstance(value, dict) or value.get('schemaVersion') != SESSION_SCHEMA
            or not isinstance(value.get('documents'), list) or not value['documents']
            or any(not isinstance(document, dict) for document in value['documents'])):
        raise ValueError('请先导入截图或本工具导出的完整记录。')
    return copy.deepcopy(value)


def _score(session):
    state = _ready()
    service, importer = state['service'], state['importer']
    service.reject_hypothetical_ledger(session.get('ledger'))
    session['ledger'] = importer.revalidate_current_ledger(
        session['documents'], session.get('ledger'), reviewed=session.get('reviewed', False))
    session['scoringScenario'] = service.normalize_scoring_scenario(
        session.get('scoringScenario', {'enabled': False}))
    session['result'] = service.score_session_result(
        session['documents'], session['ledger'], session['scoringScenario'],
        reviewed=session.get('reviewed', False))
    session['recognitionVersion'] = importer.RECOGNITION_VERSION
    session['updatedAt'] = time.time()
    if type(session.get('revision')) is not int or session['revision'] < 1:
        raise ValueError('记录版本无效。')
    # Fail before the JS layer commits to IndexedDB, just like the local server.
    json.dumps(session, ensure_ascii=False, allow_nan=False)
    return session


def import_record(data):
    _ready()
    if not isinstance(data.get('name'), str):
        raise ValueError('请选择一个 TXT 或 JSON 抽卡记录文件。')
    name = data['name'].replace('\\', '/').rsplit('/', 1)[-1][:200]
    if Path(name).suffix.lower() not in ('.txt', '.json'):
        raise ValueError('抽卡记录仅支持 TXT 或 JSON 文件。')
    text = data.get('text')
    if not isinstance(text, str) or not text.strip('\ufeff \r\n\t'):
        raise ValueError('记录文件为空或内容无法读取。')
    if len(text.encode('utf-8')) > MAX_RECORD_TEXT:
        raise ValueError('单份第三方记录不能超过 8 MB。')
    confirmed = data.get('confirmedCompletePools', [])
    if (not isinstance(confirmed, list) or len(confirmed) > 100
            or any(not isinstance(name, str) or len(name) > 100 for name in confirmed)):
        raise ValueError('完整卡池确认信息无效。')
    # The JS store supplies only explicit confirmations from records sharing
    # this source's SHA256 (including the supported BOM variants).
    from record_import import import_record_text
    session = import_record_text(text, name, confirmed_complete_pools=set(confirmed))
    session.update(id=uuid.uuid4().hex, revision=1)
    return _score(session)


def from_documents(data):
    """Finish an OCR result. Paths remain local evidence keys, never URLs here."""
    state = _ready()
    documents = data.get('documents')
    if (not isinstance(documents, list) or not 1 <= len(documents) <= 12
            or any(not isinstance(document, dict) for document in documents)):
        raise ValueError('识图结果不完整，请重新导入截图。')
    documents = copy.deepcopy(documents)
    session = {
        'schemaVersion': SESSION_SCHEMA,
        'id': _checked_id(data['id']) if 'id' in data else uuid.uuid4().hex,
        'revision': 1, 'documents': documents,
        'ledger': state['importer'].build_ledger(documents),
        'reviewed': False, 'scoringScenario': {'enabled': False},
    }
    return _score(session)


def _current_session(data):
    session = _session(data.get('session'))
    _checked_id(session.get('id'))
    original = data.get('original')
    if original is not None:
        original = _session(original)
        if original.get('id') != session['id']:
            raise ValueError('当前记录与本地保存的记录不一致。')
        # Edits cannot rewrite original source evidence, including source totals.
        session['documents'] = original['documents']
        expected = data.get('expectedRevision')
        if expected is not None and (
                type(expected) is not int or expected != original.get('revision', 1)
                or session.get('revision') != expected + 1):
            raise ValueError('记录已更新，请重新打开本机记录后再补充。')
        if session.get('revision', 0) < original.get('revision', 1):
            raise ValueError('旧版本计算已丢弃，请使用最新记录。')
    return session


def dispatch(request):
    """Pure operation dispatcher; callers persist successful returned sessions."""
    state = _ready()
    if not isinstance(request, dict) or not isinstance(request.get('op'), str):
        raise ValueError('浏览器计算请求格式无效。')
    op = request['op']
    data = request.get('data', request)
    if not isinstance(data, dict):
        raise ValueError('浏览器计算参数格式无效。')
    if op == 'init':
        return configuration()
    if op == 'import_record':
        return import_record(data)
    if op == 'from_documents':
        return from_documents(data)
    if op == 'restore':
        session = _session(data.get('session', data))
        session['id'] = uuid.uuid4().hex
        return _score(session)
    if op in ('revalidate_score', 'score', 'validate'):
        session = _current_session(data)
        if op == 'validate':
            state['service'].reject_hypothetical_ledger(session.get('ledger'))
            return {'ledger': state['importer'].revalidate_current_ledger(
                session['documents'], session.get('ledger'), reviewed=session.get('reviewed', False))}
        return _score(session)
    if op in ('hypothesis_plan', 'hypothesis_preview'):
        session = _current_session(data)
        from hypothesis import plan_hypothesis, preview_hypothesis
        args = (session['documents'], session.get('ledger'), data.get('poolId'), data.get('mode'))
        if op == 'hypothesis_plan':
            return plan_hypothesis(*args, reviewed=session.get('reviewed', False))
        return preview_hypothesis(*args, choices=data.get('choices'),
                                  additional_five=data.get('additionalFive'),
                                  reviewed=session.get('reviewed', False))
    raise ValueError('不支持的浏览器计算操作。')


def dispatch_json(text):
    """Stable JSON-only entry point. Unknown formats retain their UI error code."""
    try:
        if not isinstance(text, str) or len(text) > MAX_REQUEST_TEXT:
            raise ValueError('浏览器计算请求过大或格式无效。')
        result = dispatch(_strict_json(text))
        return json.dumps({'ok': True, 'value': result}, ensure_ascii=False, allow_nan=False)
    except Exception as exc:
        result = {'ok': False, 'error': str(exc)[:1000]}
        if getattr(exc, 'code', None) == 'record_format_unrecognized':
            result['code'] = exc.code
        return json.dumps(result, ensure_ascii=False, allow_nan=False)
