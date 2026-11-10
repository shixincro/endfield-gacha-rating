"""Deterministic preview tests: saved OCR geometry only, no OCR or simulation."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from importer import attach_pool_image_evidence, build_ledger
from server import ensure_review_evidence, local_evidence_path
from test_importer import doc, pool, row


class ReviewEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='review-evidence-test-',
                                                 dir=Path(__file__).resolve().parent)
        self.root = Path(self.temp.name)
        self.directory = self.root / ('a' * 32) / 'image_00'
        self.directory.mkdir(parents=True)
        self.source = self.directory / 'source.png'
        Image.new('RGB', (500, 1000), '#87abcd').save(self.source)
        self.source_bytes = self.source.read_bytes()
        self.rows = [row('冬猎', 100, 200), row('熔火灼痕', 100, 1000)]
        self.raw_pools = [pool('冬猎', banner_raw='冬猎'), pool(banner_raw='熔火灼痕')]

    def tearDown(self):
        self.temp.cleanup()

    def url(self, path):
        return '/data/' + path.relative_to(self.root).as_posix()

    def test_regions_use_original_pixels_and_keep_sources_readonly(self):
        with patch('importer._prototype', side_effect=AssertionError('OCR must not run')):
            attach_pool_image_evidence(self.raw_pools, self.rows, self.source,
                                       self.directory / 'pool_evidence')
        first, second = [p['evidence'] for p in self.raw_pools]
        self.assertEqual(first['box'], [0, 86, 500, 486])
        self.assertEqual(second['box'], [0, 486, 500, 1000])
        self.assertEqual(first['sourceSize'], [500, 1000])
        with Image.open(first['crop']) as crop:
            self.assertEqual(crop.size, (500, 400))
            self.assertEqual(crop.getpixel((5, 5)), (135, 171, 205))
        self.assertEqual(self.source.read_bytes(), self.source_bytes)

    def test_unlocatable_title_only_exposes_full_source_fallback(self):
        attach_pool_image_evidence(self.raw_pools, [], self.source, self.directory / 'pool_evidence')
        self.assertEqual(self.raw_pools[0]['evidence']['sourceImage'], str(self.source.resolve()))
        self.assertNotIn('crop', self.raw_pools[0]['evidence'])

    def test_build_ledger_preserves_preview_and_all_issue_scopes(self):
        self.raw_pools[1]['evidence'] = {'crop': '/data/crop.png', 'box': [0, 1, 3, 5]}
        document = doc(self.raw_pools, weapon={'N': 10, 'K6': None, 'KU': None, 'B': None,
                                              'issues': [{'code': 'weapon_example', 'severity': 'error'}]})
        document['sourceImage'] = '/data/source.png'
        document['issues'] = [{'code': 'root_example', 'severity': 'error', 'message': '保持'}]
        document['pools'][1]['issues'] = [{'code': 'pool_example', 'severity': 'error'}]
        ledger = build_ledger([document])
        first = ledger['character']['pools'][0]
        self.assertEqual(first['evidence']['crop'], '/data/crop.png')
        self.assertEqual(first['evidence']['sourceImage'], '/data/source.png')
        self.assertEqual(ledger['issues'][0]['code'], 'root_example')
        self.assertEqual(ledger['issues'][0]['file'], document['file'])
        self.assertIn('pool_example', [i['code'] for i in first['issues']])
        self.assertIn('weapon_example', [i['code'] for i in ledger['weapon']['issues']])
        self.assertEqual(ledger['weapon']['evidence']['sourceImage'], '/data/source.png')

    def test_old_record_enrichment_preserves_reviewed_values_and_result(self):
        rows_path = self.directory / 'ocr_raw.json'
        rows_path.write_text(json.dumps(self.rows), encoding='utf-8')
        document = doc(self.raw_pools)
        document.update(sourceImage=self.url(self.source), rawOcrPath=self.url(rows_path))
        ledger = build_ledger([document])
        ledger['character']['pools'][0]['quota'] = 999  # user's correction must survive
        saved = {'documents': [document], 'ledger': ledger, 'result': {'score': 12},
                 'revision': 7, 'reviewed': True}
        before = copy.deepcopy(saved)
        with patch('importer._prototype', side_effect=AssertionError('OCR must not run')):
            ensure_review_evidence(saved, self.root)
        evidence = saved['ledger']['character']['pools'][0]['evidence']
        self.assertTrue(evidence['crop'].startswith('/data/'))
        self.assertEqual(saved['ledger']['character']['pools'][0]['quota'], 999)
        self.assertEqual(saved['result'], before['result'])
        self.assertEqual(saved['revision'], 7)
        self.assertTrue(saved['reviewed'])
        self.assertEqual(saved['ledger']['issues'], before['ledger']['issues'])
        self.assertFalse((self.directory / 'session.json').exists())

    def test_missing_cache_or_original_does_not_fail_old_records(self):
        document = doc(self.raw_pools)
        document.update(sourceImage=self.url(self.source), rawOcrPath='/data/missing.json')
        ledger = build_ledger([document])
        saved = {'documents': [document], 'ledger': ledger}
        ensure_review_evidence(saved, self.root)
        self.assertEqual(saved['ledger']['character']['pools'][0]['evidence']['sourceImage'],
                         self.url(self.source))
        document['sourceImage'] = '/data/missing.png'
        ensure_review_evidence(saved, self.root)

    def test_evidence_resolver_blocks_traversal_and_other_file_types(self):
        self.assertEqual(local_evidence_path(self.url(self.source), self.root, ('.png',)), self.source)
        self.assertIsNone(local_evidence_path('/data/../outside.png', self.root, ('.png',)))
        self.assertIsNone(local_evidence_path('/data/%2e%2e/outside.png', self.root, ('.png',)))
        self.assertIsNone(local_evidence_path(str(self.source), self.root / 'unrelated', ('.png',)))
        self.assertIsNone(local_evidence_path(self.url(self.source), self.root, ('.json',)))

    def test_old_weapon_average_restores_a_number_without_scoring_or_overwriting_clear(self):
        weapon = {'N': 680, 'K6': 33, 'KU': 11, 'evidence': {'rows': [
            row('51.5', 895, 665.5), row('UP平均', 894, 705)]}}
        saved = {'documents': [], 'ledger': {'weapon': weapon}, 'result': {'old': True}}
        with patch('importer._prototype', side_effect=AssertionError('OCR must not run')):
            ensure_review_evidence(saved, self.root)
        self.assertEqual(weapon['upAverage'], 51.5)
        self.assertIsInstance(weapon['upAverage'], (int, float))
        self.assertEqual(saved['result'], {'old': True})
        self.assertEqual([weapon[k] for k in ('N', 'K6', 'KU')], [680, 33, 11])
        weapon['upAverage'] = None
        ensure_review_evidence(saved, self.root)
        self.assertIsNone(weapon['upAverage'])


if __name__ == '__main__':
    unittest.main()
