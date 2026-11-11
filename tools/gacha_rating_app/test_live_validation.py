"""Draft validation shares save checks without OCR, scoring, or persistence."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from importer import build_ledger, issue, revalidate_current_ledger
from test_service import document, handler


def codes(record):
    return {item['code'] for item in record.get('issues', [])}


class CurrentLedgerTests(unittest.TestCase):
    def setUp(self):
        self.documents = [document()]
        self.ledger = build_ledger(self.documents)

    def check(self):
        return revalidate_current_ledger(self.documents, self.ledger, reviewed=True)

    def test_fixed_legacy_warnings_disappear_without_touching_inputs(self):
        pool = self.ledger['character']['pools'][0]
        stale = ('missing_total', 'quota_missing', 'quota_ocr_conflict', 'event_interval_missing',
                 'character_identity_missing', 'local_tail_conflict', 'tail_pity_out_of_range',
                 'six_wait_exceeds_80', 'missing_120_up', 'rush_usage_unknown')
        pool['issues'] = [issue(code, '旧错误', 'warning', originalSeverity='error',
                                resolution='saved-edited-record') for code in stale]
        before, evidence = copy.deepcopy(self.ledger), copy.deepcopy(self.documents)
        checked = self.check()
        self.assertEqual(checked['character']['pools'][0]['issues'], [])
        self.assertEqual(self.ledger, before)
        self.assertEqual(self.documents, evidence)
        self.assertIsNot(checked, self.ledger)

    def test_each_current_edit_recreates_then_removes_its_error(self):
        pool = self.ledger['character']['pools'][0]
        cases = [('quota', None, 'quota_missing'), ('rushUsed', None, 'rush_usage_unknown'),
                 ('tail', 4, 'local_tail_conflict'), ('initialPity', 79, 'six_wait_exceeds_80')]
        for field, value, code in cases:
            with self.subTest(field=field):
                original = pool[field]
                pool[field] = value
                self.assertIn(code, codes(self.check()['character']['pools'][0]))
                pool[field] = original
                self.assertNotIn(code, codes(self.check()['character']['pools'][0]))
        pool['events'][0]['at'] = None
        self.assertIn('event_interval_missing', codes(self.check()['character']['pools'][0]))
        pool['events'][0]['at'] = 10
        self.assertNotIn('event_interval_missing', codes(self.check()['character']['pools'][0]))

    def test_120_rule_and_fixed_tokens_follow_current_rows(self):
        pool = self.ledger['character']['pools'][0]
        pool.update(total=240, tail=0, rushUsed=False, tokens=[])
        pool['events'] = [{'at':at, 'character':'艾尔黛拉', 'source':'main', 'identitySource':'manual'}
                          for at in (60, 120, 180, 240)]
        invalid = self.check()['character']['pools'][0]
        self.assertIn('missing_120_up', codes(invalid))
        self.assertIn('token_position_unknown', codes(invalid))
        pool['events'][1]['character'] = '莱万汀'
        pool['tokens'] = [{'at':240, 'source':'token'}]
        valid = self.check()['character']['pools'][0]
        self.assertNotIn('missing_120_up', codes(valid))
        self.assertNotIn('token_position_unknown', codes(valid))

    def test_unknown_source_conflicts_cannot_be_cleared_or_blanket_acknowledged(self):
        source_issue = issue('unrecognized_image_detail', '需要查看原始证据', 'error')
        self.documents[0]['pools'][0]['issues'] = [source_issue]
        pool = self.ledger['character']['pools'][0]
        pool['issues'] = [dict(source_issue, severity='warning', originalSeverity='error',
                              reviewed=True, resolution='saved-edited-record')]
        current = self.check()['character']['pools'][0]
        self.assertEqual(current['issues'][0]['severity'], 'error')
        pool['issues'] = []
        self.assertIn('unrecognized_image_detail', codes(self.check()['character']['pools'][0]))
        other = copy.deepcopy(self.documents[0])
        other.update(source_sha256='b'*64, identity={'uid':'87654321'})
        self.documents.append(other)
        self.assertIn('account_mismatch', codes(self.check()))

    def test_placeholder_requires_existing_explicit_row_confirmation(self):
        pool = self.ledger['character']['pools'][0]
        pending = issue('placeholder_needs_review', '占位识别不明', 'error')
        self.documents[0]['pools'][0]['issues'] = [pending]
        self.assertIn('placeholder_needs_review', codes(self.check()['character']['pools'][0]))
        pool['eventReviewConfirmed'] = True
        self.assertIn('placeholder_needs_review', codes(self.check()['character']['pools'][0]))
        pool['events'][0]['identityReviewed'] = True
        checked = self.check()
        self.assertNotIn('placeholder_needs_review', codes(checked['character']['pools'][0]))
        again = revalidate_current_ledger(self.documents, checked, reviewed=True)
        self.assertEqual(again, checked)

    def test_zero_hit_placeholder_requires_explicit_pool_confirmation(self):
        raw = self.documents[0]['pools'][0]
        raw.update(total=30, tail=30, events=[], rush=[], rush_present=True,
                   rushUsed=True, rushAt=30, needs_review=['placeholder_needs_review'],
                   issues=[issue('placeholder_needs_review', '占位识别不明', 'error')])
        self.ledger = build_ledger(self.documents)
        pool = self.ledger['character']['pools'][0]
        pool['initialPity'] = 0
        self.assertIn('placeholder_needs_review', codes(self.check()['character']['pools'][0]))
        pool['quota'] += 1
        self.assertIn('placeholder_needs_review', codes(self.check()['character']['pools'][0]))
        pool['eventReviewConfirmed'] = True
        before, evidence = copy.deepcopy(self.ledger), copy.deepcopy(self.documents)
        with patch('importer._prototype', side_effect=AssertionError('must not OCR')):
            checked = self.check()
        self.assertEqual(checked['character']['pools'][0]['issues'], [])
        self.assertEqual(checked['character']['pools'][0]['events'], [])
        self.assertEqual(checked['character']['pools'][0]['rush'], [])
        self.assertEqual(self.ledger, before)
        self.assertEqual(self.documents, evidence)
        self.assertEqual(revalidate_current_ledger(self.documents, checked, reviewed=True), checked)

    def test_confirmed_zero_hit_placeholder_does_not_hide_other_errors(self):
        raw = self.documents[0]['pools'][0]
        raw.update(total=30, tail=30, events=[], rush=[], rush_present=True,
                   rushUsed=True, rushAt=30,
                   issues=[issue('placeholder_needs_review', '占位识别不明', 'error'),
                           issue('unrecognized_image_detail', '原图其他疑点', 'error')])
        self.ledger = build_ledger(self.documents)
        pool = self.ledger['character']['pools'][0]
        pool.update(eventReviewConfirmed=True, initialPity=0, tail=29)
        checked = self.check()['character']['pools'][0]
        self.assertNotIn('placeholder_needs_review', codes(checked))
        self.assertIn('unrecognized_image_detail', codes(checked))
        self.assertIn('local_tail_conflict', codes(checked))

    def test_legacy_generated_event_diagnostics_do_not_become_opaque(self):
        event = self.ledger['character']['pools'][0]['events'][0]
        event['needsReview'] = '累计出货位置缺失或无效'
        event['reviewDiagnosticsVersion'] = 'avatar-review-migration-v3-20261023'
        self.assertNotIn('event_needs_review', codes(self.check()['character']['pools'][0]))

    def test_weapon_missing_and_count_errors_resolve_but_source_conflicts_remain(self):
        self.ledger['weapon'] = {'N':60, 'K6':2, 'KU':None, 'issues':[
            issue('weapon_field_missing', '原专武数未识别', 'warning', originalSeverity='error',
                  resolution='saved-edited-record', field='KU'),
            issue('weapon_summary_conflict', '截图来源冲突', 'error')]}
        self.assertIn('weapon_field_missing', codes(self.check()['weapon']))
        self.ledger['weapon']['KU'] = 3
        self.assertIn('weapon_count_invalid', codes(self.check()['weapon']))
        self.ledger['weapon']['KU'] = 1
        self.assertEqual(codes(self.check()['weapon']), {'weapon_summary_conflict'})

    def test_profile_syntax_checked_without_running_probability_model(self):
        self.ledger['weapon'] = {'N':10000, 'K6':100, 'KU':40, 'profile':'11 5*7', 'issues':[]}
        with patch('weapon_scoring.score_weapon_profile', side_effect=AssertionError('must not score')):
            self.assertNotIn('weapon_profile_invalid', codes(self.check()['weapon']))
            self.ledger['weapon']['profile'] = '11 5*'
            self.assertIn('weapon_profile_invalid', codes(self.check()['weapon']))

    def test_profile_counts_checked_without_running_probability_model(self):
        self.ledger['weapon'] = {'N':100, 'K6':5, 'KU':2, 'profile':'1', 'issues':[]}
        with patch('weapon_scoring.score_weapon_profile', side_effect=AssertionError('must not score')):
            self.assertIn('weapon_profile_invalid', codes(self.check()['weapon']))
            self.ledger['weapon']['profile'] = '3'
            self.assertIn('weapon_profile_invalid', codes(self.check()['weapon']))
            self.ledger['weapon']['profile'] = '2 1'
            self.assertIn('weapon_profile_invalid', codes(self.check()['weapon']))
            self.ledger['weapon']['profile'] = '2'
            self.assertNotIn('weapon_profile_invalid', codes(self.check()['weapon']))


class ValidateEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='validation-test-', dir=Path(__file__).resolve().parent)
        self.data_patch = patch.object(server, 'DATA', Path(self.temp.name))
        self.data_patch.start()
        self.session = {'id':'a'*32, 'schemaVersion':'gacha-rating-session-v1', 'revision':3,
                        'recognitionVersion':'old', 'updatedAt':1, 'reviewed':True,
                        'documents':[document()], 'ledger':build_ledger([document()]),
                        'result':{'unchanged':True}}
        self.saved = server.DATA/self.session['id']/'session.json'
        server.save_json(self.saved, self.session)

    def tearDown(self):
        self.data_patch.stop()
        self.temp.cleanup()

    def test_preview_is_readonly_uses_saved_evidence_and_matches_save(self):
        self.session['ledger']['character']['pools'][0]['quota'] = None
        self.session['documents'][0]['identity']['uid'] = 'forged'
        before = self.saved.read_bytes()
        incoming = copy.deepcopy(self.session)
        with patch('service.score_ledger', side_effect=AssertionError('must not score')), \
             patch('importer._prototype', side_effect=AssertionError('must not OCR')), \
             patch('server.save_json', side_effect=AssertionError('must not save')):
            code, preview = handler('POST', '/api/validate', {'session':self.session})
        self.assertEqual(code, 200, preview)
        self.assertEqual(set(preview), {'ledger'})
        self.assertEqual(preview['ledger']['identity']['uid'], '12345678')
        self.assertEqual(self.saved.read_bytes(), before)
        self.assertEqual(self.session, incoming)
        self.assertIn('quota_missing', codes(preview['ledger']['character']['pools'][0]))
        with patch('service.score_ledger', return_value={'test':'saved'}):
            status, saved = handler('POST', '/api/score', {'session':self.session})
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved['ledger'], preview['ledger'])
        self.assertEqual(saved['revision'], 3)

    def test_invalid_schema_returns_explicit_failure_without_writing(self):
        self.session['ledger']['character']['pools'][0]['total'] = -1
        before = self.saved.read_bytes()
        code, response = handler('POST', '/api/validate', {'session':self.session})
        self.assertEqual(code, 400)
        self.assertIn('单池抽数', response['error'])
        self.assertTrue(response['error'])
        self.assertEqual(self.saved.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
