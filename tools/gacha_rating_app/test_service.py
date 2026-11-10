"""Backend/HTTP-handler regression without browser automation or network access."""
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import server
from importer import build_ledger
from service import score_ledger, validate_ledger


def document():
    return {'file':'fixture.png','kind':'character','source_sha256':'a'*64,
            'identity':{'uid':'12345678'},'issues':[],
            'pools':[{'banner':'熔火灼痕','total':10,'tail':0,'quota':2360,
                      'events':[{'pulls':10,'pity':None,'character':'莱万汀','off':False}],
                      'rush':[],'rush_present':False,'rush_state':False,'token_count':0,'needs_review':[]}]}


def handler(method,path,body=None,headers=None):
    instance=object.__new__(server.Handler)
    instance.server=SimpleNamespace(server_port=4320)
    instance.path=path
    data=json.dumps(body or {}).encode('utf-8')
    instance.headers={'Host':'127.0.0.1:4320','Content-Type':'application/json',
                      'Content-Length':str(len(data)),'X-App-Token':server.TOKEN}
    instance.headers.update(headers or {})
    instance.rfile=io.BytesIO(data)
    outputs=[]
    instance.send=lambda status,body,content_type=None:outputs.append((status,body))
    getattr(instance,'do_'+method)()
    return outputs[0]


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.ledger=build_ledger([document()])

    def test_valid_minimal_import_four_character_axes(self):
        result=score_ledger(self.ledger)
        self.assertEqual(result['scoredAxes'],4)
        self.assertIsNone(result['mean'])
        self.assertTrue(all(result['axes'][k]['score'] is not None for k in ('characterSix','up','limited','five')))

    def test_config_exposes_the_version_returned_by_up_only_production_score(self):
        code, config = handler('GET', '/api/config')
        result = score_ledger(self.ledger)
        self.assertEqual(code, 200)
        self.assertEqual(config['characterVersion'], result['character']['version'])
        self.assertEqual(result['axes']['up']['details']['method'],
                         'merged-wait-exact-dp-draw-weighted-up')
        self.assertEqual(result['axes']['characterSix']['details']['method'],
                         'ordinary80-total-six-count-dp-with-rush-convolution')

    def test_legacy_hard_count_does_not_change_new_scores(self):
        self.ledger['weapon']={'N':60,'K6':2,'KU':1,'B':1,'H80':None}
        default=score_ledger(self.ledger)
        self.ledger['weapon']['H80']=0
        corrected=score_ledger(self.ledger)
        self.assertEqual(default['scoredAxes'],6)
        self.assertIsNone(default['mean'])
        self.assertEqual(default['weapon']['version'],corrected['weapon']['version'])
        for axis in ('weaponSix','signature'):
            self.assertEqual(default['axes'][axis]['score'], corrected['axes'][axis]['score'])

    def test_weapon_only(self):
        self.ledger['character']={'pools':[],'initialPity':None,'initialOwned':None,'completeHistory':False}
        self.ledger['weapon']={'N':60,'K6':2,'KU':1,'B':1,'H80':None}
        result=score_ledger(self.ledger)
        self.assertEqual(result['scoredAxes'],2)
        self.assertIsNone(result['mean'])

    def test_weapon_individual_draws_preserve_the_exact_ratio_and_require_explicit_support(self):
        self.ledger['weapon']={'N':752,'K6':33,'KU':13,'B':5,'H80':None}
        self.assertIsNone(score_ledger(self.ledger)['axes']['weaponSix']['score'])
        self.ledger['weapon']['allowIndividualDraws']=True
        observed=score_ledger(self.ledger)
        self.ledger['weapon']={'N':7520,'K6':330,'KU':130,'H80':None}
        scaled=score_ledger(self.ledger)
        for axis in ('weaponSix','signature'):
            self.assertEqual(observed['axes'][axis]['score'],scaled['axes'][axis]['score'])
        self.assertEqual(observed['weapon']['total_draws'],752)

    def test_precise_weapon_individual_draws_require_explicit_support(self):
        self.ledger['weapon']={'N':1284,'K6':71,'KU':12,'B':3,'H80':2}
        self.assertIsNone(score_ledger(self.ledger)['axes']['weaponSix']['score'])
        self.ledger['weapon']['allowIndividualDraws']=True
        result=score_ledger(self.ledger)
        self.assertEqual(result['scoredAxes'],6)
        self.assertTrue(all(result['axes'][a]['score'] is not None for a in ('weaponSix','signature')))

    def test_partial_history_unknown_opening_still_scores_available_segments(self):
        doc=document()
        doc['pools'][0].update(banner='临渊望北',total=30,tail=10,quota=2940,rushUsed=False,
            events=[{'pulls':20,'pity':None,'character':'诀','off':False}])
        ledger=build_ledger([doc])
        result=score_ledger(ledger)
        # The known ten draws after the first six now contribute a zero-hit
        # count interval; the unknown first twenty draws are still excluded.
        self.assertEqual(result['scoredAxes'],4)
        self.assertAlmostEqual(result['axes']['characterSix']['score'],50*.992**10)
        self.assertEqual(result['character']['coverage']['unfinishedSixDraws'],10)
        self.assertEqual(result['character']['coverage']['excludedMainDraws'],20)
        self.assertEqual(result['character']['coverage']['ownershipMode'],'limited-only-no-new-bonus')
        self.assertFalse(ledger['character']['completeHistory'])
        self.assertIsNone(ledger['character']['initialPity'])
        self.assertIsNone(ledger['character']['initialOwned'])

    def test_empty_not_fifty(self):
        result=score_ledger({'schemaVersion':'gacha-ledger-v1','character':{'pools':[]},'weapon':{'N':0,'B':0}})
        self.assertEqual(result['scoredAxes'],0)

    def test_huge_pool_count_no_dp(self):
        self.ledger['weapon']={'N':10000,'K6':500,'KU':100,'profile':'9999999'}
        result=score_ledger(self.ledger)
        self.assertIsNone(result['axes']['weaponSix']['score'])

    def test_default_weapon_needs_only_totals_even_for_old_saved_issue(self):
        self.ledger['weapon']={'N':350,'K6':20,'KU':8,'B':None,'H80':None,
                              'issues':[{'code':'weapon_pool_count_missing','severity':'error'}]}
        result=score_ledger(self.ledger)
        self.assertEqual(result['weapon']['reference_pools'],10)
        self.assertAlmostEqual(result['axes']['weaponSix']['score'],70.6260680823)
        self.assertAlmostEqual(result['axes']['signature']['score'],88.4188332407)
        self.assertIsNone(self.ledger['weapon']['B'])

    def test_default_weapon_reference_not_changed_by_observed_pool_count(self):
        self.ledger['weapon']={'N':350,'K6':20,'KU':8,'B':1,'H80':None}
        a=score_ledger(self.ledger)
        self.ledger['weapon']['B']=9999999
        b=score_ledger(self.ledger)
        self.assertEqual(a['weapon']['six_star'],b['weapon']['six_star'])
        self.assertEqual(b['weapon']['reference_pools'],10)

    def test_legacy_corrected_weapon_no_longer_requires_pool_count(self):
        self.ledger['weapon']={'N':350,'K6':20,'KU':8,'B':None,'H80':0}
        self.assertIsNotNone(score_ledger(self.ledger)['axes']['weaponSix']['score'])

    def test_manual_loss_applies_only_to_signature_and_average_never_changes_scores(self):
        raw = {'N':680,'K6':33,'KU':11,'upAverage':51.5}
        self.ledger['weapon'] = raw
        original = score_ledger(self.ledger)['weapon']
        self.ledger['weapon'] = {**raw, 'upAverage':2.0, 'lossDraws':13}
        corrected = score_ledger(self.ledger)['weapon']
        self.assertEqual(corrected['six_star'], original['six_star'])
        self.assertEqual(corrected['six_star']['count'], 33)
        self.assertEqual(corrected['signature']['count'], 11)
        self.assertEqual(corrected['signature']['total_draws'], 667)
        self.assertGreater(corrected['signature']['score'], original['signature']['score'])
        self.assertIsNone(corrected['averageEstimate'])
        del self.ledger['weapon']['lossDraws']
        self.assertEqual(score_ledger(self.ledger)['weapon'], original)

    def test_distributed_overflow_profile_matches_legacy_targets(self):
        self.ledger['weapon'] = {'N':1200,'KU':15,'K6':50,'profile':'3 7 5 1'}
        original = score_ledger(self.ledger)['weapon']
        self.ledger['weapon'] = {'N':1200,'KU':15,'K6':50,'potentialConfig':{
            'totalTypes':3,'counts':[1,0,0,0,2],'overflowCopies':2,'overflowByType':[0,2]}}
        self.assertEqual(score_ledger(self.ledger)['weapon'], original)
        self.ledger['weapon']['lossDraws'] = 37
        corrected = score_ledger(self.ledger)['weapon']
        self.assertEqual(corrected['six_star'], original['six_star'])
        self.assertEqual(corrected['signature']['total_draws'], 1163)
        self.assertEqual(corrected['signature']['count'], 16)
        self.assertGreater(corrected['signature']['score'], original['signature']['score'])
        del self.ledger['weapon']['potentialConfig']['overflowByType']
        self.assertIn('溢出份数', score_ledger(self.ledger)['axes']['signature']['reason'])

    def test_invalid_or_exhausted_signature_budget_does_not_block_six_score(self):
        self.ledger['weapon'] = {'N':80,'KU':0,'K6':4}
        original = score_ledger(self.ledger)['axes']['weaponSix']
        for loss in (80, 81, -1, True, 1.5):
            with self.subTest(loss=loss):
                self.ledger['weapon']['lossDraws'] = loss
                axes = score_ledger(self.ledger)['axes']
                self.assertEqual(axes['weaponSix'], original)
                self.assertIsNone(axes['signature']['score'])

    def test_profile_has_priority_over_average_and_keeps_guarantee_outputs(self):
        self.ledger['weapon']={'N':100,'K6':4,'KU':2,'profile':'2','upAverage':1.0,'H80':1}
        a=score_ledger(self.ledger)
        self.ledger['weapon']['H80']=0
        b=score_ledger(self.ledger)
        self.assertEqual(a['weapon']['mode'],'potential-profile')
        self.assertIsNone(a['weapon']['averageEstimate'])
        self.assertEqual(a['scoredAxes'],6)
        for axis in ('weaponSix','signature'):
            self.assertEqual(a['axes'][axis]['score'],b['axes'][axis]['score'])

    def test_failed_average_inference_falls_back_without_inventing_gifts(self):
        self.ledger['weapon']={'N':60,'K6':2,'KU':1,'upAverage':99.9}
        result=score_ledger(self.ledger)
        self.assertEqual(result['weapon']['mode'],'raw-totals')
        self.assertEqual(result['weapon']['signature']['count'],1)
        self.assertEqual(result['weapon']['six_star']['count'],2)

    def test_unknown_average_and_missing_hard_count_do_not_block_profile(self):
        self.ledger['weapon']={'N':100,'K6':4,'KU':2,'profile':'2','B':None,'H80':None}
        self.assertEqual(score_ledger(self.ledger)['scoredAxes'],6)

    def test_repeated_weapon_potential_matches_explicit_profile_without_mutating_input(self):
        self.ledger['weapon']={'N':2000,'K6':100,'KU':40,'profile':'11 5*7'}
        before=copy.deepcopy(self.ledger)
        repeated=score_ledger(self.ledger)
        self.assertEqual(self.ledger,before)
        self.ledger['weapon']['profile']='11 '+' '.join(['5']*7)
        expanded=score_ledger(self.ledger)
        self.assertEqual(repeated['scoredAxes'],6)
        self.assertEqual(repeated['weapon'],expanded['weapon'])
        self.assertEqual(repeated['axes']['weaponSix'],expanded['axes']['weaponSix'])
        self.assertEqual(repeated['axes']['signature'],expanded['axes']['signature'])
        self.assertEqual(repeated['weapon']['profile']['total_copies'],46)

    def test_profile_type_limit_matches_ui_without_capping_overflow_potential(self):
        self.ledger['weapon']={'N':1200,'K6':65,'KU':15,'profile':'12 6 1'}
        result=score_ledger(self.ledger)
        self.assertEqual(result['scoredAxes'],6)
        self.assertEqual(result['weapon']['profile']['overflow_copies'],1)
        self.ledger['weapon']={'N':1200,'K6':65,'KU':31,'profile':'31'}
        result=score_ledger(self.ledger)
        self.assertIsNone(result['axes']['weaponSix']['score'])
        self.assertIn('1至30',result['axes']['weaponSix']['reason'])

    def test_default_weapon_still_blocks_other_conflicts(self):
        self.ledger['weapon']={'N':350,'K6':20,'KU':8,'B':None,'H80':None,
                              'issues':[{'code':'weapon_summary_conflict','severity':'error'}]}
        self.assertIsNone(score_ledger(self.ledger)['axes']['weaponSix']['score'])

    def test_global_identity_conflict_blocks_luck_and_planning(self):
        self.ledger['issues']=[{'severity':'error','message':'不同账号'}]
        result=score_ledger(self.ledger)
        self.assertEqual(result['scoredAxes'],0)
        self.assertTrue(all(p['localLoss'] is None for p in result['planning']['pools']))
        self.assertTrue(all(p['opportunity']['value'] is None for p in result['planning']['pools']))
        self.assertIsNone(result['planning']['summary']['opportunity']['total'])

    def test_planning_scoped_root_conflict_blocks_both_metrics_not_luck(self):
        self.ledger['issues']=[{'severity':'error','axes':['planning'],'message':'资源来源冲突'}]
        result=score_ledger(self.ledger)
        self.assertEqual(result['scoredAxes'],4)
        self.assertTrue(all(p['localLoss'] is None for p in result['planning']['pools']))
        self.assertTrue(all(p['opportunity']['value'] is None for p in result['planning']['pools']))

    def test_unknown_weapon_field_is_not_zero(self):
        self.ledger['weapon']={'N':60,'K6':2,'KU':None,'B':1,'H80':None}
        self.assertIsNone(score_ledger(self.ledger)['axes']['signature']['score'])

    def test_invalid_top_schema(self):
        with self.assertRaises(ValueError):validate_ledger({'pools':[]})

    def test_service_does_not_mutate_input(self):
        before=copy.deepcopy(self.ledger)
        score_ledger(self.ledger)
        self.assertEqual(before,self.ledger)


class HandlerTests(unittest.TestCase):
    def setUp(self):
        directory=Path(__file__).resolve().parent/'test_outputs'
        directory.mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='gacha-rating-test-',dir=directory)
        self.mock=patch.object(server,'DATA',Path(self.temp.name))
        self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.temp.cleanup()

    def test_health(self):
        status,data=handler('GET','/api/config')
        self.assertEqual(status,200,data)
        self.assertTrue(data['localOnly'])

    def test_cross_origin_rejected(self):
        self.assertEqual(handler('POST','/api/score',{}, {'Origin':'https://example.com'})[0],403)

    def test_host_rebinding_rejected(self):
        self.assertEqual(handler('GET','/api/config',headers={'Host':'evil.test:4320'})[0],403)

    def test_token_required(self):
        self.assertEqual(handler('POST','/api/score',{}, {'X-App-Token':''})[0],403)

    def test_directory_traversal_rejected(self):
        self.assertEqual(handler('GET','/data/../../planning.py')[0],403)

    def test_only_image_evidence_served(self):
        self.assertEqual(handler('GET','/data/any/session.json')[0],403)

    def test_body_limit(self):
        self.assertEqual(handler('POST','/api/import',{}, {'Content-Length':str(server.MAX_BODY+1)})[0],413)

    def test_restore_roundtrip_and_rescore(self):
        session={'schemaVersion':'gacha-rating-session-v1','revision':1,'documents':[document()],
                 'ledger':build_ledger([document()]),'reviewed':False}
        status,restored=handler('POST','/api/restore',session)
        self.assertEqual(status,200,restored)
        self.assertTrue((server.DATA/restored['id']/'session.json').is_file())
        restored['revision']=2
        restored['reviewed']=True
        code,scored=handler('POST','/api/score',{'session':restored})
        self.assertEqual(code,200)
        self.assertTrue(scored['reviewed'])
        self.assertEqual(scored['result']['planning']['version'], server.PLANNING_VERSION)
        self.assertEqual(scored['result']['planning']['summary']['opportunity']['total'], 0)
        self.assertEqual(scored['result']['planning']['pools'][0]['opportunity']['status'], 'ok')
        persisted=json.loads((server.DATA/scored['id']/'session.json').read_text(encoding='utf-8'))
        self.assertEqual(persisted['result']['planning'],scored['result']['planning'])
        restored['revision']=1
        self.assertEqual(handler('POST','/api/score',{'session':restored})[0],409)

    def test_restore_rechecks_source_identity(self):
        other=document();other['identity']['uid']='87654321';other['source_sha256']='b'*64
        session={'schemaVersion':'gacha-rating-session-v1','revision':1,'documents':[document(),other],
                 'ledger':build_ledger([document()]),'reviewed':False}
        status,result=handler('POST','/api/restore',session)
        self.assertEqual(status,200,result)
        self.assertEqual(result['result']['scoredAxes'],0)
        self.assertTrue(all(p['localLoss'] is None for p in result['result']['planning']['pools']))

    def test_bad_image_extension(self):
        self.assertEqual(handler('POST','/api/import',{'files':[{'name':'a.html','data':'eA=='}]})[0],400)


if __name__=='__main__':unittest.main()
