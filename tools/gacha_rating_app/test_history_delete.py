"""Batch history deletion uses isolated files; no player records are touched."""
import copy
import json
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import server
from importer import build_ledger
from test_service import document, handler


class HistoryDeleteTests(unittest.TestCase):
    def setUp(self):
        directory = Path(__file__).resolve().parent/'test_outputs'
        directory.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='delete-history-', dir=directory)
        self.data = Path(self.temp.name)/'data'
        self.data.mkdir()
        self.data_patch = patch.object(server, 'DATA', self.data)
        self.data_patch.start()

    def tearDown(self):
        self.data_patch.stop()
        self.temp.cleanup()

    def session(self, number):
        session_id = f'{number:032x}'
        record = {'id':session_id, 'schemaVersion':'gacha-rating-session-v1', 'revision':1,
                  'updatedAt':number, 'documents':[document()], 'ledger':build_ledger([document()])}
        directory = self.data/session_id
        server.save_json(directory/'session.json', record)
        for path in (directory/'sources'/'original.png', directory/'image_00'/'crops'/'event.png'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture image')
        return record

    def delete(self, ids, headers=None):
        return handler('POST', '/api/sessions/delete', {'ids':ids}, headers)

    def test_delete_two_deduplicates_ids_and_keeps_other_record_and_images(self):
        records = [self.session(i) for i in (1, 2, 3)]
        ids = [record['id'] for record in records]
        untouched = {path.relative_to(self.data):path.read_bytes()
                     for path in (self.data/ids[2]).rglob('*') if path.is_file()}
        outside = Path(self.temp.name)/'original.png'
        outside.write_bytes(b'outside')
        code, result = self.delete([ids[0], ids[1], ids[0]])
        self.assertEqual(code, 200)
        self.assertEqual(result, {'deleted':ids[:2], 'missing':[], 'failed':[], 'retainedEvidence':[]})
        self.assertFalse((self.data/ids[0]).exists())
        self.assertFalse((self.data/ids[1]).exists())
        self.assertTrue(all((self.data/path).read_bytes() == content for path, content in untouched.items()))
        self.assertEqual(outside.read_bytes(), b'outside')

    def test_invalid_id_anywhere_rejects_entire_batch_before_deletion(self):
        session_id = self.session(1)['id']
        for invalid in ('../outside', 'A'*32, '', None, 1, True, {}, []):
            with self.subTest(invalid=invalid):
                code, _ = self.delete([session_id, invalid])
                self.assertEqual(code, 400)
                self.assertTrue((self.data/session_id/'session.json').is_file())
        for ids in (None, {}, session_id, [], [session_id]*(server.MAX_DELETE_IDS + 1)):
            self.assertEqual(self.delete(ids)[0], 400)
        self.assertEqual(handler('POST', '/api/sessions/delete', [session_id])[0], 400)

    def test_missing_records_are_idempotent(self):
        session_id = self.session(1)['id']
        absent = f'{2:032x}'
        self.assertEqual(self.delete([session_id, absent])[1],
                         {'deleted':[session_id], 'missing':[absent], 'failed':[], 'retainedEvidence':[]})
        self.assertEqual(self.delete([session_id, absent])[1],
                         {'deleted':[], 'missing':[session_id, absent], 'failed':[], 'retainedEvidence':[]})

    def test_image_failure_is_partial_and_record_remains_visible_and_retryable(self):
        failed_id, good_id = [self.session(i)['id'] for i in (1, 2)]
        remove = server.shutil.rmtree
        def fail_one(path, *args, **kwargs):
            if failed_id in Path(path).parts:
                raise PermissionError('图片正在使用')
            return remove(path, *args, **kwargs)
        with patch('server.shutil.rmtree', side_effect=fail_one):
            code, result = self.delete([failed_id, good_id])
        self.assertEqual(code, 200)
        self.assertEqual(result['deleted'], [good_id])
        self.assertEqual(result['missing'], [])
        self.assertEqual(result['failed'], [{'id':failed_id, 'error':'图片正在使用'}])
        self.assertTrue((self.data/failed_id/'session.json').is_file())
        self.assertEqual([row['id'] for row in handler('GET', '/api/sessions')[1]], [failed_id])
        self.assertEqual(self.delete([failed_id])[1]['deleted'], [failed_id])

    def test_final_directory_failure_restores_metadata_for_retry(self):
        session_id = self.session(1)['id']
        target = self.data/session_id
        original = (target/'session.json').read_bytes()
        rmdir = Path.rmdir
        def fail_root(path):
            if path == target:
                raise PermissionError('目录正在使用')
            return rmdir(path)
        with patch.object(Path, 'rmdir', fail_root):
            code, result = self.delete([session_id])
        self.assertEqual(code, 200)
        self.assertEqual(result['failed'][0]['id'], session_id)
        self.assertEqual((target/'session.json').read_bytes(), original)
        self.assertEqual(self.delete([session_id])[1]['deleted'], [session_id])

    def test_disappearing_content_during_delete_is_failed_not_missing(self):
        session_id = self.session(1)['id']
        with patch('server._delete_session_directory', side_effect=FileNotFoundError('文件发生变化')):
            _, result = self.delete([session_id])
        self.assertEqual(result['missing'], [])
        self.assertEqual(result['failed'][0]['id'], session_id)

    def test_token_host_and_origin_guards_apply_to_delete(self):
        session_id = self.session(1)['id']
        for headers in ({'X-App-Token':''}, {'Host':'evil.test:4320'}, {'Origin':'https://evil.test'}):
            self.assertEqual(self.delete([session_id], headers)[0], 403)
            self.assertTrue((self.data/session_id/'session.json').is_file())

    def test_restore_shared_original_images_survive_deleting_old_history_entry(self):
        original = self.session(1)
        original['documents'][0]['sourceImage'] = '/data/'+original['id']+'/sources/original.png'
        server.save_json(self.data/original['id']/'session.json', original)
        with patch('service.score_ledger', return_value={'test':'restored'}):
            code, restored = handler('POST', '/api/restore', copy.deepcopy(original))
        self.assertEqual(code, 200, restored)
        self.assertNotEqual(restored['id'], original['id'])
        code, result = self.delete([original['id']])
        self.assertEqual(code, 200)
        self.assertEqual(result['deleted'], [original['id']])
        self.assertEqual(result['retainedEvidence'], [original['id']])
        self.assertFalse((self.data/original['id']/'session.json').exists())
        self.assertTrue((self.data/original['id']/'sources'/'original.png').is_file())
        self.assertEqual([row['id'] for row in handler('GET', '/api/sessions')[1]], [restored['id']])
        self.assertEqual(handler('GET', restored['documents'][0]['sourceImage'])[0], 200)
        self.assertEqual(handler('POST', '/api/score', {'session':original})[0], 404)

    def test_nested_absolute_and_url_evidence_references_are_preserved(self):
        for index, public in enumerate((True, False)):
            original, other = self.session(10+index*2), self.session(11+index*2)
            crop = self.data/original['id']/'image_00'/'crops'/'event.png'
            reference = '/data/'+original['id']+'/image_00/crops/event.png' if public else str(crop)
            other['ledger']['character']['pools'][0]['events'][0]['evidence']['crop'] = reference
            server.save_json(self.data/other['id']/'session.json', other)
            _, result = self.delete([original['id']])
            self.assertEqual(result['retainedEvidence'], [original['id']])
            self.assertTrue(crop.is_file())
            self.assertTrue((self.data/other['id']/'session.json').is_file())

    def test_same_batch_reference_is_kept_when_referencing_record_later_fails(self):
        original, other = self.session(1), self.session(2)
        other['documents'][0]['sourceImage'] = '/data/'+original['id']+'/sources/original.png'
        server.save_json(self.data/other['id']/'session.json', other)
        remove = server._delete_session_directory
        def fail_other(session_id):
            if session_id == other['id']:
                raise PermissionError('另一条记录正在使用')
            return remove(session_id)
        with patch('server._delete_session_directory', side_effect=fail_other):
            _, result = self.delete([original['id'], other['id']])
        self.assertEqual(result['deleted'], [original['id']])
        self.assertEqual(result['retainedEvidence'], [original['id']])
        self.assertEqual(result['failed'][0]['id'], other['id'])
        self.assertTrue((self.data/original['id']/'sources'/'original.png').is_file())
        self.assertTrue((self.data/other['id']/'session.json').is_file())

    def test_public_evidence_paths_are_decoded_and_normalized(self):
        original, other = self.session(1), self.session(2)
        other['documents'][0]['sourceImage'] = '/data/'+other['id']+'/../'+original['id']+'%2Fsources%2Foriginal.png'
        server.save_json(self.data/other['id']/'session.json', other)
        _, result = self.delete([original['id']])
        self.assertEqual(result['retainedEvidence'], [original['id']])
        self.assertTrue((self.data/original['id']/'sources'/'original.png').is_file())

    def test_removed_reference_no_longer_prevents_exclusive_directory_deletion(self):
        original, other = self.session(1), self.session(2)
        other['documents'][0]['sourceImage'] = '/data/'+original['id']+'/sources/original.png'
        server.save_json(self.data/other['id']/'session.json', other)
        _, result = self.delete([other['id'], original['id']])
        self.assertEqual(result['deleted'], [other['id'], original['id']])
        self.assertEqual(result['retainedEvidence'], [])
        self.assertFalse((self.data/original['id']).exists())

    def test_list_returns_all_valid_records_and_skips_corrupt_entries(self):
        ids = [self.session(i)['id'] for i in range(1, 21)]
        broken = self.session(21)['id']
        (self.data/broken/'session.json').write_text('{broken', encoding='utf-8')
        mismatch = self.session(22)
        mismatch['id'] = ids[0]
        server.save_json(self.data/f'{22:032x}'/'session.json', mismatch)
        invalid_time = self.session(23)
        invalid_time['updatedAt'] = float('nan')
        (self.data/invalid_time['id']/'session.json').write_text(json.dumps(invalid_time), encoding='utf-8')
        server.save_json(self.data/'not-a-session'/'session.json', self.session(24))
        ids.append(f'{24:032x}')
        code, result = handler('GET', '/api/sessions')
        self.assertEqual(code, 200)
        self.assertEqual([row['id'] for row in result], list(reversed(ids)))

    def test_windows_junction_or_nested_link_is_rejected_before_any_delete(self):
        session_id = self.session(1)['id']
        original_lstat = Path.lstat
        for unsafe in (self.data/session_id, self.data/session_id/'sources'):
            def fake_lstat(path, *args, **kwargs):
                if path == unsafe:
                    return SimpleNamespace(st_mode=stat.S_IFDIR,
                                           st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
                return original_lstat(path, *args, **kwargs)
            with patch.object(Path, 'lstat', fake_lstat), patch('server.shutil.rmtree') as remove:
                code, result = self.delete([session_id])
            self.assertEqual(code, 200)
            self.assertEqual(result['failed'][0]['id'], session_id)
            remove.assert_not_called()
            self.assertTrue((self.data/session_id/'sources'/'original.png').is_file())

    def test_inflight_score_cannot_resurrect_deleted_record(self):
        record = self.session(1)
        entered, release = threading.Event(), threading.Event()
        output = []
        def slow_score(_):
            entered.set()
            if not release.wait(5):
                raise AssertionError('test score wait timed out')
            return {'test':'scored'}
        with patch('service.score_ledger', side_effect=slow_score):
            thread = threading.Thread(target=lambda: output.append(handler('POST', '/api/score', {'session':copy.deepcopy(record)})))
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.delete([record['id']])[1]['deleted'], [record['id']])
            finally:
                release.set()
                thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(output[0][0], 404, output)
        self.assertFalse((self.data/record['id']).exists())
        self.assertEqual(handler('POST', '/api/score', {'session':record})[0], 404)
        self.assertEqual(handler('GET', '/api/sessions/'+record['id'])[0], 404)

    def test_get_and_delete_share_lock_and_finish_without_partial_reads(self):
        record = self.session(1)
        entered, release, deleting = threading.Event(), threading.Event(), threading.Event()
        reads, deletes = [], []
        def delayed_evidence(session, data_root):
            entered.set()
            if not release.wait(5):
                raise AssertionError('test read wait timed out')
            return session
        def delete():
            deleting.set()
            deletes.append(self.delete([record['id']]))
        with patch('server.ensure_review_evidence', side_effect=delayed_evidence):
            reader = threading.Thread(target=lambda: reads.append(handler('GET', '/api/sessions/'+record['id'])))
            reader.start()
            self.assertTrue(entered.wait(5))
            remover = threading.Thread(target=delete)
            remover.start()
            try:
                self.assertTrue(deleting.wait(5))
                self.assertTrue((self.data/record['id']/'session.json').is_file())
            finally:
                release.set()
                reader.join(5)
                remover.join(5)
        self.assertFalse(reader.is_alive() or remover.is_alive())
        self.assertEqual(reads[0][0], 200)
        self.assertEqual(deletes[0][1]['deleted'], [record['id']])
        self.assertEqual(handler('GET', '/api/sessions')[1], [])


if __name__ == '__main__':
    unittest.main()
