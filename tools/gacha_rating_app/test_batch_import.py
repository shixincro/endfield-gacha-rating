"""Per-image account isolation and partial failure tests, without running OCR."""
import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import server
from test_service import document, handler


class ImmediateWorker:
    def submit(self, fn, *args):
        fn(*args)


class BatchImportTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parent / 'test_outputs'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='batch-import-', dir=parent)
        self.root = Path(self.temp.name)
        for target, value in (('DATA', self.root), ('JOBS', {}), ('ENGINE', object())):
            mock = patch.object(server, target, value)
            mock.start()
            self.addCleanup(mock.stop)
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.analyzer = patch('importer.analyze_image', side_effect=self.analyze)
        self.analyzer.start()
        self.addCleanup(self.analyzer.stop)
        scorer = patch('service.score_ledger', side_effect=self.score)
        scorer.start()
        self.addCleanup(scorer.stop)

    def analyze(self, source, output, *, engine):
        blob = source.read_bytes()
        self.calls.append((source, output, blob))
        if blob == b'fail':
            raise ValueError('这张图无法识别')
        doc = document()
        number = len(self.calls)
        doc['source_sha256'] = str(number) * 64
        doc['identity']['uid'] = str(10000000 + number)
        doc['pools'][0].update(total=10 * number, tail=10 * (number - 1),
                                quota=2360 + 200 * (number - 1))
        return doc

    @staticmethod
    def score(ledger):
        return {'scoredAxes': 4,
                'sourceTotal': sum(p['total'] for p in ledger['character']['pools'])}

    def run_job(self, entries):
        job_id = 'a' * 32
        server.JOBS[job_id] = {'id': job_id, 'status': 'running', 'total': len(entries)}
        server.recognize_job(job_id, entries)
        return server.JOBS[job_id]

    def saved(self):
        return [json.loads(p.read_text(encoding='utf-8'))
                for p in sorted(self.root.glob('*/session.json'))]

    @staticmethod
    def png_entry(name, color='red'):
        out = io.BytesIO()
        Image.new('RGB', (200, 400), color).save(out, 'PNG')
        return {'name': name, 'data': base64.b64encode(out.getvalue()).decode('ascii')}

    def test_different_accounts_create_separate_evidence_ledgers_and_scores(self):
        job = self.run_job([{'name': '甲.png', 'blob': b'A'},
                            {'name': '乙.png', 'blob': b'B'}])
        self.assertEqual(job['status'], 'done')
        self.assertEqual((job['succeeded'], job['failed'], job['completed']), (2, 0, 2))
        self.assertEqual([i['name'] for i in job['items']], ['甲.png', '乙.png'])
        first, second = job['sessions']
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual([s['result']['sourceTotal'] for s in job['sessions']], [10, 20])
        for item, session, (_, _, blob) in zip(job['items'], job['sessions'], self.calls):
            self.assertEqual(item['sessionId'], session['id'])
            self.assertEqual(len(session['documents']), 1)
            self.assertEqual(len(session['ledger']['character']['pools']), 1)
            self.assertNotIn('account_mismatch', [i['code'] for i in session['ledger']['issues']])
            image_path = self.root / session['id'] / 'sources' / '00.png'
            self.assertEqual(image_path.read_bytes(), blob)
            self.assertEqual(session['documents'][0]['sourceImage'],
                             f"/data/{session['id']}/sources/00.png")
        self.assertEqual(len(self.saved()), 2)

    def test_middle_failure_does_not_discard_successes_or_change_input_order(self):
        job = self.run_job([{'name': '甲.png', 'blob': b'A'},
                            {'name': '错误.png', 'blob': b'fail'},
                            {'name': '丙.png', 'blob': b'C'}])
        self.assertEqual(job['status'], 'done')
        self.assertEqual((job['succeeded'], job['failed'], job['completed']), (2, 1, 3))
        self.assertEqual([i['index'] for i in job['items']], [0, 1, 2])
        self.assertEqual([i['status'] for i in job['items']], ['done', 'error', 'done'])
        self.assertEqual(job['items'][1]['error'], '这张图无法识别')
        self.assertNotIn('sessionId', job['items'][1])
        self.assertEqual([s['documents'][0]['file'] for s in job['sessions']], ['甲.png', '丙.png'])
        self.assertEqual(len(self.saved()), 2)

    def test_repeated_image_still_has_independent_record_and_directory(self):
        job = self.run_job([{'name': '同名.png', 'blob': b'A'},
                            {'name': '同名.png', 'blob': b'A'}])
        self.assertEqual(len(job['sessions']), 2)
        self.assertEqual(len(set(s['id'] for s in job['sessions'])), 2)
        self.assertEqual(len(self.calls), 2)
        self.assertNotEqual(self.calls[0][0], self.calls[1][0])

    def test_all_failed_images_do_not_create_empty_history_records(self):
        job = self.run_job([{'name': '甲.png', 'blob': b'fail'},
                            {'name': '乙.png', 'error': '错误的图片数据'}])
        self.assertEqual(job['status'], 'error')
        self.assertEqual((job['succeeded'], job['failed'], job['completed']), (0, 2, 2))
        self.assertEqual(job['sessions'], [])
        self.assertNotIn('session', job)
        self.assertEqual(self.saved(), [])
        self.assertEqual(len(job['items']), 2)

    def test_single_image_keeps_job_session_and_record_id_compatibility(self):
        job = self.run_job([{'name': '甲.png', 'blob': b'A'}])
        self.assertEqual(job['session']['id'], job['id'])
        self.assertEqual(job['session'], job['sessions'][0])
        self.assertEqual(job['items'][0]['sessionId'], job['id'])

    def test_save_failure_is_isolated_from_later_images(self):
        original_save = server.save_json
        attempts = []

        def save(path, session):
            attempts.append(path)
            if len(attempts) == 1:
                raise OSError('保存失败')
            original_save(path, session)

        with patch.object(server, 'save_json', side_effect=save):
            job = self.run_job([{'name': '甲.png', 'blob': b'A'},
                                {'name': '乙.png', 'blob': b'B'}])
        self.assertEqual(job['status'], 'done')
        self.assertEqual(job['items'][0]['error'], '保存失败')
        self.assertEqual(job['sessions'][0]['documents'][0]['file'], '乙.png')
        self.assertEqual(len(self.saved()), 1)

    def test_endpoint_mixed_valid_and_invalid_images_exposes_separate_history(self):
        entries = [self.png_entry('甲.png'), {'name': 'bad.html', 'data': 'eA=='},
                   self.png_entry('乙.png', 'blue')]
        with patch.object(server, 'WORKER', ImmediateWorker()):
            status, response = handler('POST', '/api/import', {'files': entries})
        self.assertEqual(status, 202, response)
        status, job = handler('GET', '/api/jobs/' + response['id'])
        self.assertEqual(status, 200)
        self.assertEqual(job['status'], 'done')
        self.assertEqual((job['succeeded'], job['failed']), (2, 1))
        self.assertIn('PNG', job['items'][1]['error'])
        # This serializes the actual response and would fail if uploaded blobs
        # leaked into JOBS. Base64 image data must not be echoed either.
        public = json.dumps(job, ensure_ascii=False)
        self.assertNotIn(entries[0]['data'], public)
        self.assertNotIn('blob', public)
        status, history = handler('GET', '/api/sessions')
        self.assertEqual(status, 200)
        self.assertEqual({h['name'] for h in history}, {'甲.png', '乙.png'})
        for session in job['sessions']:
            status, loaded = handler('GET', '/api/sessions/' + session['id'])
            self.assertEqual(status, 200)
            self.assertEqual(loaded['ledger'], session['ledger'])
            self.assertEqual(loaded['result'], session['result'])

    def test_all_invalid_batch_reports_each_file_without_loading_ocr(self):
        entries = [{'name': 'bad.html', 'data': 'eA=='},
                   {'name': 'bad.png', 'data': 'not-base64'}]
        with patch.object(server, 'ENGINE', None), patch.object(server, 'WORKER', ImmediateWorker()):
            status, response = handler('POST', '/api/import', {'files': entries})
        self.assertEqual(status, 202, response)
        job = server.JOBS[response['id']]
        self.assertEqual(job['status'], 'error')
        self.assertEqual(len(job['items']), 2)
        self.assertEqual(job['completed'], 2)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.saved(), [])

    def test_damaged_image_has_readable_error_for_single_upload(self):
        entry={'name':'损坏.png','data':base64.b64encode(b'not an image').decode('ascii')}
        status,response=handler('POST','/api/import',{'files':[entry]})
        self.assertEqual(status,400)
        self.assertEqual(response['error'],'无法读取图片，请检查文件是否损坏或重新导出。')
        self.assertNotIn('BytesIO',response['error'])
        self.assertNotIn('0x',response['error'])
        self.assertEqual(self.saved(),[])

    def test_batch_decode_and_verify_errors_are_readable_and_keep_specific_limits(self):
        good=self.png_entry('正常.png')
        truncated=base64.b64decode(good['data'])[:-30]
        small=io.BytesIO();Image.new('RGB',(100,100),'red').save(small,'PNG')
        entries=[good,{'name':'损坏.png','data':'eA=='},
                 {'name':'无效数据.png','data':'not-base64'},
                 {'name':'截断.png','data':base64.b64encode(truncated).decode('ascii')},
                 {'name':'太小.png','data':base64.b64encode(small.getvalue()).decode('ascii')},
                 {'name':'格式.html','data':'eA=='}]
        with patch.object(server,'WORKER',ImmediateWorker()):
            status,response=handler('POST','/api/import',{'files':entries})
        self.assertEqual(status,202,response)
        job=server.JOBS[response['id']]
        self.assertEqual((job['succeeded'],job['failed']),(1,5))
        for item in job['items'][1:4]:
            self.assertEqual(item['error'],'无法读取图片，请检查文件是否损坏或重新导出。')
        self.assertIn('截图尺寸不受支持',job['items'][4]['error'])
        self.assertEqual(job['items'][5]['error'],'仅支持PNG、JPG、WebP截图。')
        self.assertNotIn('BytesIO',json.dumps(job,ensure_ascii=False))
        self.assertEqual(len(self.saved()),1)

    def test_running_job_rejects_another_batch_without_creating_records(self):
        server.JOBS['b' * 32] = {'status': 'running'}
        with patch.object(server.WORKER, 'submit') as submit:
            status, response = handler('POST', '/api/import', {'files': [self.png_entry('甲.png')]})
        self.assertEqual(status, 409, response)
        submit.assert_not_called()
        self.assertEqual(len(server.JOBS), 1)
        self.assertEqual(self.saved(), [])

    def test_failed_worker_submission_releases_job_reservation(self):
        with patch.object(server.WORKER, 'submit', side_effect=RuntimeError('worker unavailable')):
            status, response = handler('POST', '/api/import', {'files': [self.png_entry('甲.png')]})
        self.assertEqual(status, 400, response)
        self.assertEqual(server.JOBS, {})

    def test_job_started_during_image_validation_is_rejected_before_submission(self):
        original_open = Image.open

        def open_with_competing_job(*args, **kwargs):
            image = original_open(*args, **kwargs)
            server.JOBS['b' * 32] = {'status': 'running'}
            return image

        entry = self.png_entry('甲.png')
        with patch('PIL.Image.open', side_effect=open_with_competing_job), \
                patch.object(server.WORKER, 'submit') as submit:
            status, response = handler('POST', '/api/import', {'files': [entry]})
        self.assertEqual(status, 409, response)
        submit.assert_not_called()
        self.assertEqual(set(server.JOBS), {'b' * 32})
        self.assertEqual(self.saved(), [])


if __name__ == '__main__':
    unittest.main()
