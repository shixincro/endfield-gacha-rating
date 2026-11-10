"""Exercise remembered extensions through the editor model and saved-record API."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import server
from importer import RECOGNITION_VERSION, build_ledger, revalidate_current_ledger
from service import score_ledger, validate_ledger
from test_service import document, handler

APP = Path(__file__).resolve().parent


def append(character, **settings):
    code = ("const fs=require('node:fs'); const {appendRecord}=require('./static/manual-supplement');"
            "const [record,input]=JSON.parse(fs.readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(appendRecord(record,input)));")
    result = subprocess.run([shutil.which('node'), '-e', code], cwd=APP,
                            input=json.dumps([character, settings], ensure_ascii=False),
                            capture_output=True, encoding='utf-8', timeout=10, check=True)
    return json.loads(result.stdout)


class ManualSupplementTests(unittest.TestCase):
    def setUp(self):
        self.docs = [document()]
        self.docs[0]['overview'] = {'character': {'N': 10, 'K6': 1, 'off': 0}}
        self.ledger = build_ledger(self.docs)
        self.ledger['weapon'] = {'N': 60, 'K6': 2, 'KU': 1, 'issues': []}

    def test_legacy_water_source_is_recovered_without_changing_values_or_documents(self):
        pool = self.ledger['character']['pools'][0]
        self.assertEqual(pool.pop('initialPitySource'), 'record-derived')
        before, documents = copy.deepcopy(self.ledger), copy.deepcopy(self.docs)
        with patch('importer._prototype', side_effect=AssertionError('must not reread images')):
            checked = revalidate_current_ledger(self.docs, self.ledger)
        restored = checked['character']['pools'][0]
        self.assertEqual(restored['initialPitySource'], 'record-derived')
        self.assertEqual(restored['initialPity'], pool['initialPity'])
        self.assertEqual(restored['tail'], pool['tail'])
        self.assertEqual(self.ledger, before)
        self.assertEqual(self.docs, documents)
        self.assertEqual(revalidate_current_ledger(self.docs, checked), checked)

    def test_water_source_migration_preserves_manual_changed_unknown_and_unbound_values(self):
        for source, value, manual_pool in [('manual', 0, False), ('external', 0, False),
                                            (None, 5, False), (None, None, False), (None, 0, True)]:
            with self.subTest(source=source, value=value, manual_pool=manual_pool):
                ledger = copy.deepcopy(self.ledger)
                pool = ledger['character']['pools'][0]
                pool.pop('initialPitySource')
                if source is not None:
                    pool['initialPitySource'] = source
                pool['initialPity'] = value
                if manual_pool:
                    pool['evidence'] = {'manual': True}
                checked = revalidate_current_ledger(self.docs, ledger)['character']['pools'][0]
                self.assertEqual(checked.get('initialPitySource'), source)
                self.assertEqual(checked['initialPity'], value)

    def test_inserting_missing_pools_recalculates_source_water_through_save_reopen_restore(self):
        docs = [document()]
        first = docs[0]['pools'][0]
        first.update(total=15, tail=5, tail_known=True, quota=2460, rushUsed=False)
        last = copy.deepcopy(first)
        last.update(banner='河流的女儿', total=50, tail=5, quota=3880)
        last['events'] = [{'pulls':45, 'pity':5, 'character':'汤汤', 'off':False}]
        docs[0]['pools'].append(last)
        docs[0]['overview'] = {'character': {'N':65, 'K6':2, 'off':0}}
        original_documents = copy.deepcopy(docs)
        ledger = build_ledger(docs)
        ledger['weapon'] = copy.deepcopy(self.ledger['weapon'])
        ledger['character']['completeHistory'] = False
        ledger['character'].pop('historyEvidence', None)
        # Simulate a saved pre-fix record. Its screenshot still says 已垫5抽.
        for pool in ledger['character']['pools']:
            pool.pop('initialPitySource')
        ledger = revalidate_current_ledger(docs, ledger)
        ledger['character'] = append(ledger['character'], index=1, draws=10, five=1)
        self.assertEqual(ledger['character']['pools'][-1]['initialPity'], 5)
        ledger['character'] = append(ledger['character'], index=2, draws=10, five=1)
        downstream = ledger['character']['pools'][-1]
        self.assertEqual(downstream['initialPity'], 25)
        self.assertEqual(downstream['events'][0]['evidence']['inheritedPityLabel'], 5)
        with tempfile.TemporaryDirectory(dir=APP) as folder, patch.object(server, 'DATA', Path(folder)):
            session = {'id':'e'*32, 'revision':2, 'schemaVersion':'gacha-rating-session-v1',
                       'updatedAt':1, 'ledger':ledger, 'documents':docs}
            server.save_json(server.DATA/session['id']/'session.json', session)
            session['revision'] += 1
            code, saved = handler('POST', '/api/score', {'session':session, 'expectedRevision':2})
            self.assertEqual(code, 200, saved)
            self.assertEqual(saved['recognitionVersion'], RECOGNITION_VERSION)
            self.assertEqual(saved['result']['scoredAxes'], 6)
            self.assertEqual(saved['result']['character']['counts']['main'], 85)
            self.assertFalse(any(i.get('severity') == 'error'
                                 for p in saved['ledger']['character']['pools'] for i in p['issues']))
            code, opened = handler('GET', '/api/sessions/'+session['id'])
            self.assertEqual(code, 200)
            code, restored = handler('POST', '/api/restore', opened)
            self.assertEqual(code, 200, restored)
            self.assertEqual(restored['ledger'], saved['ledger'])
            self.assertEqual(restored['result']['scoredAxes'], 6)
            self.assertEqual(restored['documents'], original_documents)

    def test_only_image_prefix_counts_towards_header_with_rush_or_without(self):
        self.ledger['character'] = append(self.ledger['character'], index=0, draws=20,
                                          main=[{'offset':15, 'character':'余烬'}],
                                          rushMode='hits', rushAt=30, rush=['伊冯'], five=4)
        data = revalidate_current_ledger(self.docs, self.ledger)
        self.assertFalse(any(i['code']=='character_summary_mismatch' for i in data['issues']))
        result = score_ledger(data)
        self.assertEqual(result['scoredAxes'],6)
        counts = result['character']['counts']
        self.assertEqual((counts['main'],counts['total'],counts['six'],counts['five']),(30,40,3,5))
        # A real inconsistency in the original (covered) six-star identity persists.
        self.ledger['character']['pools'][0]['events'][0]['character'] = '别礼'
        invalid = revalidate_current_ledger(self.docs, self.ledger)
        fields = [i['field'] for i in invalid['issues'] if i['code']=='character_summary_mismatch']
        self.assertEqual(fields,['off'])

    def test_unknown_five_is_optional_and_nonblocking_for_other_axes(self):
        self.ledger['character'] = append(self.ledger['character'], index=1, draws=10, five=None)
        current = revalidate_current_ledger(self.docs,self.ledger)
        self.assertEqual(current['character']['pools'][1]['manualSupplementDraws'],10)
        self.assertFalse(any(i.get('severity')=='error' for p in current['character']['pools'] for i in p['issues']))
        self.assertFalse(any(i['code']=='character_summary_mismatch' for i in current['issues']))
        result = score_ledger(current)
        self.assertIsNone(result['axes']['five']['score'])
        self.assertEqual(result['scoredAxes'],5)

    def test_cross_account_sources_still_block_after_adding_draws(self):
        self.docs.append({**copy.deepcopy(self.docs[0]), 'source_sha256':'b'*64, 'identity': {'uid':'87654321'}})
        self.ledger['character'] = append(self.ledger['character'], index=0, draws=5, five=1)
        checked = revalidate_current_ledger(self.docs,self.ledger)
        self.assertTrue(any(i['severity']=='error' for i in checked['issues']))
        self.assertEqual(score_ledger(checked)['scoredAxes'],0)

    def test_aggregate_only_quota_can_be_completed_after_an_unknown_extension(self):
        c = self.ledger['character']
        c['pools'][0]['quota'] = None
        c['quotaSummary'] = {'scope':'all-pools', 'N':10, 'R':0, 'K6':1, 'Q':2360}
        c = self.ledger['character'] = append(c,index=1,draws=10,five=None)
        checked = revalidate_current_ledger(self.docs,self.ledger)
        self.assertFalse(any(i.get('severity')=='error' for p in checked['character']['pools'] for i in p['issues']))
        self.assertEqual(score_ledger(checked)['scoredAxes'],5)
        c['quotaSummary'] = {'scope':'all-pools', 'N':20, 'R':0, 'K6':1, 'Q':2740}
        result = score_ledger(revalidate_current_ledger(self.docs,self.ledger))
        self.assertEqual(result['scoredAxes'],6)
        self.assertEqual(result['character']['counts']['five'],2)

    def test_invalid_external_range_is_rejected(self):
        for value in (-1, 1.5, True, 11, '5'):
            self.ledger['character']['pools'][0]['manualSupplementDraws'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError,'手动补充'):
                validate_ledger(self.ledger)

    def test_persist_reopen_restore_retry_and_stale_client(self):
        with tempfile.TemporaryDirectory(dir=APP) as folder, patch.object(server, 'DATA', Path(folder)):
            good = {'id':'d'*32, 'revision':2, 'schemaVersion':'gacha-rating-session-v1',
                    'updatedAt':1, 'ledger':self.ledger, 'documents':self.docs}
            path = server.DATA/good['id']/'session.json'
            server.save_json(path,good)
            before = path.read_bytes()
            good['ledger']['character'] = append(good['ledger']['character'],index=0,draws=10,five=1)
            good['revision'] += 1
            self.assertEqual(handler('POST','/api/validate',{'session':good})[0],200)
            self.assertEqual(path.read_bytes(),before)
            code,saved = handler('POST','/api/score',{'session':good,'expectedRevision':2})
            self.assertEqual(code,200,saved)
            self.assertEqual(saved['result']['character']['counts']['main'],20)
            after = path.read_bytes()
            self.assertEqual(handler('POST','/api/score',{'session':good,'expectedRevision':2})[0],409)
            self.assertEqual(path.read_bytes(),after)
            code,opened = handler('GET','/api/sessions/'+good['id'])
            self.assertEqual(code,200)
            code,restored = handler('POST','/api/restore',opened)
            self.assertEqual(code,200,restored)
            self.assertEqual(restored['ledger'],saved['ledger'])
            self.assertEqual(restored['result']['character']['counts']['main'],20)
            self.assertEqual(restored['documents'],self.docs)


if __name__ == '__main__':
    unittest.main()
