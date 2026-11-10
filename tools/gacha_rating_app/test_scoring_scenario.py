"""Saved hypothetical score preferences never become actual draw history."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server
from service import SCENARIO_VERSION, normalize_scoring_scenario, score_ledger
from test_hypothesis import fixture, manual_pool
from test_service import handler


def settings(**changes):
    return {'enabled':True,'poolId':'banner-0','mode':'first-up-120',
            'choices':{'100':'艾尔黛拉'},'additionalFive':None,**changes}


class ScenarioConfigurationTests(unittest.TestCase):
    def test_strict_types_and_normalization_keep_only_settings(self):
        for value in (None,False,[],{}, {'enabled':1}, {'enabled':'false'},
                      settings(poolId=0),settings(mode=[]),settings(choices=[]),
                      settings(choices={'0100':'艾尔黛拉'}),settings(choices={'100':None}),
                      settings(additionalFive=True),settings(additionalFive=1.5)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_scoring_scenario(value)
        self.assertEqual(normalize_scoring_scenario({'enabled':False,'poolId':None,'choices':False}), {'enabled':False})
        candidate = settings(after={'scoredAxes':6},plan={'toTotal':1})
        self.assertEqual(normalize_scoring_scenario(candidate), settings())


class ScoringScenarioEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='scoring-scenario-',dir=Path(__file__).resolve().parent)
        self.data_patch = patch.object(server,'DATA',Path(self.temp.name))
        self.data_patch.start()
        documents, ledger = fixture()
        ledger['weapon'] = {'N':60,'K6':2,'KU':1,'issues':[]}
        ledger['character']['pools'][0]['ended'] = False
        self.record = {'id':'e'*32,'schemaVersion':'gacha-rating-session-v1','revision':1,
                       'updatedAt':1,'documents':documents,'ledger':ledger,'reviewed':True,'result':{}}
        self.path = server.DATA/self.record['id']/'session.json'
        server.save_json(self.path,self.record)
        self.no_ocr = patch('importer._prototype',side_effect=AssertionError('must not OCR'))
        self.no_ocr.start()

    def tearDown(self):
        self.no_ocr.stop()
        self.data_patch.stop()
        self.temp.cleanup()

    def submit(self, scenario=None, *, record=None):
        candidate = copy.deepcopy(self.record if record is None else record)
        if scenario is not None:
            candidate['scoringScenario'] = copy.deepcopy(scenario)
        candidate['revision'] += 1
        return handler('POST','/api/score',{'session':candidate})

    def test_legacy_record_defaults_off_and_result_is_actual(self):
        code, config = handler('GET','/api/config')
        self.assertEqual(code,200,config)
        self.assertEqual(config['scoringScenarioVersion'],SCENARIO_VERSION)
        code, saved = self.submit()
        self.assertEqual(code,200,saved)
        self.assertEqual(saved['scoringScenario'],{'enabled':False})
        self.assertFalse(saved['result']['scoringScenario']['enabled'])
        self.assertNotIn('hypothesis',saved['result'])
        self.assertEqual(saved['result']['character']['counts']['main'],50)
        self.assertEqual(saved['result']['scoredAxes'],6)

    def test_enable_save_reopen_and_repeat_scores_once_without_changing_actual_data(self):
        code, saved = self.submit(settings())
        self.assertEqual(code,200,saved)
        self.assertEqual(saved['result']['character']['counts']['main'],120)
        self.assertEqual(saved['result']['scoredAxes'],5)
        self.assertEqual(saved['result']['axes']['five']['status'],'unscored')
        self.assertEqual(saved['result']['scoringScenario']['version'],SCENARIO_VERSION)
        self.assertEqual(saved['result']['scoringScenario']['plan']['addedDraws'],70)
        self.assertEqual(saved['result']['hypothesis']['mode'],'first-up-120')
        self.assertEqual(saved['scoringScenario'],settings())
        real = saved['ledger']['character']['pools'][0]
        self.assertEqual((real['total'],real['tail'],len(real['events']),real['quota']), (50,30,1,4060))
        self.assertFalse(real['ended'])
        self.assertNotIn('hypothesis',saved['ledger'])
        self.assertEqual(saved['documents'],self.record['documents'])
        code, opened = handler('GET','/api/sessions/'+saved['id'])
        self.assertEqual(code,200,opened)
        self.assertEqual(opened,saved)
        code, repeated = self.submit(record=opened)
        self.assertEqual(code,200,repeated)
        self.assertEqual(repeated['result']['character']['counts']['main'],120)
        self.assertEqual(repeated['ledger'],saved['ledger'])
        self.assertEqual(repeated['revision'],saved['revision']+1)
        self.assertFalse(any(server.DATA.glob('*/image_*')))

    def test_valid_five_counts_allow_all_six_axes_and_reject_client_calculated_result(self):
        candidate = copy.deepcopy(self.record)
        candidate['result'] = {'scoredAxes':99,'character':{'counts':{'main':9999}}}
        code, saved = self.submit(settings(additionalFive=5,after=candidate['result']),record=candidate)
        self.assertEqual(code,200,saved)
        self.assertEqual(saved['result']['scoredAxes'],6)
        self.assertEqual(saved['result']['character']['counts']['main'],120)
        self.assertEqual(saved['result']['scoringScenario']['plan']['additionalQuota'],6260)
        self.assertNotIn('after',saved['scoringScenario'])
        self.assertEqual(saved['ledger']['character']['pools'][0]['quota'],4060)

    def test_restore_recalculates_enabled_configuration_from_actual_facts(self):
        code, saved = self.submit(settings(additionalFive=5))
        self.assertEqual(code,200,saved)
        saved['result'] = {'scoredAxes':99}
        code, restored = handler('POST','/api/restore',saved)
        self.assertEqual(code,200,restored)
        self.assertNotEqual(restored['id'],saved['id'])
        self.assertEqual(restored['scoringScenario'],settings(additionalFive=5))
        self.assertEqual(restored['result']['scoredAxes'],6)
        self.assertEqual(restored['result']['character']['counts']['main'],120)
        self.assertEqual(restored['ledger'],saved['ledger'])
        self.assertEqual(restored['documents'],self.record['documents'])
        disk = json.loads((server.DATA/restored['id']/'session.json').read_text(encoding='utf-8'))
        self.assertEqual(disk,restored)

    def test_disable_restores_actual_axes_and_planning_even_with_expired_choices(self):
        code, enabled = self.submit(settings(additionalFive=5))
        self.assertEqual(code,200,enabled)
        actual = score_ledger(enabled['ledger'])
        code, disabled = self.submit({'enabled':False,'poolId':'removed','mode':'invalid','choices':[]},record=enabled)
        self.assertEqual(code,200,disabled)
        self.assertEqual(disabled['scoringScenario'],{'enabled':False})
        self.assertNotIn('hypothesis',disabled['result'])
        self.assertEqual(disabled['result']['axes'],actual['axes'])
        self.assertEqual(disabled['result']['planning'],actual['planning'])
        self.assertEqual(disabled['ledger'],enabled['ledger'])
        self.assertEqual(disabled['result']['character']['counts']['main'],50)

    def test_invalid_enabled_choices_leave_previous_saved_record_intact(self):
        before = self.path.read_bytes()
        invalid = [settings(poolId='missing'),settings(mode='bad'),settings(choices={}),
                   settings(choices={'100':'莱万汀'}),settings(choices={'99':'艾尔黛拉'}),
                   settings(additionalFive=0),settings(additionalFive=69)]
        for value in invalid:
            with self.subTest(value=value):
                code, error = self.submit(value)
                self.assertEqual(code,400,error)
                self.assertTrue(error['error'])
                self.assertEqual(self.path.read_bytes(),before)

    def test_changed_real_pity_existing_main_up_and_nonlast_pool_revalidate_plan(self):
        for change in ('water','up','nonlast'):
            candidate = copy.deepcopy(self.record)
            pool = candidate['ledger']['character']['pools'][0]
            if change == 'water':
                pool['events'][0]['at'] = 25
                pool['tail'] = pool['localTail'] = 25
            elif change == 'up':
                pool['events'][0].update(character='莱万汀',identitySource='manual')
            else:
                candidate['ledger']['character']['pools'].append(manual_pool())
            with self.subTest(change=change):
                self.assertEqual(self.submit(settings(),record=candidate)[0],400)

    def test_enabled_record_keeps_preview_readonly_and_based_on_actual_total(self):
        code, saved = self.submit(settings())
        self.assertEqual(code,200,saved)
        before = self.path.read_bytes()
        request = {'session':saved,'poolId':'banner-0','mode':'first-up-120','choices':{'100':'艾尔黛拉'}}
        code, plan = handler('POST','/api/hypothesis/plan',request)
        self.assertEqual(code,200,plan)
        self.assertEqual(plan['plan']['fromTotal'],50)
        code, preview = handler('POST','/api/hypothesis/preview',request)
        self.assertEqual(code,200,preview)
        self.assertEqual(preview['before']['character']['counts']['main'],50)
        self.assertEqual(preview['after']['character']['counts']['main'],120)
        self.assertEqual(self.path.read_bytes(),before)

    def test_real_source_conflict_and_exemption_survive_enabled_scoring(self):
        self.record['documents'][0]['overview']['character']['N'] = 49
        self.record['ledger']['character']['pools'][0]['planningExempt'] = True
        server.save_json(self.path,self.record)
        code, saved = self.submit(settings(additionalFive=5))
        self.assertEqual(code,200,saved)
        self.assertIsNone(saved['result']['axes']['up']['score'])
        self.assertIsNone(saved['result']['planning']['summary']['title'])
        self.assertTrue(saved['ledger']['character']['pools'][0]['planningExempt'])
        self.assertIsNone(saved['result']['planning']['pools'][0]['countedLoss'])

    def test_simulated_events_still_cannot_be_persisted_as_actual_history(self):
        candidate = copy.deepcopy(self.record)
        candidate['ledger']['character']['pools'][0]['events'][0]['identitySource'] = 'manual-hypothesis'
        self.assertEqual(self.submit(settings(),record=candidate)[0],400)
        candidate['scoringScenario'] = settings()
        self.assertEqual(handler('POST','/api/restore',candidate)[0],400)


if __name__ == '__main__':
    unittest.main()
