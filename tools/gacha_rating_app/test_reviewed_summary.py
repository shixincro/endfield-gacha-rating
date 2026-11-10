"""Edited character totals must be rechecked without rewriting OCR provenance."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from importer import build_ledger, character_summary_issues, revalidate_ledger_issues
from test_service import handler


def misread_document():
    # Display order is newest first. The second chronological six-star was
    # actually off-banner, but its covered badge made OCR assign the UP again.
    return {
        'file': 'synthetic-covered-badge.png', 'kind': 'character',
        'source_sha256': 'c' * 64, 'identity': {'uid': '12345678'},
        'issues': [], 'overview': {'character': {'N': 20, 'K6': 2, 'off': 1, 'KU': 1}},
        'pools': [{
            'banner': '熔火灼痕', 'total': 20, 'tail': 0, 'tail_known': True,
            'quota': 4720, 'events': [
                {'pulls': 10, 'pity': None, 'character': '莱万汀', 'off': False,
                 'avatar_match': {'character': '艾尔黛拉'}},
                {'pulls': 10, 'pity': None, 'character': '莱万汀', 'off': False},
            ],
            'rush': [], 'rushUsed': False, 'rush_present': False,
            'token_count': 0, 'needs_review': [], 'issues': [],
        }],
    }


def session_for(documents, ledger=None):
    return {'schemaVersion': 'gacha-rating-session-v1', 'revision': 1,
            'documents': copy.deepcopy(documents),
            'ledger': copy.deepcopy(ledger) if ledger is not None else build_ledger(documents),
            'reviewed': False}


def correct_character(session):
    pool = session['ledger']['character']['pools'][0]
    pool['events'][1]['character'] = '艾尔黛拉'
    # UI acknowledges that edited pool's old recognition warnings. Root
    # provenance issues are deliberately not manually removed by this helper.
    pool['issues'] = []
    session['reviewed'] = True


class ReviewedSummaryTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parent / 'test_outputs'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='reviewed-summary-', dir=parent)
        self.patch = patch.object(server, 'DATA', Path(self.temp.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def restore(self, session):
        status, result = handler('POST', '/api/restore', session)
        self.assertEqual(status, 200, result)
        return result

    def score(self, session):
        session['revision'] += 1
        status, result = handler('POST', '/api/score', {'session': session})
        self.assertEqual(status, 200, result)
        return result

    def summaries(self, session):
        return [issue for issue in session['ledger']['issues']
                if issue.get('code') == 'character_summary_mismatch']

    def test_save_corrected_off_count_clears_only_stale_summary(self):
        original = misread_document()
        session = self.restore(session_for([original]))
        self.assertEqual([(i['field'], i['detail'], i['overview']) for i in self.summaries(session)],
                         [('off', 0, 1)])
        self.assertEqual(session['result']['scoredAxes'], 0)
        correct_character(session)
        result = self.score(session)
        self.assertEqual(self.summaries(result), [])
        self.assertEqual(result['result']['scoredAxes'], 4)
        self.assertEqual(result['documents'], [original])
        self.assertEqual(result['ledger']['character']['pools'][0]['events'][1]['character'], '艾尔黛拉')
        persisted = json.loads((server.DATA / result['id'] / 'session.json').read_text(encoding='utf-8'))
        self.assertEqual(persisted['documents'], [original])
        self.assertEqual(self.summaries(persisted), [])

    def test_restoring_already_corrected_export_uses_edited_ledger(self):
        original = misread_document()
        session = session_for([original])
        correct_character(session)
        result = self.restore(session)
        self.assertEqual(self.summaries(result), [])
        self.assertEqual(result['result']['scoredAxes'], 4)
        self.assertEqual(result['documents'], [original])

    def test_corrected_record_stays_correct_after_repeat_save_and_restore(self):
        session = self.restore(session_for([misread_document()]))
        correct_character(session)
        first = self.score(session)
        second = self.score(copy.deepcopy(first))
        restored = self.restore(copy.deepcopy(second))
        self.assertNotEqual(second['id'], restored['id'])
        for result in (first, second, restored):
            self.assertEqual(self.summaries(result), [])
            self.assertEqual(result['result']['scoredAxes'], 4)
        self.assertEqual(first['result']['axes'], restored['result']['axes'])

    def test_clearing_root_issues_without_fix_does_not_bypass_comparison(self):
        session = self.restore(session_for([misread_document()]))
        session['ledger']['issues'] = []
        result = self.score(session)
        self.assertEqual([(i['field'], i['detail']) for i in self.summaries(result)], [('off', 0)])
        self.assertEqual(result['result']['scoredAxes'], 0)

    def test_incorrect_edit_recreates_real_off_count_mismatch(self):
        session = self.restore(session_for([misread_document()]))
        correct_character(session)
        session['ledger']['character']['pools'][0]['events'][0]['character'] = '余烬'
        result = self.score(session)
        self.assertEqual([(i['field'], i['detail'], i['overview']) for i in self.summaries(result)],
                         [('off', 2, 1)])
        self.assertEqual(result['result']['scoredAxes'], 0)

    def test_current_total_not_raw_total_is_compared(self):
        session = self.restore(session_for([misread_document()]))
        correct_character(session)
        pool = session['ledger']['character']['pools'][0]
        pool.update(total=25, tail=5, quota=4820)
        result = self.score(session)
        self.assertEqual([(i['field'], i['detail'], i['overview']) for i in self.summaries(result)],
                         [('N', 25, 20)])

    def test_current_six_count_not_raw_count_is_compared(self):
        session = self.restore(session_for([misread_document()]))
        correct_character(session)
        pool = session['ledger']['character']['pools'][0]
        pool['events'].pop(0)
        pool['quota'] = 2740
        result = self.score(session)
        self.assertEqual([(i['field'], i['detail'], i['overview']) for i in self.summaries(result)],
                         [('K6', 1, 2)])

    def test_corrected_total_can_resolve_original_total_mismatch(self):
        doc = misread_document()
        doc['overview']['character']['N'] = 25
        session = self.restore(session_for([doc]))
        correct_character(session)
        pool = session['ledger']['character']['pools'][0]
        pool.update(total=25, tail=5, quota=4820)
        result = self.score(session)
        self.assertEqual(self.summaries(result), [])
        self.assertEqual(result['result']['scoredAxes'], 4)
        self.assertEqual(result['documents'][0]['pools'][0]['total'], 20)

    def test_score_endpoint_cannot_replace_original_source_document(self):
        doc = misread_document()
        session = self.restore(session_for([doc]))
        session['documents'][0]['overview']['character']['off'] = 0
        session['documents'][0]['identity']['uid'] = 'not-the-original-uid'
        session['ledger']['issues'] = []
        result = self.score(session)
        self.assertEqual(result['documents'], [doc])
        self.assertEqual([(i['field'], i['overview']) for i in self.summaries(result)], [('off', 1)])

    def test_different_account_conflict_remains_after_summary_correction(self):
        first = misread_document()
        second = copy.deepcopy(first)
        second.update(file='other-account.png', source_sha256='d' * 64)
        second['identity']['uid'] = '87654321'
        session = session_for([first, second], build_ledger([first]))
        correct_character(session)
        session['ledger']['issues'] = []
        result = self.restore(session)
        self.assertEqual(self.summaries(result), [])
        self.assertIn('account_mismatch', [i['code'] for i in result['ledger']['issues']])
        self.assertEqual(result['result']['scoredAxes'], 0)

    def test_overlapping_source_conflict_remains_after_summary_correction(self):
        first = misread_document()
        second = copy.deepcopy(first)
        second.update(file='conflicting-overlap.png', source_sha256='e' * 64)
        second['pools'][0]['events'][0].update(character='艾尔黛拉', off=True)
        session = session_for([first, second], build_ledger([first]))
        correct_character(session)
        session['ledger']['issues'] = []
        result = self.restore(session)
        self.assertEqual(self.summaries(result), [])
        self.assertIn('overlapping_pool_conflict', [i['code'] for i in result['ledger']['issues']])
        self.assertEqual(result['result']['scoredAxes'], 0)

    def test_independent_rush_and_token_are_not_main_overview_counts(self):
        doc = misread_document()
        doc['overview']['character'].update(N=240, K6=4, off=0, KU=4)
        pool = doc['pools'][0]
        pool.update(total=240, tail=0, quota=18500, rushUsed=True, rush_present=True,
                    token_count=1)
        pool['events'] = [{'pulls': count, 'pity': None, 'character': '莱万汀', 'off': False}
                          for count in (80, 60, 60, 40)]
        pool['rush'] = [{'pulls': 10, 'pity': None, 'character': '余烬', 'off': True}]
        session = session_for([doc])
        result = self.restore(session)
        self.assertEqual(self.summaries(result), [])
        self.assertEqual(len(result['ledger']['character']['pools'][0]['rush']), 1)
        self.assertEqual(len(result['ledger']['character']['pools'][0]['tokens']), 1)
        self.assertEqual(result['result']['scoredAxes'], 4)
        result = self.score(result)
        self.assertEqual(self.summaries(result), [])

    def test_unknown_identity_does_not_invent_zero_off_count(self):
        doc = misread_document()
        pools = build_ledger([doc])['character']['pools']
        pools[0]['events'][1]['character'] = None
        doc['overview']['character'].update(N=21, K6=3)
        before = copy.deepcopy((doc, pools))
        issues = character_summary_issues([doc], pools)
        self.assertEqual([(i['field'], i['detail']) for i in issues], [('N', 20), ('K6', 2)])
        self.assertEqual((doc, pools), before)

    def test_unknown_total_is_not_zero_but_other_known_fields_are_compared(self):
        doc = misread_document()
        pools = build_ledger([doc])['character']['pools']
        pools[0]['total'] = None
        issues = character_summary_issues([doc], pools)
        self.assertEqual([(i['field'], i['detail']) for i in issues], [('off', 0)])

    def test_empty_edited_pool_list_cannot_clear_nonempty_top_summary(self):
        doc = misread_document()
        ledger = build_ledger([doc])
        ledger['character']['pools'] = []
        issues = revalidate_ledger_issues([doc], ledger)
        self.assertEqual([(i['field'], i['detail']) for i in issues
                          if i['code'] == 'character_summary_mismatch'],
                         [('N', 0), ('K6', 0), ('off', 0)])

    def test_unverified_account_still_blocks_after_counts_match(self):
        first = misread_document()
        second = copy.deepcopy(first)
        second.update(file='missing-uid.png', source_sha256='f' * 64, identity={})
        session = session_for([first, second], build_ledger([first]))
        correct_character(session)
        issues = revalidate_ledger_issues(session['documents'], session['ledger'])
        self.assertIn('account_unverified', [i['code'] for i in issues])
        self.assertNotIn('character_summary_mismatch', [i['code'] for i in issues])

    def test_unknown_identity_still_blocks_identity_axes_after_revalidation(self):
        session = session_for([misread_document()])
        session['ledger']['character']['pools'][0]['events'][1]['character'] = None
        result = self.restore(session)
        self.assertEqual(self.summaries(result), [])
        self.assertIsNone(result['result']['axes']['up']['score'])
        self.assertIsNone(result['result']['axes']['limited']['score'])
        self.assertIsNone(result['ledger']['character']['pools'][0]['events'][1]['character'])


if __name__ == '__main__':
    unittest.main()
