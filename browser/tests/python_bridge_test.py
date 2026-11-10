"""CPython equivalence tests for the browser adapter; fixtures are synthetic.

This verifies orchestration against the existing local service. Browser/WASM
execution is checked separately by the browser integration tests.
"""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'tools' / 'gacha_rating_app'
sys.path[:0] = [str(ROOT / 'browser' / 'python'), str(APP)]
import bridge
import importer
import record_import
import service
import weapon_scoring
from test_record_import import api, api_row, v3, v3_row
from test_hypothesis import fixture


def node_character(text):
    result = subprocess.run([shutil.which('node'), str(APP / 'score_cli.js')],
                            input=text, capture_output=True, text=True, encoding='utf-8',
                            check=True, timeout=30,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return result.stdout


def stripped(value):
    value = copy.deepcopy(value)
    if isinstance(value, dict):
        return {key: stripped(child) for key, child in value.items()
                if key not in ('elapsedSeconds', 'updatedAt')}
    if isinstance(value, list):
        return [stripped(child) for child in value]
    return value


@contextmanager
def source_service():
    with patch.object(service, 'shutil', shutil), patch.object(service, 'subprocess', subprocess), \
            patch.object(service, 'score_weapon_record', weapon_scoring.score_weapon_record):
        yield


def source_score(session):
    result = copy.deepcopy(session)
    with source_service():
        result['ledger'] = importer.revalidate_current_ledger(
            result['documents'], result['ledger'], reviewed=result.get('reviewed', False))
        result['scoringScenario'] = service.normalize_scoring_scenario(
            result.get('scoringScenario', {'enabled': False}))
        result['result'] = service.score_session_result(
            result['documents'], result['ledger'], result['scoringScenario'],
            reviewed=result.get('reviewed', False))
        result['recognitionVersion'] = importer.RECOGNITION_VERSION
    return result


class BrowserPythonBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bridge.initialize(ROOT, character_scorer=node_character)
        cls.demo = json.loads((ROOT / 'examples' / 'demo-session.json').read_text(encoding='utf-8'))

    def call(self, op, **data):
        response = json.loads(bridge.dispatch_json(json.dumps({'op': op, 'data': data}, ensure_ascii=False)))
        self.assertTrue(response['ok'], response)
        return response['value']

    def test_configuration_uses_current_source_versions(self):
        config = self.call('init')
        self.assertEqual(config['runtime'], 'browser')
        self.assertTrue(config['localOnly'])
        self.assertEqual(config['recognitionVersion'], importer.RECOGNITION_VERSION)
        self.assertEqual(config['weaponVersion'], weapon_scoring.VERSION)

    def test_demo_restore_matches_all_local_scores_and_loss_details(self):
        expected = source_score(self.demo)
        actual = self.call('restore', session=self.demo)
        self.assertNotEqual(actual['id'], self.demo['id'])
        expected['id'] = actual['id']
        self.assertEqual(stripped(actual), stripped(expected))
        self.assertEqual(actual['result']['scoredAxes'], 6)

    def test_six_record_structures_match_source_parser_and_scorer(self):
        batches = {'1': {'p': '熔火灼痕', 'c': [['莱万汀', 5, 1, 0]]},
                   '2': {'p': '熔铸申领', 'c': [['熔铸火焰', 5, 1]]}}
        examples = [
            ('demo.txt', '1,熔火灼痕,莱万汀-5-1-0\n2,熔铸申领,熔铸火焰-5-1'),
            ('demo.json', batches),
            ('demo.json', {'info': {'uid': 'demo-account'}, 'data': batches}),
            ('demo.txt', api([api_row(1, '莱万汀', 6)])),
            ('demo.json', v3([{'id': 'c', 'name': '熔火灼痕', 'type': 'limited', 'up_character': '莱万汀'}],
                             [v3_row('c', 1, '莱万汀', 6)])),
            ('demo.json', {'uid': 'demo-account', 'data': {'角色寻访-冬猎': [api_row(99, '提弗洛斯', 6, banner='冬猎')]}}),
        ]
        for filename, value in examples:
            with self.subTest(filename=filename, value=value):
                text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                expected = source_score(record_import.import_record_text(text, filename))
                actual = self.call('import_record', name=filename, text=text)
                expected['id'] = actual['id']
                self.assertEqual(stripped(actual), stripped(expected))

    def test_unknown_format_error_survives_boundary_but_malformed_is_distinct(self):
        unknown = json.loads(bridge.dispatch_json(json.dumps({'op': 'import_record', 'name': 'x.json', 'text': '{}'})))
        self.assertFalse(unknown['ok'])
        self.assertEqual(unknown['code'], 'record_format_unrecognized')
        malformed = json.loads(bridge.dispatch_json(json.dumps({'op': 'import_record', 'name': 'x.json', 'text': '{'})))
        self.assertFalse(malformed['ok'])
        self.assertNotIn('code', malformed)

    def test_validate_preserves_current_edits_and_authoritative_documents(self):
        original = copy.deepcopy(self.demo)
        candidate = copy.deepcopy(original)
        candidate['documents'][0]['file'] = 'tampered source'
        candidate['ledger']['character']['pools'][0]['planningExempt'] = True
        expected = importer.revalidate_current_ledger(original['documents'], candidate['ledger'], reviewed=True)
        candidate['reviewed'] = True
        result = self.call('validate', session=candidate, original=original)
        self.assertEqual(result['ledger'], expected)
        self.assertEqual(original, self.demo)

    def test_score_preserves_source_and_detects_revision_conflict(self):
        original = copy.deepcopy(self.demo)
        candidate = copy.deepcopy(original)
        candidate['revision'] += 1
        candidate['documents'][0]['file'] = 'tampered source'
        result = self.call('revalidate_score', session=candidate, original=original, expectedRevision=original['revision'])
        self.assertEqual(result['documents'], original['documents'])
        response = json.loads(bridge.dispatch_json(json.dumps({
            'op': 'score', 'session': candidate, 'original': original, 'expectedRevision': 123})))
        self.assertFalse(response['ok'])
        self.assertIn('记录已更新', response['error'])

    def test_hypothesis_plan_preview_and_saved_option_match_source(self):
        documents, ledger = fixture()
        session = {'schemaVersion': bridge.SESSION_SCHEMA, 'id': 'b' * 32, 'revision': 1,
                   'documents': documents, 'ledger': ledger, 'reviewed': True}
        params = {'session': session, 'poolId': 'banner-0', 'mode': 'first-up-120',
                  'choices': {'100': '艾尔黛拉'}, 'additionalFive': None}
        from hypothesis import plan_hypothesis, preview_hypothesis
        with source_service():
            expected_plan = plan_hypothesis(documents, ledger, 'banner-0', 'first-up-120', reviewed=True)
            expected_preview = preview_hypothesis(documents, ledger, 'banner-0', 'first-up-120',
                                                 choices=params['choices'], additional_five=None, reviewed=True)
        self.assertEqual(stripped(self.call('hypothesis_plan', **params)), stripped(expected_plan))
        self.assertEqual(stripped(self.call('hypothesis_preview', **params)), stripped(expected_preview))
        session['scoringScenario'] = {'enabled': True, **{key: value for key, value in params.items() if key != 'session'}}
        expected = source_score(session)
        actual = self.call('score', session=session)
        self.assertEqual(stripped(actual), stripped(expected))
        self.assertEqual(actual['ledger'], expected['ledger'])

    def test_hypothetical_ledger_is_not_accepted_as_actual(self):
        candidate = copy.deepcopy(self.demo)
        candidate['ledger']['hypothesis'] = True
        response = json.loads(bridge.dispatch_json(json.dumps({'op': 'restore', 'session': candidate})))
        self.assertFalse(response['ok'])
        self.assertIn('不能保存为真实记录', response['error'])

    def test_no_ocr_dependency_needed_for_records_or_recalculation(self):
        with patch.object(importer, '_prototype', side_effect=AssertionError('OCR was invoked')):
            self.call('restore', session=self.demo)
            self.call('import_record', name='test.txt', text='1,熔火灼痕,莱万汀-5-1-0')

    def test_from_documents_uses_original_ledger_builder(self):
        result = self.call('from_documents', documents=self.demo['documents'], id='c' * 32)
        self.assertEqual(result['id'], 'c' * 32)
        expected_ledger = importer.build_ledger(self.demo['documents'])
        expected_ledger = importer.revalidate_current_ledger(self.demo['documents'], expected_ledger)
        self.assertEqual(result['ledger'], expected_ledger)

    def test_javascript_weapon_callback_and_error_handling(self):
        calls = []
        def weapon(text):
            data = json.loads(text)
            calls.append(data)
            return json.dumps(weapon_scoring.score_weapon_record(data), ensure_ascii=False)
        try:
            bridge.initialize(ROOT, character_scorer=node_character, weapon_scorer=weapon)
            result = self.call('restore', session=self.demo)
            expected = source_score(self.demo)
            self.assertTrue(calls)
            self.assertEqual(stripped(result['result']), stripped(expected['result']))
        finally:
            bridge.initialize(ROOT, character_scorer=node_character)

    def test_non_finite_input_rejected_before_processing(self):
        result = json.loads(bridge.dispatch_json('{"op":"init","number":NaN}'))
        self.assertFalse(result['ok'])
        self.assertIn('非有限', result['error'])


if __name__ == '__main__':
    unittest.main()
