"""Hypothetical draws never overwrite facts or bypass existing guarantees."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from hypothesis import plan_hypothesis, preview_hypothesis
from importer import BANNERS, build_ledger, issue, revalidate_current_ledger
from service import validate_ledger
from test_service import handler


def fixture(total=50, events=None):
    if events is None:
        events = [(20, '艾尔黛拉')]
    raw_events, previous = [], 0
    for at, name in events:
        raw_events.append({'pulls':at-previous, 'character':name, 'off':name!='莱万汀'})
        previous = at
    raw = {'banner':'熔火灼痕', 'total':total, 'tail':total-previous, 'tail_known':True,
           'quota':20*total+1980*len(events)+180*(total//8), 'rushUsed':False, 'rush':[],
           'events':list(reversed(raw_events)), 'token_count':total//240, 'issues':[]}
    doc = {'file':'hypothesis.png', 'source_sha256':'hypothesis-source', 'kind':'character',
           'identity':{'uid':'12345678'}, 'pools':[raw], 'issues':[],
           'overview':{'character':{'N':total, 'K6':len(events), 'off':sum(name!='莱万汀' for _, name in events)}}}
    return [doc], build_ledger([doc])


def manual_pool(index=1):
    banner = list(BANNERS)[index]
    return {'id':f'manual-{index}', 'index':index, 'banner':banner, 'up':BANNERS[banner],
            'total':10, 'tail':0, 'localTail':0, 'initialPity':None, 'quota':2180,
            'events':[{'at':10, 'character':BANNERS[banner], 'source':'main', 'forced':False,
                       'identitySource':'manual'}],
            'rushUsed':False, 'rushAt':None, 'rush':[], 'tokens':[], 'issues':[], 'evidence':{'manual':True}}


class HypothesisTests(unittest.TestCase):
    def setUp(self):
        self.documents, self.ledger = fixture()
        self.pool_id = self.ledger['character']['pools'][0]['id']

    def plan(self, mode='first-up-120'):
        return plan_hypothesis(self.documents, self.ledger, self.pool_id, mode)

    def preview(self, mode='first-up-120', choices=None, five=None):
        return preview_hypothesis(self.documents, self.ledger, self.pool_id, mode,
                                  choices=choices if choices is not None else {'100':'艾尔黛拉'}, additional_five=five)

    def test_120_plan_includes_earlier_80_and_only_allows_off_characters(self):
        plan = self.plan()['plan']
        self.assertEqual((plan['fromTotal'], plan['toTotal'], plan['addedDraws']), (50, 120, 70))
        self.assertEqual([event['at'] for event in plan['events']], [100, 120])
        self.assertNotIn('莱万汀', plan['events'][0]['allowedCharacters'])
        self.assertEqual(plan['events'][1]['character'], '莱万汀')
        self.assertTrue(plan['events'][1]['forced'])
        self.assertEqual((plan['additionalFiveMin'], plan['additionalFiveMax']), (5, 68))

    def test_next_six_before_120_allows_up_without_adding_later_120(self):
        result = self.plan('next-six-80')
        self.assertEqual(result['plan']['toTotal'], 100)
        self.assertEqual(len(result['plan']['events']), 1)
        self.assertIn('莱万汀', result['plan']['events'][0]['allowedCharacters'])
        self.assertFalse(result['plan']['events'][0]['forced'])
        preview = self.preview('next-six-80', {'100':'莱万汀'})
        self.assertEqual(preview['plan']['events'][0]['character'], '莱万汀')
        self.assertEqual(preview['after']['character']['counts']['main'], 100)

    def test_120_arrives_before_next_80_and_forces_up(self):
        self.documents, self.ledger = fixture(100, [(60, '艾尔黛拉')])
        event = self.plan('next-six-80')['plan']['events'][0]
        self.assertEqual((event['at'], event['character'], event['forced']), (120, '莱万汀', True))

    def test_rush_up_does_not_release_main_120_guarantee(self):
        pool = self.ledger['character']['pools'][0]
        pool.update(rushUsed=True, rushAt=30, rush=[{'character':'莱万汀', 'identitySource':'manual'}])
        self.assertFalse(self.plan()['plan']['hasMainUp'])
        self.assertEqual(self.plan()['plan']['events'][-1]['at'], 120)

    def test_existing_main_up_rejects_first_up_mode(self):
        event = self.ledger['character']['pools'][0]['events'][0]
        event.update(character='莱万汀', identitySource='manual')
        with self.assertRaisesRegex(ValueError, '已经获得'):
            self.plan()
        self.assertIsNone(self.plan('next-six-80')['plan']['firstUpDeadline'])

    def test_unknown_water_and_nonlast_pool_are_not_guessed(self):
        pool = self.ledger['character']['pools'][0]
        pool['tail'] = None
        with self.assertRaisesRegex(ValueError, '期末水位'):
            self.plan()
        pool['tail'] = 30
        self.ledger['character']['pools'].append(manual_pool())
        with self.assertRaisesRegex(ValueError, '最后一个'):
            self.plan()

    def test_all_required_choices_and_five_range_are_enforced(self):
        for choices in ({}, {'100':'未知'}, {'100':'莱万汀'}, {'100':'艾尔黛拉','120':'余烬'}, {'1':'余烬'}):
            with self.subTest(choices=choices), self.assertRaises(ValueError):
                self.preview(choices=choices)
        for value in (-1, 0, 4, 69, 1.5, True):
            with self.subTest(five=value), self.assertRaises(ValueError):
                self.preview(five=value)

    def test_default_preview_is_readonly_and_explicitly_does_not_score_five(self):
        before_documents, before_ledger = copy.deepcopy(self.documents), copy.deepcopy(self.ledger)
        with patch('importer._prototype', side_effect=AssertionError('must not OCR')):
            result = self.preview()
        self.assertEqual(self.documents, before_documents)
        self.assertEqual(self.ledger, before_ledger)
        self.assertTrue(result['after']['hypothesis'])
        self.assertEqual(result['after']['axes']['five']['status'], 'unscored')
        self.assertIn('未知', result['after']['axes']['five']['reason'])
        self.assertTrue(all(result['after']['axes'][axis]['score'] is not None for axis in ('characterSix','up','limited')))
        self.assertNotIn('顶部汇总', ' '.join(result['after']['warnings']))

    def test_supplied_five_uses_existing_quota_without_changing_original(self):
        original = self.ledger['character']['pools'][0]['quota']
        result = self.preview(five=5)
        self.assertEqual(result['plan']['additionalQuota'], 20*70+1980*2+180*5)
        self.assertIsNotNone(result['before']['axes']['five']['score'])
        self.assertIsNotNone(result['after']['axes']['five']['score'])
        self.assertEqual(self.ledger['character']['pools'][0]['quota'], original)

    def test_unknown_original_quota_is_not_repaired_by_hypothetical_five(self):
        self.ledger['character']['pools'][0]['quota'] = None
        result = self.preview(five=5)
        self.assertIsNone(result['after']['axes']['five']['score'])
        self.assertIn('原记录', result['after']['axes']['five']['reason'])

    def test_known_zero_quota_can_start_a_hypothesis_without_prior_samples(self):
        self.documents, self.ledger = fixture(0, [])
        plan = self.plan('next-six-80')['plan']
        result = self.preview('next-six-80', {'80':'莱万汀'}, plan['additionalFiveMin'])
        self.assertIsNone(result['before']['axes']['five']['score'])
        self.assertIsNotNone(result['after']['axes']['five']['score'])

    def test_scoped_quota_summary_expands_only_inside_hypothesis(self):
        pool = self.ledger['character']['pools'][0]
        summary = {'scope':'all-pools', 'Q':pool['quota'], 'N':50, 'R':0, 'K6':1}
        self.ledger['character']['quotaSummary'] = summary
        pool['quota'] = None
        result = self.preview(five=5)
        self.assertIsNotNone(result['after']['axes']['five']['score'])
        self.assertEqual(summary['N'], 50)

    def test_true_original_header_and_account_conflicts_survive_preview(self):
        self.documents[0]['overview']['character']['N'] = 49
        result = self.preview()
        for key in ('before', 'after'):
            self.assertIsNone(result[key]['axes']['up']['score'])
            self.assertIn('顶部汇总', result[key]['axes']['up']['reason'])
        self.documents[0]['overview']['character']['N'] = 50
        other = copy.deepcopy(self.documents[0])
        other.update(source_sha256='other-source', identity={'uid':'87654321'})
        self.documents.append(other)
        result = self.preview()
        self.assertIsNone(result['after']['axes']['up']['score'])
        self.assertIn('不同UID', result['after']['axes']['up']['reason'])

    def test_overlapping_source_conflict_is_not_waived_by_hypothesis(self):
        other = copy.deepcopy(self.documents[0])
        other.update(source_sha256='overlap-source', file='overlap.png')
        other['pools'][0]['total'] = 51
        self.documents.append(other)
        result = self.preview()
        self.assertIsNone(result['before']['axes']['up']['score'])
        self.assertIsNone(result['after']['axes']['up']['score'])
        self.assertIn('重叠截图', result['after']['axes']['up']['reason'])

    def test_hypothesis_stop_settles_ongoing_pool_without_editing_it(self):
        pool = self.ledger['character']['pools'][0]
        pool['ended'] = False
        result = self.preview()
        self.assertTrue(result['before']['planning']['pools'][0]['ended'])
        self.assertTrue(result['after']['planning']['pools'][0]['ended'])
        self.assertEqual(result['after']['planning']['pools'][0]['status'], 'ok')
        self.assertIsNotNone(result['after']['planning']['pools'][0]['localLoss'])
        self.assertFalse(pool['ended'])

    def test_crossing_240_adds_hypothetical_token_and_minimum_five(self):
        self.documents, self.ledger = fixture(240, [(50,'莱万汀'), (120,'艾尔黛拉'), (160,'余烬'), (211,'艾尔黛拉')])
        plan = self.plan('next-six-80')['plan']
        self.assertEqual(plan['toTotal'], 291)
        self.assertEqual(plan['additionalFiveMin'], 5)
        self.documents, self.ledger = fixture(230, [(50,'莱万汀'), (120,'艾尔黛拉'), (160,'余烬'), (211,'艾尔黛拉')])
        result = self.preview('next-six-80', {'291':'莱万汀'})
        self.assertIsNotNone(result['after']['planning']['pools'][0]['localLoss'])


class ManualPoolTests(unittest.TestCase):
    def test_missing_whole_pool_fixes_original_header_summary(self):
        documents, ledger = fixture()
        documents[0]['overview']['character'].update(N=60, K6=2)
        before = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertTrue(any(i['code']=='character_summary_mismatch' for i in before['issues']))
        ledger['character']['pools'].append(manual_pool())
        after = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertFalse(any(i['code']=='character_summary_mismatch' for i in after['issues']))
        self.assertEqual(documents[0]['overview']['character']['N'], 60)

    def test_completed_manual_coverage_removes_stale_history_warning_only_without_gaps(self):
        documents, ledger = fixture()
        ledger['character']['issues'] = [issue('incomplete_history', '原缺池范围', 'warning')]
        ledger['character']['pools'].append(manual_pool())
        ledger['character'].update(completeHistory=True, historyEvidence='manual-banner-coverage')
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertFalse(any(i['code']=='incomplete_history' for i in checked['character']['issues']))
        ledger['character']['pools'][1] = manual_pool(3)
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertTrue(any(i['code']=='incomplete_history' for i in checked['character']['issues']))

    def test_manual_pool_can_validate_without_raw_ocr_and_preserves_unknown_history(self):
        documents, ledger = fixture()
        pool = manual_pool(3)
        ledger['character'].update(pools=[pool], completeHistory=False, initialPity=None, initialOwned=None)
        ledger['issues'] = [issue('event_needs_review', '旧汇总审核', 'error')]
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertFalse(any(i['code']=='event_needs_review' for i in checked['issues']))
        self.assertEqual(checked['character']['pools'][0]['issues'], [])
        self.assertFalse(checked['character']['completeHistory'])
        self.assertIsNone(checked['character']['initialPity'])
        self.assertIsNone(checked['character']['initialOwned'])

    def test_duplicate_banner_index_and_id_are_rejected(self):
        _, ledger = fixture()
        original = ledger['character']['pools'][0]
        for key in ('id', 'index', 'banner'):
            extra = manual_pool()
            extra[key] = original[key]
            candidate = copy.deepcopy(ledger)
            candidate['character']['pools'].append(extra)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, '重复'):
                validate_ledger(candidate)

    def test_manual_pool_invalid_position_can_be_repaired_without_missing_source_error(self):
        documents, ledger = fixture()
        added = manual_pool()
        added['events'][0]['at'] = None
        ledger['character']['pools'].append(added)
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        repaired = checked['character']['pools'][1]
        self.assertTrue(any(i['code']=='event_needs_review' for i in repaired['issues']))
        repaired['events'][0]['at'] = 10
        checked = revalidate_current_ledger(documents, checked, reviewed=True)
        self.assertFalse(any(i['code']=='event_needs_review' for i in checked['character']['pools'][1]['issues']))


class HypothesisEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hypothesis-', dir=Path(__file__).resolve().parent/'test_outputs')
        self.data_patch = patch.object(server, 'DATA', Path(self.temp.name))
        self.data_patch.start()
        documents, ledger = fixture()
        self.session = {'id':'b'*32, 'schemaVersion':'gacha-rating-session-v1', 'revision':7,
                        'updatedAt':1, 'recognitionVersion':'test-before', 'documents':documents,
                        'ledger':ledger, 'result':{'original':True}, 'reviewed':True}
        self.saved = server.DATA/self.session['id']/'session.json'
        server.save_json(self.saved, self.session)
        self.request = {'session':self.session, 'poolId':ledger['character']['pools'][0]['id'],
                        'mode':'first-up-120', 'choices':{'100':'艾尔黛拉'}, 'additionalFive':None}

    def tearDown(self):
        self.data_patch.stop()
        self.temp.cleanup()

    def test_plan_does_not_score_and_preview_does_not_write_or_trust_client_documents(self):
        before = self.saved.read_bytes()
        self.session['documents'][0]['overview']['character']['N'] = 999
        with patch('hypothesis.score_ledger', side_effect=AssertionError('plan must not score')):
            code, plan = handler('POST', '/api/hypothesis/plan', self.request)
        self.assertEqual(code, 200, plan)
        with patch('server.save_json', side_effect=AssertionError('must not save')), \
             patch('importer._prototype', side_effect=AssertionError('must not OCR')):
            code, result = handler('POST', '/api/hypothesis/preview', self.request)
        self.assertEqual(code, 200, result)
        self.assertIsNotNone(result['after']['axes']['up']['score'])
        self.assertEqual(self.saved.read_bytes(), before)
        self.assertEqual(self.session['revision'], 7)
        self.assertEqual(self.session['recognitionVersion'], 'test-before')

    def test_hypothesis_markers_cannot_be_saved_or_restored_as_real_records(self):
        for location in ('root', 'event'):
            candidate = copy.deepcopy(self.session)
            if location == 'root':
                candidate['ledger']['hypothesis'] = {'persistable':False}
            else:
                candidate['ledger']['character']['pools'][0]['events'][0]['identitySource'] = 'manual-hypothesis'
            with self.subTest(location=location):
                self.assertEqual(handler('POST', '/api/score', {'session':candidate})[0], 400)
                self.assertEqual(handler('POST', '/api/restore', candidate)[0], 400)

    def test_auth_deleted_record_and_missing_choice_fail_explicitly(self):
        self.assertEqual(handler('POST', '/api/hypothesis/plan', self.request, {'X-App-Token':''})[0], 403)
        self.request['choices'] = {}
        self.assertEqual(handler('POST', '/api/hypothesis/preview', self.request)[0], 400)
        self.saved.unlink()
        self.assertEqual(handler('POST', '/api/hypothesis/plan', self.request)[0], 404)


if __name__ == '__main__':
    unittest.main()
