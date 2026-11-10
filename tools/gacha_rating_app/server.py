"""Loopback screenshot-rating prototype. Run with the existing OCR venv."""
from __future__ import annotations
import argparse
import base64
import io
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import stat
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from planning import VERSION as PLANNING_VERSION
from weapon_scoring import VERSION as WEAPON_VERSION
from importer import RECOGNITION_VERSION

ROOT = Path(__file__).resolve().parent
CHARACTER_VERSION = re.search(r"const VERSION = '([^']+)'", (ROOT/'character_score.js').read_text(encoding='utf-8')).group(1)
DATA = ROOT/'data'
TOKEN = secrets.token_urlsafe(32)
JOBS = {}
LOCK = threading.RLock()
WORKER = ThreadPoolExecutor(max_workers=1)
ENGINE = None
MAX_BODY = 100*1024*1024
MAX_DELETE_IDS = 1000

def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temporary, path)

def checked_id(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{32}',value):
        raise ValueError('无效的任务编号。')
    return value


def _plain_path(path):
    """Reject symlinks and Windows reparse points, including junctions."""
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError('记录目录包含链接或重解析点，拒绝操作。')
    return metadata


def session_directory(session_id):
    """Return only this ID's direct, ordinary directory under canonical DATA."""
    checked_id(session_id)
    _plain_path(DATA)
    root = DATA.resolve()
    directory = root/session_id
    metadata = _plain_path(directory)
    resolved = directory.resolve()
    if not stat.S_ISDIR(metadata.st_mode) or resolved.parent != root or resolved.name != session_id:
        raise ValueError('记录路径不属于本机历史记录目录。')
    return directory


def _has_shared_session_evidence(session_id, directory):
    """Restored JSON may still refer to another record's original images."""
    def references(value):
        if isinstance(value, dict):
            return any(references(child) for child in value.values())
        if isinstance(value, list):
            return any(references(child) for child in value)
        if not isinstance(value, str):
            return False
        decoded = unquote(value).replace('\\', '/')
        try:
            if decoded.startswith('/data/'):
                return (DATA/decoded[6:]).resolve().is_relative_to(directory)
            path = Path(decoded)
            return path.is_absolute() and path.resolve().is_relative_to(directory)
        except (ValueError, OSError):
            return False
    for candidate in DATA.iterdir():
        if candidate.name == session_id or not re.fullmatch(r'[a-f0-9]{32}', candidate.name):
            continue
        try:
            saved = session_directory(candidate.name)/'session.json'
            _plain_path(saved)
            other = json.loads(saved.read_text(encoding='utf-8'))
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            # Unknown contents cannot prove the images are exclusively owned.
            return True
        if references(other):
            return True
    return False


def _delete_session_directory(session_id):
    directory = session_directory(session_id)
    saved = directory/'session.json'
    if not stat.S_ISREG(_plain_path(saved).st_mode):
        raise ValueError('记录文件格式错误。')
    saved_bytes = saved.read_bytes()
    record = json.loads(saved_bytes)
    if not isinstance(record, dict) or record.get('id') != session_id or record.get('schemaVersion') != 'gacha-rating-session-v1':
        raise ValueError('记录文件与待删除编号不一致。')
    # Preflight the entire owned tree before removing any content. Reparse
    # points are rejected even if their current target happens to be in DATA.
    root = DATA.resolve()
    pending = [directory]
    while pending:
        current = pending.pop()
        metadata = _plain_path(current)
        resolved = current.resolve()
        if not resolved.is_relative_to(directory) or directory.parent != root:
            raise ValueError('记录内文件路径越界，拒绝删除。')
        if stat.S_ISDIR(metadata.st_mode):
            pending.extend(current.iterdir())
        elif not stat.S_ISREG(metadata.st_mode):
            raise ValueError('记录包含不支持的特殊文件，拒绝删除。')
    # Recheck the final absolute target immediately before the platform's
    # unlink-aware recursive removal (which never traverses Windows junctions).
    if session_directory(session_id) != directory:
        raise ValueError('记录路径发生变化，请重试。')
    if _has_shared_session_evidence(session_id, directory):
        saved.unlink()
        return True
    # Keep session.json until every image/crop is gone, so a locked image
    # leaves a visible, retryable failed record instead of orphaned files.
    for child in directory.iterdir():
        if child.name == 'session.json':
            continue
        if session_directory(session_id) != directory:
            raise ValueError('记录路径发生变化，请重试。')
        metadata = _plain_path(child)
        if not child.resolve().is_relative_to(directory):
            raise ValueError('记录内文件路径越界，拒绝删除。')
        if stat.S_ISDIR(metadata.st_mode):
            shutil.rmtree(child)
        else:
            child.unlink()
    if session_directory(session_id) != directory:
        raise ValueError('记录路径发生变化，请重试。')
    saved.unlink()
    try:
        directory.rmdir()
    except OSError:
        # A concurrent external file or open directory handle may prevent
        # the final removal. Restore the listing metadata for another attempt.
        if session_directory(session_id) == directory:
            saved.write_bytes(saved_bytes)
        raise
    return False


def delete_sessions(ids):
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_DELETE_IDS:
        raise ValueError(f'每次请选择1—{MAX_DELETE_IDS}条本机记录。')
    # Validate the whole request before the first destructive operation.
    session_ids = list(dict.fromkeys(checked_id(value) for value in ids))
    result = {'deleted':[], 'missing':[], 'failed':[], 'retainedEvidence':[]}
    with LOCK:
        for session_id in session_ids:
            try:
                directory = session_directory(session_id)
                _plain_path(directory/'session.json')
            except FileNotFoundError:
                result['missing'].append(session_id)
                continue
            except (OSError, ValueError) as exc:
                result['failed'].append({'id':session_id, 'error':str(exc)[:1000]})
                continue
            try:
                retained = _delete_session_directory(session_id)
                result['deleted'].append(session_id)
                if retained:
                    result['retainedEvidence'].append(session_id)
            except (OSError, ValueError) as exc:
                result['failed'].append({'id':session_id, 'error':str(exc)[:1000]})
    return result


def local_evidence_path(value, data_root, suffixes):
    """Resolve only app-owned evidence, including old absolute local paths."""
    if not isinstance(value, str):
        return None
    root = Path(data_root).resolve()
    if value.startswith('/data/'):
        path = root / unquote(value[6:])
    else:
        path = Path(value)
        if not path.is_absolute():
            return None
    path = path.resolve()
    if path.is_relative_to(root) and path.suffix.lower() in suffixes and path.is_file():
        return path
    return None


def ensure_review_evidence(session, data_root):
    """Enrich old records from saved pixels/OCR only; preserve reviewed values.

    This does not re-recognize, rebuild the ledger, score, or save session.json.
    Unavailable evidence falls back to a full source image when one exists.
    """
    from importer import attach_pool_image_evidence
    from service import public_document

    documents = session.get('documents', [])
    weapon_documents = [d for d in documents if d.get('weapon')]
    weapon_source = max(weapon_documents, key=lambda d: (
        d['weapon'].get('B') is not None, len(d['weapon'].get('sections', [])))) if weapon_documents else None
    for document in documents:
        source = local_evidence_path(document.get('sourceImage'), data_root,
                                     ('.png', '.jpg', '.jpeg', '.webp'))
        if source is None:
            continue
        raw_pools = document.get('pools', [])
        missing = any(not p.get('evidence', {}).get('crop') for p in raw_pools)
        rows_path = local_evidence_path(document.get('rawOcrPath'), data_root, ('.json',))
        if missing and rows_path:
            try:
                rows = json.loads(rows_path.read_text(encoding='utf-8'))
                if isinstance(rows, list):
                    attach_pool_image_evidence(raw_pools, rows, source,
                                               rows_path.parent / 'pool_evidence')
            except (OSError, ValueError, KeyError, TypeError):
                # Restored JSON may no longer have its original pixels/cache.
                # Do not turn missing preview evidence into a scoring failure.
                pass
        source_url = '/data/' + source.relative_to(Path(data_root).resolve()).as_posix()
        for raw in raw_pools:
            raw.setdefault('evidence', {})['sourceImage'] = source_url
        public = public_document(document, Path(data_root).resolve())
        document.update(public)
        evidence_by_banner = {p.get('banner'): p.get('evidence', {}) for p in document.get('pools', [])}
        sha = document.get('source_sha256')
        for pool in session.get('ledger', {}).get('character', {}).get('pools', []):
            evidence = pool.setdefault('evidence', {})
            same_source = (sha is not None and evidence.get('source_sha256') == sha)
            if same_source:
                preview = evidence_by_banner.get(pool.get('banner'), {})
                for key in ('crop', 'sourceImage', 'box', 'coordinateSpace', 'sourceSize'):
                    if key in preview:
                        evidence[key] = preview[key]
                evidence.setdefault('sourceImage', source_url)
        weapon = session.get('ledger', {}).get('weapon')
        if weapon and document is weapon_source:
            evidence = weapon.setdefault('evidence', {})
            if not evidence.get('sourceImage'):
                evidence.update(sourceImage=source_url, source_sha256=sha, file=document.get('file'))
    weapon = session.get('ledger', {}).get('weapon')
    if weapon and 'upAverage' not in weapon:
        from importer import recover_weapon_average
        average = recover_weapon_average(weapon)
        if average:
            weapon['upAverage'] = average['value']
    return session


def recognize_job(job_id, files):
    """Recognize each input into its own account record, in input order.

    A failed image never discards another image's completed record. The job
    exposes only names, results and errors, never the uploaded byte buffers.
    """
    global ENGINE
    from service import score_ledger, public_document
    from importer import analyze_image, build_ledger
    sessions = []
    items = []
    engine_error = None
    for index, entry in enumerate(files):
        name = entry['name']
        item = {'index': index, 'name': name}
        with LOCK:
            JOBS[job_id].update(message=f'正在识别 {index+1}/{len(files)}：{name}', completed=index)
        try:
            if entry.get('error'):
                raise ValueError(entry['error'])
            if engine_error:
                raise RuntimeError(engine_error)
            if ENGINE is None:
                try:
                    from rapidocr_onnxruntime import RapidOCR
                    ENGINE = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1, use_cls=False)
                except Exception as exc:
                    engine_error = str(exc)[:1000]
                    raise
            start = time.perf_counter()
            session_id = job_id if len(files) == 1 else uuid.uuid4().hex
            directory = DATA/session_id
            suffix=Path(name).suffix.lower()
            path=directory/'sources'/f'00{suffix}'
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(entry['blob'])
            doc=analyze_image(path,directory/'image_00',engine=ENGINE)
            doc['file']=name
            doc['sourceImage']=str(path)
            documents=[public_document(doc,DATA)]
            ledger=build_ledger(documents)
            result=score_ledger(ledger)
            session={'schemaVersion':'gacha-rating-session-v1','id':session_id,'revision':1,
                     'documents':documents,'ledger':ledger,'result':result,'reviewed':False,
                     'recognitionVersion':RECOGNITION_VERSION,
                     'updatedAt':time.time(),'importSeconds':time.perf_counter()-start}
            save_json(directory/'session.json',session)
            sessions.append(session)
            item.update(status='done', sessionId=session_id)
        except Exception as exc:
            item.update(status='error', error=str(exc)[:1000])
        items.append(item)
        with LOCK:
            JOBS[job_id].update(items=list(items), sessions=list(sessions),
                                completed=index+1, succeeded=len(sessions), failed=len(items)-len(sessions))
    failed = len(items)-len(sessions)
    with LOCK:
        JOBS[job_id].update(status='done' if sessions else 'error',
                            message=f'已独立保存 {len(sessions)} 条记录' + (f'，{failed} 张失败' if failed else ''),
                            completed=len(files))
        if sessions:
            # Existing single-image clients can still read job.session.
            JOBS[job_id]['session'] = sessions[0]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, status, body, content_type='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body=json.dumps(body,ensure_ascii=False,allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        return self.headers.get('Host','') in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}')

    def do_GET(self):
        try:
            if not self.allowed():
                return self.send(403,{'error':'仅接受本机访问。'})
            path=unquote(urlsplit(self.path).path)
            if path=='/api/config':
                from service import SCENARIO_VERSION
                from history_interruption import VERSION as INTERRUPTION_VERSION
                return self.send(200,{'token':TOKEN,'version':'gacha-rating-local-v1','localOnly':True,'planningVersion':PLANNING_VERSION,'characterVersion':CHARACTER_VERSION,'weaponVersion':WEAPON_VERSION,'recognitionVersion':RECOGNITION_VERSION,'scoringScenarioVersion':SCENARIO_VERSION,'interruptionVersion':INTERRUPTION_VERSION})
            if path.startswith('/api/jobs/'):
                job_id=checked_id(path.rsplit('/',1)[-1])
                with LOCK:
                    job=JOBS.get(job_id)
                    return self.send(200,dict(job)) if job else self.send(404,{'error':'任务不存在。'})
            if path=='/api/sessions':
                rows=[]
                with LOCK:
                    try:
                        _plain_path(DATA)
                        candidates=list(DATA.iterdir())
                    except FileNotFoundError:
                        candidates=[]
                    for candidate in candidates:
                        try:
                            session_id=checked_id(candidate.name)
                            file=session_directory(session_id)/'session.json'
                            if not stat.S_ISREG(_plain_path(file).st_mode):
                                continue
                            item=json.loads(file.read_text(encoding='utf-8'))
                            if (item.get('id')!=session_id or item.get('schemaVersion')!='gacha-rating-session-v1'
                                    or type(item.get('updatedAt')) not in (int,float)
                                    or not math.isfinite(item['updatedAt'])):
                                continue
                            rows.append({'id':session_id,'updatedAt':item['updatedAt'],
                                         'name':'、'.join(d.get('file','截图') for d in item.get('documents',[])),
                                         'reviewed':item.get('reviewed',False)})
                        except (OSError,ValueError,TypeError,AttributeError):
                            # One corrupt or concurrently unavailable record
                            # must not hide the remaining local history.
                            continue
                rows.sort(key=lambda row:row['updatedAt'],reverse=True)
                return self.send(200,rows)
            if path.startswith('/api/sessions/'):
                with LOCK:
                    try:
                        file=session_directory(checked_id(path.rsplit('/',1)[-1]))/'session.json'
                        _plain_path(file)
                        session=json.loads(file.read_text(encoding='utf-8'))
                        session=ensure_review_evidence(session, DATA)
                    except FileNotFoundError:
                        return self.send(404,{'error':'记录不存在。'})
                return self.send(200,session)
            if path.startswith('/data/'):
                file=(DATA/path[6:]).resolve()
                if not file.is_relative_to(DATA.resolve()) or file.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):
                    return self.send(403,{'error':'禁止访问。'})
            else:
                if path not in ('/','/index.html','/app.js','/ui-model.js','/character-edit.js','/manual-supplement.js','/style.css'):
                    return self.send(404,{'error':'页面不存在。'})
                file=ROOT/'static'/('index.html' if path=='/' else path.lstrip('/'))
            if not file.is_file():
                return self.send(404,{'error':'文件不存在。'})
            mime=mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
            return self.send(200,file.read_bytes(),mime+('; charset=utf-8' if mime.startswith('text/') else ''))
        except (ValueError,OSError) as exc:
            self.send(400,{'error':str(exc)})

    def do_POST(self):
        try:
            if not self.allowed() or self.headers.get('X-App-Token')!=TOKEN:
                return self.send(403,{'error':'本机会话已过期，请刷新页面。'})
            origin=self.headers.get('Origin')
            if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'):
                return self.send(403,{'error':'不接受跨站请求。'})
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=MAX_BODY:
                return self.send(413,{'error':'文件过大：一批最多75 MB。'})
            if not self.headers.get('Content-Type','').startswith('application/json'):
                return self.send(415,{'error':'请求格式必须是JSON。'})
            data=json.loads(self.rfile.read(length))
            path=urlsplit(self.path).path
            if path=='/api/sessions/delete':
                if not isinstance(data,dict):
                    raise ValueError('删除请求格式错误。')
                return self.send(200,delete_sessions(data.get('ids')))
            if path in ('/api/hypothesis/plan','/api/hypothesis/preview'):
                from hypothesis import plan_hypothesis, preview_hypothesis
                session=data.get('session') if isinstance(data,dict) else None
                if not isinstance(session,dict) or session.get('schemaVersion')!='gacha-rating-session-v1':
                    raise ValueError('请先打开已有抽卡记录，再进行假设补抽。')
                with LOCK:
                    try:
                        saved=session_directory(checked_id(session.get('id')))/'session.json'
                        _plain_path(saved)
                        original=json.loads(saved.read_text(encoding='utf-8'))
                    except FileNotFoundError:
                        return self.send(404,{'error':'记录已删除或不存在，无法进行假设补抽。'})
                arguments=(original['documents'], session.get('ledger'), data.get('poolId'), data.get('mode'))
                if path.endswith('plan'):
                    result=plan_hypothesis(*arguments, reviewed=session.get('reviewed',False))
                else:
                    result=preview_hypothesis(*arguments, choices=data.get('choices'),
                                             additional_five=data.get('additionalFive'),
                                             reviewed=session.get('reviewed',False))
                return self.send(200,result)
            if path=='/api/import':
                files=data.get('files')
                if not isinstance(files,list) or not 1<=len(files)<=12:
                    raise ValueError('每批选择1—12张小黑盒截图，每张图片按一人独立建档。')
                with LOCK:
                    if any(j['status']=='running' for j in JOBS.values()):
                        return self.send(409,{'error':'已有识别任务正在运行，请等待完成。'})
                decoded=[]
                from PIL import Image
                for entry in files:
                    name=str(entry.get('name',''))[:200] if isinstance(entry,dict) else '无效文件'
                    try:
                        if Path(name).suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):
                            raise ValueError('仅支持PNG、JPG、WebP截图。')
                        try:
                            blob=base64.b64decode(entry['data'],validate=True)
                        except (KeyError,TypeError,ValueError):
                            raise ValueError('无法读取图片，请检查文件是否损坏或重新导出。') from None
                        if len(blob)>25*1024*1024:
                            raise ValueError('单张截图不能超过25 MB。')
                        size_error='截图尺寸不受支持，请使用原始长截图（至多6500万像素）。'
                        try:
                            with Image.open(io.BytesIO(blob)) as im:
                                valid_size=im.width>=200 and im.height>=400 and im.width*im.height<=65_000_000
                                if valid_size:
                                    im.verify()
                        except Image.DecompressionBombError:
                            raise ValueError(size_error) from None
                        except (OSError,SyntaxError,ValueError):
                            raise ValueError('无法读取图片，请检查文件是否损坏或重新导出。') from None
                        if not valid_size:
                            raise ValueError(size_error)
                        decoded.append({'name':name,'blob':blob})
                    except Exception as exc:
                        if len(files)==1:
                            raise
                        decoded.append({'name':name,'error':str(exc)[:1000]})
                job_id=uuid.uuid4().hex
                with LOCK:
                    # Validation above can take time. Reserve the worker under
                    # the same lock as the final running-job check.
                    if any(j['status']=='running' for j in JOBS.values()):
                        return self.send(409,{'error':'已有识别任务正在运行，请等待完成。'})
                    JOBS[job_id]={'id':job_id,'status':'running','message':'正在初始化识别',
                                  'completed':0,'total':len(files),'items':[],'sessions':[],
                                  'succeeded':0,'failed':0}
                    try:
                        WORKER.submit(recognize_job,job_id,decoded)
                    except Exception:
                        JOBS.pop(job_id,None)
                        raise
                return self.send(202,{'id':job_id})
            if path in ('/api/score','/api/restore','/api/validate'):
                from service import normalize_scoring_scenario, score_session_result, reject_hypothetical_ledger
                from importer import revalidate_current_ledger
                session=data if path.endswith('restore') else data.get('session')
                if not isinstance(session,dict) or session.get('schemaVersion')!='gacha-rating-session-v1' or not session.get('documents'):
                    raise ValueError('请先导入截图或本工具导出的完整记录。')
                reject_hypothetical_ledger(session.get('ledger'))
                if path.endswith('restore'):
                    session['id']=uuid.uuid4().hex
                session_id=checked_id(session['id'])
                saved=DATA/session_id/'session.json'
                if not path.endswith('restore'):
                    with LOCK:
                        try:
                            saved=session_directory(session_id)/'session.json'
                            _plain_path(saved)
                            original=json.loads(saved.read_text(encoding='utf-8'))
                        except FileNotFoundError:
                            return self.send(404,{'error':'记录已删除或不存在，请重新导入截图或恢复保存的记录。'})
                    session['documents']=original['documents']
                # Preserve original evidence, but compare its top-card numbers
                # against the edited ledger instead of stale OCR identities.
                session['ledger']=revalidate_current_ledger(session['documents'], session['ledger'],
                                                            reviewed=session.get('reviewed',False))
                if path.endswith('validate'):
                    return self.send(200,{'ledger':session['ledger']})
                session['scoringScenario']=normalize_scoring_scenario(session.get('scoringScenario', {'enabled':False}))
                session['result']=score_session_result(session['documents'], session['ledger'],
                                                       session['scoringScenario'], reviewed=session.get('reviewed',False))
                session['recognitionVersion']=RECOGNITION_VERSION
                session['updatedAt']=time.time()
                if type(session.get('revision')) is not int or session['revision']<1:
                    raise ValueError('记录版本无效。')
                with LOCK:
                    if not path.endswith('restore'):
                        try:
                            saved=session_directory(session_id)/'session.json'
                            _plain_path(saved)
                        except FileNotFoundError:
                            return self.send(404,{'error':'记录已删除，本次计算未保存。'})
                    if saved.is_file():
                        current=json.loads(saved.read_text(encoding='utf-8'))
                        if path == '/api/score' and 'expectedRevision' in data:
                            expected = data['expectedRevision']
                            if (type(expected) is not int or expected != current.get('revision', 1)
                                    or session['revision'] != expected + 1):
                                return self.send(409, {'error':'记录已更新，请重新打开本机记录后再补充。'})
                        if session['revision']<current.get('revision',1):
                            return self.send(409,{'error':'旧版本计算已丢弃，请使用最新记录。'})
                    save_json(saved,session)
                return self.send(200,session)
            self.send(404,{'error':'接口不存在。'})
        except Exception as exc:
            self.send(400,{'error':str(exc)[:1000]})

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=4320)
    args=parser.parse_args()
    DATA.mkdir(exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'Local: http://127.0.0.1:{server.server_port}/',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        WORKER.shutdown(wait=False,cancel_futures=True)

if __name__=='__main__':
    main()
