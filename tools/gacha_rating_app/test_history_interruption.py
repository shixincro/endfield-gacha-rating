"""Lossy-history boundaries are explicit settings, never invented draw facts."""
import copy
import json
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

import server
from history_interruption import VERSION, normalize_correction, project_character, project_ledger
from hypothesis import plan_hypothesis, preview_hypothesis
from importer import BANNERS, revalidate_current_ledger
from opportunity import first_up
from service import score_ledger, validate_ledger
from test_service import handler


def pool(index, total, hits=(), initial=0):
    banner = list(BANNERS)[index]
    return {'id': f'pool-{index}', 'index': index, 'banner': banner, 'up': BANNERS[banner],
            'total': total, 'initialPity': initial, 'tail': total-hits[-1][0] if hits else initial+total,
            'localTail': total-hits[-1][0] if hits else total,
            'quota': 20*total+1980*len(hits)+180*max(0, total//10-len(hits)),
            'events': [{'at': at, 'character': name, 'source': 'main', 'forced': False,
                        'identitySource': 'manual'} for at, name in hits],
            'rush': [], 'rushUsed': False, 'rushAt': None, 'tokens': [], 'issues': [],
            'evidence': {'manual': True}, 'freeAllowance': 10, 'ended': True}


def ledger(pools=None, selected=(7,), free=10):
    pools = pools if pools is not None else [pool(6, 30), pool(8, 60, [(60, '诀')], 30)]
    return {'schemaVersion': 'gacha-ledger-v1', 'issues': [], 'weapon': None,
            'character': {'pools': pools, 'initialPity': pools[0]['initialPity'], 'initialOwned': [],
                          'completeHistory': False, 'issues': [],
                          'interruptionCorrection': {'excludedIndices': list(selected),
                                                     'freeAllowances': {'8': free}}}}


def documents():
    return [{'file': 'interruption-fixture.json', 'source_sha256': 'interruption-fixture',
             'kind': 'character', 'identity': {'uid': '12345678'}, 'pools': [], 'issues': []}]


class InterruptionProjectionTests(unittest.TestCase):
    def test_missing_banner_resets_without_mutating_facts(self):
        data = ledger()
        before = copy.deepcopy(data)
        view, summary = project_ledger(data)
        self.assertEqual(data, before)
        self.assertEqual(view['character']['pools'][1]['initialPity'], 0)
        self.assertTrue(view['character']['pools'][1]['interruptionBefore'])
        self.assertEqual(summary['excludedPoolIds'], [])
        self.assertEqual(summary['resetPools'][0]['freeAllowance'], 10)
        self.assertEqual(project_ledger(view)[0], view)

    def test_existing_excluded_pool_has_no_counts_or_quota_scope(self):
        data = ledger([pool(6, 30), pool(7, 20, initial=30), pool(8, 60, [(60, '诀')], 50)])
        data['character']['quotaSummary'] = {'scope': 'all-pools', 'Q': 0, 'N': 110, 'R': 0, 'K6': 1}
        result = score_ledger(data)
        self.assertEqual(result['character']['counts']['main'], 90)
        self.assertEqual(result['interruptionCorrection']['excludedPoolIds'], ['pool-7'])
        self.assertEqual(result['interruptionCorrection']['excludedMainDraws'], 20)
        self.assertIsNotNone(result['axes']['five']['score'])
        self.assertEqual([p['index'] for p in result['planning']['pools']], [6, 8])
        self.assertEqual(len(data['character']['pools']), 3)

    def test_reset_propagates_only_previously_consistent_water(self):
        data = ledger([pool(6, 30), pool(8, 20, initial=30), pool(9, 40, [(40, '梨诺')], 50)])
        view, _ = project_ledger(data)
        self.assertEqual([(p['initialPity'], p['tail']) for p in view['character']['pools']], [(0,30),(0,20),(20,0)])
        data['character']['pools'][2]['initialPity'] = 40
        projected, _ = project_ledger(data)
        self.assertEqual(projected['character']['pools'][2]['initialPity'], 40)
        self.assertIsNone(score_ledger(data)['axes']['up']['score'])

    def test_new_opening_does_not_fabricate_prior_ownership(self):
        data = ledger([pool(6, 30), pool(8, 60, [(60, '诀')], 30)], selected=(6,7))
        view, _ = project_ledger(data)
        self.assertEqual(view['character']['initialPity'], 0)
        self.assertIsNone(view['character']['initialOwned'])
        self.assertEqual([p['index'] for p in view['character']['pools']], [8])

    def test_future_selection_does_not_change_complete_history_evidence(self):
        data = ledger([pool(0, 10, [(10, '莱万汀')]), pool(2, 10, [(10, '伊冯')])], selected=(7,))
        data['character'].update(completeHistory=True, historyEvidence='launch_and_exact_category_totals_zero_pull_gaps')
        view, summary = project_character(data['character'])
        self.assertEqual(view, data['character'])
        self.assertTrue(summary['enabled'])
        self.assertEqual(summary['resetPools'], [])
        scored = score_ledger(data)
        data['character']['interruptionCorrection']['excludedIndices'] = []
        self.assertEqual(scored['axes'], score_ledger(data)['axes'])

    def test_all_excluded_has_no_fake_zero_scores(self):
        result = score_ledger(ledger(selected=(6,7,8)))
        self.assertEqual(result['scoredAxes'], 0)
        self.assertEqual(result['planning']['pools'], [])
        self.assertTrue(result['interruptionCorrection']['enabled'])

    def test_strict_settings_and_zero_free_supported(self):
        for config in ({}, [], {'excludedIndices':[True]}, {'excludedIndices':[len(BANNERS)]},
                       {'excludedIndices':[7,7]}, {'excludedIndices':[7], 'freeAllowances':{'08':10}},
                       {'excludedIndices':[7], 'freeAllowances':{'8':True}},
                       {'excludedIndices':[7], 'freeAllowances':{'8':5}}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                normalize_correction(config)
        result = score_ledger(ledger(free=0))
        self.assertEqual(result['planning']['pools'][1]['freeAllowance'], 0)
        self.assertEqual(result['planning']['pools'][1]['actual']['permanent'], 60)
        self.assertTrue(all(value >= 0 for value in first_up(30, 30, 0, False)))

    def test_supplemented_pity_only_changes_luck_and_not_planning_or_facts(self):
        data = ledger()
        baseline = score_ledger(data)
        original = copy.deepcopy(data)
        data['character']['interruptionCorrection']['resumeInfo'] = {'8': {'initialPity': 15}}
        supplemented = copy.deepcopy(data)
        result = score_ledger(data)
        self.assertEqual(data, supplemented)
        self.assertEqual(data['character']['pools'], original['character']['pools'])
        self.assertEqual(result['planning'], baseline['planning'])
        self.assertEqual(result['character']['counts'], baseline['character']['counts'])
        for key in ('characterSix', 'up'):
            self.assertNotEqual(result['axes'][key]['score'], baseline['axes'][key]['score'])
        self.assertEqual(result['axes']['up']['details']['completed'][0]['initialPity'], 15)
        # A contradictory luck-only override must not suppress resource quotes.
        data['character']['interruptionCorrection']['resumeInfo']['8']['initialPity'] = 40
        result = score_ledger(revalidate_current_ledger(documents(), data))
        self.assertIsNone(result['axes']['characterSix']['score'])
        self.assertEqual(result['planning'], baseline['planning'])

    def test_catalog_supplement_restores_ownership_without_becoming_a_hit(self):
        data = ledger([pool(6, 10, [(10, '弭弗')]), pool(8, 20, [(10, '卡缪')])])
        baseline = score_ledger(data)
        self.assertEqual(baseline['planning']['pools'][1]['opportunity']['status'], 'partial')
        data['character']['interruptionCorrection']['resumeInfo'] = {
            '8': {'ownedSixStars': ['诀'], 'catalogComplete': False}}
        partial = score_ledger(data)
        self.assertEqual(partial['planning']['pools'][1]['opportunity']['value'], 0)
        self.assertEqual(partial['axes']['limited']['details']['identities'][-1]['weight'], 1)
        data['character']['interruptionCorrection']['resumeInfo']['8']['catalogComplete'] = True
        result = score_ledger(data)
        self.assertEqual(result['axes']['limited']['details']['identities'][-1]['weight'], 2)
        for key in ('main', 'total', 'six', 'up', 'quota'):
            self.assertEqual(result['character']['counts'][key], baseline['character']['counts'][key])
        for key in ('characterSix', 'up'):
            self.assertEqual(result['axes'][key], baseline['axes'][key])
        self.assertEqual(result['axes']['five']['score'], baseline['axes']['five']['score'])
        data['character']['pools'][1]['events'][0]['character'] = '弭弗'
        retained = score_ledger(data)
        self.assertEqual(retained['axes']['limited']['details']['identities'][-1]['weight'], 1)

    def test_full_catalog_makes_not_owned_target_quote_calculable(self):
        data = ledger([pool(6, 10, [(10, '弭弗')]), pool(8, 20)])
        data['character']['interruptionCorrection']['resumeInfo'] = {'8': {'catalogComplete': True}}
        result = score_ledger(data)
        self.assertEqual(result['planning']['pools'][1]['opportunity']['status'], 'ok')
        self.assertIsNotNone(result['planning']['pools'][1]['opportunity']['value'])

    def test_resume_settings_are_strict_and_python_js_projections_agree(self):
        for info in (None, [], {'initialPity': True}, {'initialPity': -1}, {'initialPity': 80},
                     {'initialPity': None}, {'initialPity': 1.5}, {'initialPity': '20'},
                     {'catalogComplete': 1}, {'ownedSixStars': None}, {'ownedSixStars': ['未知']},
                     {'ownedSixStars': ['俊卫', '骏卫']}):
            with self.subTest(info=info), self.assertRaises(ValueError):
                normalize_correction({'excludedIndices': [7], 'resumeInfo': {'8': info}})
        for info in (None, [], {'08': {}}, {'13': {}}):
            with self.subTest(resume=info), self.assertRaises(ValueError):
                normalize_correction({'excludedIndices': [7], 'resumeInfo': info})
        data = ledger([pool(6, 30), pool(8, 10, initial=30), pool(9, 20, [(20, '梨诺')], 40)])
        data['character']['interruptionCorrection']['resumeInfo'] = {
            '8': {'initialPity': 25, 'ownedSixStars': ['俊卫', '弭弗'], 'catalogComplete': True}}
        original = copy.deepcopy(data)
        js = "const e=require('./static/character-edit');let t='';process.stdin.on('data',s=>t+=s);process.stdin.on('end',()=>{const c=JSON.parse(t);process.stdout.write(JSON.stringify([e.projectCharacter(c),e.projectCharacter(c,{forPlanning:true})]));});"
        result = subprocess.run([shutil.which('node'), '-e', js], cwd=Path(__file__).parent,
                                input=json.dumps(data['character']), text=True, encoding='utf-8',
                                capture_output=True, check=True)
        for expected, planning in zip(json.loads(result.stdout), (False, True)):
            character, summary = project_character(data['character'], for_planning=planning)
            self.assertEqual(expected, {'character': character, 'summary': summary})
            self.assertEqual(project_character(character, for_planning=planning)[0], character)
        self.assertEqual(data, original)


class InterruptionFlowTests(unittest.TestCase):
    def test_corrected_wait_scores_and_cancel_restores_original_failure(self):
        data = ledger()
        fixed = revalidate_current_ledger(documents(), data)
        self.assertFalse(any(i['code']=='six_wait_exceeds_80' for i in fixed['character']['pools'][1]['issues']))
        self.assertEqual(fixed['character']['pools'][1]['initialPity'], 30)
        result = score_ledger(fixed)
        self.assertIsNotNone(result['axes']['up']['score'])
        self.assertEqual(result['axes']['up']['details']['completed'][0]['actual'], 60)
        fixed['character']['interruptionCorrection']['excludedIndices'] = []
        restored = revalidate_current_ledger(documents(), fixed)
        self.assertTrue(any(i['code']=='six_wait_exceeds_80' for i in restored['character']['pools'][1]['issues']))
        self.assertIsNone(score_ledger(restored)['axes']['up']['score'])

    def test_internal_bad_wait_is_not_waived(self):
        data = ledger([pool(6, 30), pool(8, 90, [(90, '诀')], 30)])
        result = score_ledger(revalidate_current_ledger(documents(), data))
        self.assertIsNone(result['axes']['up']['score'])

    def test_source_conflict_stays_blocking(self):
        docs = documents()
        docs.append({**copy.deepcopy(docs[0]), 'source_sha256':'another-source', 'identity':{'uid':'87654321'}})
        data = revalidate_current_ledger(docs, ledger())
        self.assertTrue(any(i['severity']=='error' for i in data['issues']))
        self.assertEqual(score_ledger(data)['scoredAxes'], 0)

    def test_hypothesis_uses_effective_end_water_and_keeps_facts(self):
        data = ledger([pool(6, 30), pool(8, 20, initial=30)])
        before = copy.deepcopy(data)
        plan = plan_hypothesis(documents(), data, 'pool-8', 'next-six-80')['plan']
        self.assertEqual((plan['fromPity'], plan['toTotal'], plan['addedDraws']), (20,80,60))
        preview = preview_hypothesis(documents(), data, 'pool-8', 'next-six-80', choices={'80':'诀'})
        self.assertEqual(preview['after']['character']['counts']['main'], 110)
        self.assertIsNotNone(preview['after']['axes']['up']['score'])
        self.assertEqual(data, before)

    def test_hypothesis_uses_supplemental_luck_pity_without_changing_planning_baseline(self):
        data = ledger([pool(6, 30), pool(8, 20, initial=30)])
        planning = score_ledger(data)['planning']
        data['character']['interruptionCorrection']['resumeInfo'] = {'8': {'initialPity': 15}}
        original = copy.deepcopy(data)
        preview = preview_hypothesis(documents(), data, 'pool-8', 'next-six-80', choices={'65': '诀'})
        self.assertEqual((preview['plan']['fromPity'], preview['plan']['toTotal']), (35, 65))
        self.assertEqual(preview['before']['planning'], planning)
        self.assertIsNotNone(preview['after']['axes']['up']['score'])
        self.assertEqual(data, original)

    def test_hypothesis_with_existing_excluded_pool_keeps_scope_and_source_totals(self):
        data = ledger([pool(6, 30), pool(7, 10, initial=30), pool(8, 20, initial=40)])
        docs = documents()
        docs[0]['overview'] = {'character': {'N': 60, 'K6': 0, 'off': 0}}
        before = copy.deepcopy(data)
        preview = preview_hypothesis(docs, data, 'pool-8', 'next-six-80', choices={'80':'诀'})
        self.assertEqual(preview['before']['character']['counts']['main'], 50)
        self.assertEqual(preview['after']['character']['counts']['main'], 110)
        for result in (preview['before'], preview['after']):
            self.assertEqual(result['interruptionCorrection']['excludedPoolIds'], ['pool-7'])
            self.assertEqual(result['interruptionCorrection']['excludedMainDraws'], 10)
            self.assertIsNotNone(result['axes']['up']['score'])
        self.assertEqual(data, before)

    def test_api_preview_save_reopen_restore_keep_original_pools(self):
        with tempfile.TemporaryDirectory(prefix='interruption-', dir=Path(__file__).resolve().parent) as temp:
            with patch.object(server, 'DATA', Path(temp)), patch('importer._prototype', side_effect=AssertionError('No OCR')):
                record = {'schemaVersion':'gacha-rating-session-v1','id':'d'*32, 'revision':1, 'updatedAt':1,
                          'documents':documents(), 'ledger':ledger(), 'reviewed':True}
                record['ledger']['character']['interruptionCorrection']['resumeInfo'] = {
                    '8': {'initialPity': 15, 'ownedSixStars': ['卡缪'], 'catalogComplete': True}}
                path = server.DATA/record['id']/'session.json'
                server.save_json(path, record)
                original = path.read_bytes()
                code, draft = handler('POST', '/api/validate', {'session':record})
                self.assertEqual(code,200,draft)
                self.assertEqual(path.read_bytes(), original)
                code, saved = handler('POST', '/api/score', {'session':record})
                self.assertEqual(code,200,saved)
                self.assertEqual(saved['ledger']['character']['pools'][1]['initialPity'],30)
                self.assertIsNotNone(saved['result']['axes']['up']['score'])
                code, opened = handler('GET', '/api/sessions/'+saved['id'])
                self.assertEqual(code,200,opened)
                self.assertEqual(opened['ledger']['character']['interruptionCorrection'],
                                 record['ledger']['character']['interruptionCorrection'])
                self.assertEqual(opened['result']['interruptionCorrection']['version'],VERSION)
                code, restored = handler('POST', '/api/restore', opened)
                self.assertEqual(code,200,restored)
                self.assertNotEqual(restored['id'],opened['id'])
                self.assertEqual(restored['ledger'],opened['ledger'])
                self.assertEqual(restored['result']['axes'],opened['result']['axes'])
                code, config = handler('GET','/api/config')
                self.assertEqual(config['interruptionVersion'],VERSION)


if __name__ == '__main__':
    unittest.main()
