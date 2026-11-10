"""Explicit A-only exemptions preserve evidence, uncertainty, B, and luck axes."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server
from hypothesis import preview_hypothesis
from importer import build_ledger, revalidate_current_ledger
from planning import VERSION
from service import score_ledger, validate_ledger
from test_planning import event, pool, run
from test_service import document, handler


def loss_document():
    doc = document()
    positions = [40,110,180,250,320,390]
    previous, events = 0, []
    for index, at in enumerate(positions):
        events.append({'pulls':at-previous, 'character':'莱万汀' if index == 0 else '余烬',
                       'off':index != 0, 'pity':None})
        previous = at
    doc['pools'][0].update(total=400,tail=10,tail_known=True,quota=27080,
                           events=list(reversed(events)),rushUsed=False,token_count=1)
    return doc


class PlanningExemptionTests(unittest.TestCase):
    def test_positive_exemption_changes_actual_sum_and_title_and_cancel_restores(self):
        current = pool(400,[event(40)]+[event(at,'常驻') for at in (110,180,250,320,390)],tokens=[{'at':240}])
        baseline = run(current)
        self.assertEqual(baseline['summary']['lossTier'],4)
        self.assertFalse(baseline['pools'][0]['planningExempt'])
        current['planningExempt'] = True
        snapshot = copy.deepcopy(current)
        exempt = run(current)
        self.assertEqual(current,snapshot)
        before, after = baseline['pools'][0], exempt['pools'][0]
        self.assertGreater(after['localLoss'],120)
        self.assertEqual(after['localLoss'],before['localLoss'])
        self.assertEqual(after['countedLoss'],0)
        self.assertEqual(after['exemptedLoss'],before['localLoss'])
        for key in ('actual','reference','permanentDelta','waterValueDelta','rewardValueDelta','opportunity'):
            self.assertEqual(after[key],before[key])
        summary = exempt['summary']
        self.assertEqual((summary['localLossSignedSum'],summary['localLossPositiveSum']), (0,0))
        self.assertEqual((summary['exemptedPools'],summary['lossTier'],summary['title']), (1,1,'自律狂人'))
        self.assertEqual(summary['rawLocalLossSignedSum'],baseline['summary']['localLossSignedSum'])
        self.assertEqual(summary['exemptedLossSum'],before['localLoss'])
        self.assertEqual(summary['opportunity'],baseline['summary']['opportunity'])
        current['planningExempt'] = False
        self.assertEqual(run(current),baseline)

    def test_negative_gain_and_zero_are_never_erased_by_exemption(self):
        for current in (pool(123,[event(70,'常驻'),event(120,forced=True)],
                             freeDrawPositions=[1,2,3,4,5,6,7,121,122,123]), pool(10)):
            baseline = run(current)
            current['planningExempt'] = True
            exempt = run(current)
            row = exempt['pools'][0]
            self.assertLessEqual(row['localLoss'],0)
            self.assertTrue(row['planningExempt'])
            self.assertEqual(row['countedLoss'],row['localLoss'])
            self.assertEqual(row['exemptedLoss'],0)
            self.assertEqual(exempt['summary'],baseline['summary'])

    def test_partial_conflicts_remain_uncalculated(self):
        for extra in ({'complete':False}, {'tail':7},
                      {'issues':[{'severity':'error','axes':['up'],'message':'未知身份'}]}):
            with self.subTest(extra=extra):
                current = pool(40,[event(35)],planningExempt=True,**extra)
                result = run(current)
                row, summary = result['pools'][0], result['summary']
                self.assertTrue(row['planningExempt'])
                self.assertIsNone(row['countedLoss'])
                self.assertEqual(row['exemptedLoss'],0)
                self.assertNotEqual(row['status'],'ok')
                self.assertEqual(summary['calculatedPools'],0)
                self.assertEqual(summary['exemptedPools'],0)
                self.assertEqual(summary['exemptedLossSum'],0)
                self.assertTrue(summary['sumIsPartial'])
                self.assertIsNone(summary['title'])

    def test_strict_boolean_validation_preserves_missing_legacy_default(self):
        ledger = build_ledger([document()])
        validate_ledger(ledger)
        target = ledger['character']['pools'][0]
        for flag in (True,False):
            target['planningExempt'] = flag
            validate_ledger(ledger)
        for flag in (None,0,1,'true','false',[],{}):
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError,'豁免'):
                target['planningExempt'] = flag
                validate_ledger(ledger)

    def test_service_exemption_preserves_six_axes_and_b(self):
        ledger = build_ledger([loss_document()])
        ledger['weapon'] = {'N':60,'K6':2,'KU':1,'issues':[]}
        before = score_ledger(ledger)
        ledger['character']['pools'][0]['planningExempt'] = True
        snapshot = copy.deepcopy(ledger)
        after = score_ledger(ledger)
        self.assertEqual(ledger,snapshot)
        self.assertEqual(before['scoredAxes'],6)
        self.assertEqual(after['axes'],before['axes'])
        self.assertEqual(after['planning']['summary']['opportunity'],before['planning']['summary']['opportunity'])
        self.assertEqual(after['planning']['pools'][0]['opportunity'],before['planning']['pools'][0]['opportunity'])
        self.assertGreater(before['planning']['summary']['localLossSignedSum'],120)
        self.assertEqual(after['planning']['summary']['localLossSignedSum'],0)

    def test_global_source_conflict_clears_all_precomputed_exemption_values(self):
        for axes in (None,['planning']):
            ledger = build_ledger([loss_document()])
            ledger['character']['pools'][0]['planningExempt'] = True
            conflict = {'severity':'error','message':'来源冲突'}
            if axes is not None:
                conflict['axes'] = axes
            ledger['issues'] = [conflict]
            result = score_ledger(ledger)['planning']
            row, summary = result['pools'][0], result['summary']
            self.assertTrue(row['planningExempt'])
            self.assertIsNone(row['localLoss'])
            self.assertIsNone(row['countedLoss'])
            self.assertEqual(row['exemptedLoss'],0)
            self.assertIsNone(row['opportunity']['value'])
            self.assertIsNone(summary['localLossSignedSum'])
            self.assertIsNone(summary['rawLocalLossSignedSum'])
            self.assertEqual((summary['exemptedPools'],summary['exemptedLossSum']), (0,0))
            self.assertIsNone(summary['title'])

    def test_legacy_revalidation_preserves_flag_and_hypothesis_inherits_it(self):
        documents = [loss_document()]
        ledger = build_ledger(documents)
        ledger['character']['pools'][0]['planningExempt'] = True
        original = copy.deepcopy(documents)
        with patch('importer._prototype',side_effect=AssertionError('must not OCR')):
            checked = revalidate_current_ledger(documents,ledger,reviewed=True)
            result = preview_hypothesis(documents,checked,'banner-0','next-six-80',choices={'470':'莱万汀'})
        self.assertEqual(documents,original)
        self.assertTrue(checked['character']['pools'][0]['planningExempt'])
        for key in ('before','after'):
            row = result[key]['planning']['pools'][0]
            self.assertTrue(row['planningExempt'])
            self.assertEqual(row['countedLoss'],0)


class PlanningExemptionPersistenceTests(unittest.TestCase):
    def test_save_reopen_restore_and_cancel_without_ocr(self):
        documents = [loss_document()]
        ledger = build_ledger(documents)
        ledger['character']['pools'][0]['planningExempt'] = True
        session = {'schemaVersion':'gacha-rating-session-v1','revision':1,
                   'documents':documents,'ledger':ledger,'reviewed':True}
        with tempfile.TemporaryDirectory(prefix='planning-exemption-',dir=Path(__file__).resolve().parent) as directory:
            with patch.object(server,'DATA',Path(directory)), patch('importer._prototype',side_effect=AssertionError('must not OCR')):
                status, restored = handler('POST','/api/restore',session)
                self.assertEqual(status,200,restored)
                self.assertEqual(restored['result']['planning']['version'],VERSION)
                status, opened = handler('GET','/api/sessions/'+restored['id'])
                self.assertEqual(status,200,opened)
                self.assertTrue(opened['ledger']['character']['pools'][0]['planningExempt'])
                self.assertEqual(opened['result']['planning']['summary']['localLossSignedSum'],0)
                opened['revision'] += 1
                status, saved = handler('POST','/api/score',{'session':opened})
                self.assertEqual(status,200,saved)
                self.assertEqual(saved['revision'],2)
                disk = json.loads((Path(directory)/saved['id']/'session.json').read_text(encoding='utf-8'))
                self.assertTrue(disk['ledger']['character']['pools'][0]['planningExempt'])
                self.assertEqual(disk['documents'],documents)
                status, copied = handler('POST','/api/restore',saved)
                self.assertEqual(status,200,copied)
                self.assertNotEqual(copied['id'],saved['id'])
                self.assertTrue(copied['ledger']['character']['pools'][0]['planningExempt'])
                saved['ledger']['character']['pools'][0]['planningExempt'] = False
                saved['revision'] += 1
                status, cancelled = handler('POST','/api/score',{'session':saved})
                self.assertEqual(status,200,cancelled)
                summary = cancelled['result']['planning']['summary']
                self.assertGreater(summary['localLossSignedSum'],120)
                self.assertEqual(summary['localLossSignedSum'],summary['rawLocalLossSignedSum'])
                self.assertEqual(summary['exemptedLossSum'],0)
                self.assertFalse(any(Path(directory).glob('*/image_*')))


if __name__ == '__main__':
    unittest.main()
