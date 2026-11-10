"""Explicit manual corrections never rewrite evidence or waive source conflicts."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from importer import build_ledger, revalidate_ledger_issues
from service import validate_ledger
from test_reviewed_summary import misread_document, session_for, correct_character
from test_service import handler


def choice(doc, mode='override', **values):
    return {'source_sha256': doc.get('source_sha256'), 'file': doc.get('file'),
            'mode': mode, **values}


class ManualInputContractTests(unittest.TestCase):
    def setUp(self):
        self.doc = misread_document()
        self.ledger = build_ledger([self.doc])

    def summary(self):
        validate_ledger(self.ledger)
        return [i for i in revalidate_ledger_issues([self.doc], self.ledger)
                if i['code'] == 'character_summary_mismatch']

    def test_default_remains_strict(self):
        self.assertEqual([(i['field'], i['severity']) for i in self.summary()], [('off', 'error')])

    def test_correcting_top_ocr_value_keeps_original_immutable(self):
        before = copy.deepcopy(self.doc)
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, off=0)]
        self.assertEqual(self.summary(), [])
        self.assertEqual(self.doc, before)

    def test_wrong_manual_header_still_blocks_and_preserves_both_values(self):
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, off=2)]
        issue = self.summary()[0]
        self.assertEqual((issue['severity'], issue['overview'], issue['originalOverview']), ('error', 2, 1))
        self.assertEqual(issue['summaryMode'], 'override')

    def test_missing_override_key_uses_original_but_null_skips_that_field(self):
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, N=20)]
        self.assertEqual([i['field'] for i in self.summary()], ['off'])
        self.ledger['character']['summaryOverrides'][0]['off'] = None
        self.assertEqual(self.summary(), [])

    def test_details_mode_keeps_nonblocking_discrepancy(self):
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, mode='details')]
        issue = self.summary()[0]
        self.assertEqual(issue['severity'], 'warning')
        self.assertEqual(issue['resolution'], 'manual-details-authoritative')
        self.assertIn('逐条明细', issue['message'])

    def test_hash_cannot_fall_back_to_matching_filename(self):
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, off=0)]
        self.ledger['character']['summaryOverrides'][0]['source_sha256'] = 'wrong-hash'
        with self.assertRaisesRegex(ValueError, '未关联'):
            self.summary()

    def test_hashless_document_can_use_filename(self):
        self.doc.pop('source_sha256')
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, off=0)]
        self.assertEqual(self.summary(), [])

    def test_other_document_is_still_strict(self):
        second = copy.deepcopy(self.doc)
        second.update(source_sha256='other', file='other.png')
        self.ledger['character']['summaryOverrides'] = [choice(self.doc, mode='details')]
        issues = revalidate_ledger_issues([self.doc, second], self.ledger)
        self.assertEqual([(i['file'], i['severity']) for i in issues if i['code'] == 'character_summary_mismatch'],
                         [(self.doc['file'], 'warning'), ('other.png', 'error')])

    def test_provenance_conflicts_not_waived_by_all_details_modes(self):
        second = copy.deepcopy(self.doc)
        second.update(source_sha256='other', file='other.png')
        second['identity']['uid'] = 'another-account'
        second['pools'][0]['total'] += 1
        self.ledger['character']['summaryOverrides'] = [choice(d, mode='details') for d in (self.doc, second)]
        issues = revalidate_ledger_issues([self.doc, second], self.ledger)
        errors = {i['code'] for i in issues if i['severity'] == 'error'}
        self.assertIn('account_mismatch', errors)
        self.assertIn('overlapping_pool_conflict', errors)

    def test_invalid_overrides_are_rejected(self):
        invalid = [None, {}, [None], [choice(self.doc, mode='anything')],
                   [choice(self.doc, N=True)], [choice(self.doc, off=-1)],
                   [choice(self.doc, N=2.5)], [choice(self.doc, N=1, K6=2)],
                   [choice(self.doc, K6=1, off=2)],
                   [choice(self.doc), choice(self.doc)],
                   [{'mode': 'details'}], [choice(self.doc, N=2**53)]]
        for entries in invalid:
            with self.subTest(entries=entries):
                self.ledger['character']['summaryOverrides'] = entries
                with self.assertRaises(ValueError):
                    validate_ledger(self.ledger)

    def test_initial_collection_accepts_empty_unknown_and_all_supported(self):
        for owned in (None, [], ['骏卫', '祀'], ['俊卫']):
            self.ledger['character']['initialOwned'] = owned
            validate_ledger(self.ledger)

    def test_initial_collection_rejects_unknown_duplicates_and_invalid_types(self):
        for owned in ('莱万汀', ['unknown'], ['莱万汀', '莱万汀'], ['俊卫', '骏卫'], [None]):
            with self.subTest(owned=owned):
                self.ledger['character']['initialOwned'] = owned
                with self.assertRaises(ValueError):
                    validate_ledger(self.ledger)

    def test_initial_pity_rejects_invalid_values(self):
        for pity in (-1, 80, True, 1.5, '1'):
            self.ledger['character']['initialPity'] = pity
            with self.assertRaises(ValueError):
                validate_ledger(self.ledger)

    def test_first_pool_confirmation_binds_to_the_current_first_pool(self):
        character = self.ledger['character']
        first = character['pools'][0]
        character['firstPoolHistory'] = {'poolId': first['id'], 'isFirstPool': False}
        validate_ledger(self.ledger)
        for value in ({'poolId': 'missing', 'isFirstPool': False},
                      {'poolId': first['id'], 'isFirstPool': 'false'}, [], {}):
            character['firstPoolHistory'] = value
            with self.assertRaises(ValueError):
                validate_ledger(self.ledger)

    def test_http_save_and_restore_preserve_manual_modes_and_source(self):
        parent = Path(__file__).resolve().parent / 'test_outputs'
        parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='manual-contract-', dir=parent) as temp, patch.object(server, 'DATA', Path(temp)):
            original = copy.deepcopy(self.doc)
            initial = session_for([self.doc])
            correct_character(initial)
            pool = initial['ledger']['character']['pools'][0]
            pool.update(total=25, tail=5, quota=4820)
            character = initial['ledger']['character']
            character['firstPoolHistory'] = {'poolId': pool['id'], 'isFirstPool': True}
            character['summaryOverrides'] = [choice(self.doc, mode='details')]
            status, restored = handler('POST', '/api/restore', initial)
            self.assertEqual(status, 200, restored)
            self.assertEqual(restored['result']['scoredAxes'], 4)
            restored['revision'] += 1
            status, saved = handler('POST', '/api/score', {'session': restored})
            self.assertEqual(status, 200, saved)
            self.assertEqual(saved['result']['scoredAxes'], 4)
            self.assertEqual(saved['documents'], [original])
            self.assertEqual(saved['ledger']['character']['summaryOverrides'], character['summaryOverrides'])
            persisted = json.loads((server.DATA / saved['id'] / 'session.json').read_text(encoding='utf-8'))
            self.assertEqual(persisted['documents'], [original])
            persisted['ledger']['character']['summaryOverrides'] = [choice(self.doc, N=25, K6=2, off=1)]
            status, again = handler('POST', '/api/restore', persisted)
            self.assertEqual(status, 200, again)
            self.assertEqual(again['result']['scoredAxes'], 4)
            self.assertEqual(again['ledger']['issues'], [])


if __name__ == '__main__':
    unittest.main()
