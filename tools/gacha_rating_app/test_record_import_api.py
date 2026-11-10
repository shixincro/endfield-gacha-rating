"""Text export HTTP boundary and persistence, using synthetic records only."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server
from importer import build_ledger
from test_service import document, handler


class RecordImportApiTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parent/'test_outputs'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='text-import-', dir=parent)
        self.data = Path(self.temp.name)/'data'
        self.data.mkdir()
        self.data_patch = patch.object(server, 'DATA', self.data)
        self.data_patch.start()
        self.source = {'schemaVersion':'gacha-rating-session-v1', 'id':'f'*32, 'revision':99,
                       'documents':[document()], 'ledger':build_ledger([document()]), 'reviewed':False}

    def tearDown(self):
        self.data_patch.stop()
        self.temp.cleanup()

    def post(self, value, headers=None):
        return handler('POST', '/api/records/import', value, headers)

    def test_import_saves_a_new_scored_record_without_ocr(self):
        original = self.data/('e'*32)/'session.json'
        server.save_json(original, {'untouched':True})
        before = original.read_bytes()
        with patch('record_import.import_record_text', return_value=copy.deepcopy(self.source)) as convert:
            code, result = self.post({'name':'../../synthetic.TXT', 'text':'synthetic source'})
        self.assertEqual(code, 200, result)
        convert.assert_called_once_with('synthetic source', 'synthetic.TXT')
        self.assertNotEqual(result['id'], self.source['id'])
        self.assertEqual(result['revision'], 1)
        self.assertEqual(result['result']['scoredAxes'], 4)
        saved = json.loads((self.data/result['id']/'session.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['ledger'], result['ledger'])
        self.assertEqual(original.read_bytes(), before)

    def test_conversion_failure_never_creates_a_history_item(self):
        with patch('record_import.import_record_text', side_effect=ValueError('格式无法识别')):
            code, result = self.post({'name':'broken.json', 'text':'{}'})
        self.assertEqual(code, 400)
        self.assertIn('格式无法识别', result['error'])
        self.assertEqual(list(self.data.iterdir()), [])

    def test_new_formats_return_the_contact_author_error_code_without_saving(self):
        for name,text in (('new.json','{"future_records":[]}'),('new.txt','unsupported record layout'),('array.json','[]')):
            with self.subTest(name=name):
                code,result=self.post({'name':name,'text':text})
                self.assertEqual(code,400)
                self.assertEqual(result.get('code'),'record_format_unrecognized')
                self.assertIn('联系作者协助适配',result['error'])
                self.assertEqual(list(self.data.iterdir()),[])

    def test_damaged_or_invalid_records_are_not_misreported_as_new_formats(self):
        for text in ('{"broken":','', '{"code":1,"data":{"list":[]}}'):
            with self.subTest(text=text):
                code,result=self.post({'name':'broken.json','text':text})
                self.assertEqual(code,400)
                self.assertNotIn('code',result)
                self.assertEqual(list(self.data.iterdir()),[])

    def test_real_reward_gap_conversion_survives_scoring_and_save(self):
        rows=[{'seqId':str(seq),'gachaTs':str(seq),'poolId':'synthetic-limited',
               'poolName':'熔火灼痕','charName':'莱万汀' if seq==40 else '四星角色',
               'rarity':6 if seq==40 else 4,'isFree':False}
              for seq in [*range(1,61),62]]
        text=json.dumps({'code':0,'data':{'list':rows,'hasMore':False}},ensure_ascii=False)
        code,result=self.post({'name':'synthetic.json','text':text})
        self.assertEqual(code,200,result)
        self.assertEqual(result['ledger']['character']['pools'][0]['total'],61)
        self.assertEqual(result['result']['scoredAxes'],4)
        gap=result['documents'][0]['sourceSequenceGaps'][0]
        self.assertEqual(gap['classification'],'omitted-reward-slot-at-confirmed-node')
        saved=json.loads((self.data/result['id']/'session.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['documents'][0]['sourceSequenceGaps'][0],gap)

    def test_only_same_source_reuses_explicit_pool_opening_confirmations(self):
        text = '{"synthetic":true}'
        prior = copy.deepcopy(self.source)
        prior['documents'][0].update(source_sha256=hashlib.sha256(text.encode()).hexdigest(),
                                    userConfirmations={'fullPoolHistories':['春雷动，万物生','行舟申领']})
        server.save_json(self.data/('e'*32)/'session.json', prior)
        self.assertEqual(server.confirmed_pool_histories(text), {'春雷动，万物生','行舟申领'})
        self.assertEqual(server.confirmed_pool_histories(text+' '), set())
        with patch('record_import.import_record_text', return_value=copy.deepcopy(self.source)) as convert:
            code, _ = self.post({'name':'synthetic.json', 'text':text})
        self.assertEqual(code, 200)
        self.assertEqual(convert.call_args.kwargs['confirmed_complete_pools'], {'春雷动，万物生','行舟申领'})

    def test_invalid_file_payloads_are_rejected_before_conversion(self):
        for value in ({'name':'record.exe','text':'{}'}, {'name':'record.txt','text':{}},
                      {'name':'record.txt','text':'\ufeff\n'}, {'name':None,'text':'abc'}, []):
            with self.subTest(value=value):
                with patch('record_import.import_record_text') as convert:
                    code, _ = self.post(value)
                self.assertEqual(code, 400)
                convert.assert_not_called()

    def test_file_limit_is_measured_in_utf8_bytes(self):
        with patch.object(server, 'MAX_RECORD_TEXT', 8):
            code, result = self.post({'name':'record.txt','text':'一二三'})
        self.assertEqual(code, 400)
        self.assertIn('8 MB', result['error'])

    def test_failed_score_does_not_persist_partial_record(self):
        with patch('record_import.import_record_text', return_value=copy.deepcopy(self.source)), \
             patch('service.score_session_result', side_effect=ValueError('测试评分失败')):
            code, _ = self.post({'name':'sample.json','text':'{}'})
        self.assertEqual(code, 400)
        self.assertEqual(list(self.data.iterdir()), [])

    def test_mutation_requires_the_local_app_token(self):
        code, _ = self.post({'name':'sample.json','text':'{}'}, {'X-App-Token':'wrong'})
        self.assertEqual(code, 403)
        self.assertEqual(list(self.data.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
