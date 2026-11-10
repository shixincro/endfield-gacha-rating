"""Synthetic exports only; no player fixtures or private source files."""
import json
import unittest

from importer import revalidate_current_ledger
from record_import import import_record_text
from service import score_session_result


def api_row(seq, name='四星角色', rarity=4, banner='熔火灼痕', weapon=False, **extra):
    return {'seqId':str(seq),'gachaTs':str(seq),'poolId':banner,'poolName':banner,
            'weaponName' if weapon else 'charName':name,'rarity':rarity,'isFree':False, **extra}


def api(rows, **extra):
    return {'code':0,'data':{'list':rows,'hasMore':False,'nickName':'演示账号',**extra}}


def convert(source, **kwargs):
    result=import_record_text(json.dumps(source,ensure_ascii=False),'synthetic.json',**kwargs)
    result['ledger']=revalidate_current_ledger(result['documents'],result['ledger'])
    return result


def issues(session):
    ledger=session['ledger']
    return [item for group in [ledger,ledger['character'],ledger.get('weapon') or {},*ledger['character']['pools']]
            for item in group.get('issues',[])]


def v3(definitions, rows):
    return {'formatId':'internal_json_v3','accounts':[{'gameUid':'demo-account','nickName':'演示账号'}],
            'pools':definitions,'history':rows}


def v3_row(pid, seq, name='四星角色', rarity=4, **extra):
    return {'poolId':pid,'seqId':str(seq),'id':f'{pid}:{seq}','name':name,'rarity':rarity,
            'isFree':False,'gameUid':'demo-account','timestamp':'2026-01-22T12:00:00+08:00',**extra}


class RecordImportTests(unittest.TestCase):
    def test_txt_and_bare_batch_json_use_shifted_rarity(self):
        batch={'1':{'p':'熔火灼痕','c':[['莱万汀',5,1,0]]},
               '2':{'p':'熔铸申领','c':[['熔铸火焰',5,1]]}}
        left=import_record_text('1,熔火灼痕,莱万汀-5-1-0\n2,熔铸申领,熔铸火焰-5-1','demo.txt')
        right=convert(batch)
        for session in (left,right):
            self.assertEqual(session['ledger']['character']['pools'][0]['events'][0]['character'],'莱万汀')
            self.assertEqual(session['ledger']['weapon']['KU'],1)
            self.assertEqual(session['ledger']['weapon']['potentialConfig']['totalTypes'],1)
            self.assertFalse(session['ledger']['character']['completeHistory'])

    def test_wrapped_batches_and_mixed_metadata_are_supported(self):
        source={'info':{'uid':'demo-account','channel':'test'},'data':{
            '1':{'p':'熔火灼痕','pi':'a','ci':'character','seq':1,'c':[['莱万汀',5,1,0]]},
            '2':{'p':'轻飘飘的信使','s':'unknown','c':[['洁尔佩塔',5,0,0]]}}}
        session=convert(source)
        self.assertEqual(len(session['ledger']['character']['pools']),2)
        self.assertFalse(session['ledger']['character']['completeHistory'])
        self.assertTrue(any('没有抽取序号' in w for w in session['importSummary']['warnings']))

    def test_api_json_inside_txt_and_sixty_ticket(self):
        rows=[api_row(n) for n in range(1,61)]
        rows[39]['charName']='莱万汀';rows[39]['rarity']=6
        rows.append(api_row(61,'未知角色',3))
        session=import_record_text(json.dumps(api(rows),ensure_ascii=False),'demo.txt')
        pool=session['ledger']['character']['pools'][0]
        self.assertEqual(pool['total'],60)
        self.assertEqual(pool['quota'],59*20+2000)
        self.assertEqual(len(session['documents'][0]['importAudit'][0]['rewards']),1)
        self.assertEqual(session['importMethod'],'api-list-json')

    def test_unknown_three_star_outside_reward_boundary_is_blocked(self):
        session=convert(api([api_row(1,'未知角色',3)]))
        self.assertIn('structured_ambiguous_row',[i['code'] for i in issues(session)])

    def test_enduid_ticket_does_not_count_as_draw_and_opening_unknown(self):
        rows=[api_row(n,banner='冬猎') for n in range(100,160)]
        rows[20].update(charName='提弗洛斯',rarity=6)
        rows.append(api_row(160,'寻访情报书',None,banner='冬猎',kind='gift_intel_book'))
        session=convert({'uid':'demo-account','data_time':1,'data':{'角色寻访-冬猎':rows}})
        pool=session['ledger']['character']['pools'][0]
        self.assertEqual(pool['total'],60)
        self.assertFalse(session['ledger']['character']['completeHistory'])
        self.assertIsNone(pool['initialPity'])

    def test_unknown_opening_with_no_six_does_not_invent_known_tail(self):
        session=convert({'uid':'demo-account','data':{'角色寻访-冬猎':[api_row(99,banner='冬猎')]}})
        pool=session['ledger']['character']['pools'][0]
        self.assertIsNone(pool['initialPity'])
        self.assertIsNone(pool['tail'])

    def test_v3_explicit_gifts_override_shifted_source_nodes(self):
        definition={'id':'w','name':'熔铸申领','type':'weapon','up_character':'熔铸火焰','isLimitedWeapon':True}
        rows=[v3_row('w',n,name='四星武器') for n in range(1,171)]
        rows[9].update(name='熔铸火焰',rarity=6)
        rows.append(v3_row('w',171,'熔铸火焰',6,specialType='gift'))
        session=convert(v3([definition],rows))
        w=session['ledger']['weapon']
        self.assertEqual((w['N'],w['K6'],w['KU']),(170,1,1))
        self.assertEqual(w['potentialConfig']['counts'],[1,0,0,0,0])
        self.assertTrue(any('偏离固定节点' in m for m in session['importSummary']['warnings']))

    def test_nameless_eleventh_weapon_reward_is_separate(self):
        definition={'id':'w','name':'幽寒申领','type':'weapon','up_character':'寒夜幽影'}
        rows=[v3_row('w',n,'四星武器',4,batchId=f'b{(n-1)//10}') for n in range(1,181)]
        rows[9].update(name='寒夜幽影',rarity=6)
        rows.append(v3_row('w',181,'',None,batchId='b17'))
        session=convert(v3([definition],rows))
        w=session['ledger']['weapon']
        self.assertEqual((w['N'],w['K6'],w['KU']),(180,1,1))
        self.assertEqual(w['potentialConfig']['counts'][0],1)
        self.assertEqual(w['sections'][0]['signatureGifts'][0]['at'],180)

    def test_nameless_eleventh_character_token_is_not_six(self):
        rows=[v3_row('c',n,'四星角色',4,batchId=f'b{(n-1)//10}') for n in range(1,241)]
        for n in (40,100,160,220):rows[n-1].update(name='莱万汀',rarity=6)
        rows.append(v3_row('c',241,'',None,batchId='b23'))
        session=convert(v3([{'id':'c','name':'熔火灼痕','type':'limited','up_character':'莱万汀'}],rows))
        p=session['ledger']['character']['pools'][0]
        self.assertEqual(p['total'],240)
        self.assertEqual(len(p['events']),4)
        self.assertEqual(len(p['tokens']),1)

    def test_source_up_conflicts_are_rejected(self):
        for definition in [{'id':'c','name':'熔火灼痕','type':'limited','up_character':'余烬'},
                           {'id':'w','name':'雷鸣申领','type':'weapon','up_character':'楔子'}]:
            with self.assertRaisesRegex(ValueError,'冲突'):
                convert(v3([definition],[v3_row(definition['id'],1)]))

    def test_unknown_six_weapon_never_scores_as_definite_off_banner(self):
        session=convert(api([api_row(1,'',6,banner='熔铸申领',weapon=True)]))
        self.assertIsNone(session['ledger']['weapon']['KU'])
        self.assertIsNone(session['ledger']['weapon']['sections'][0]['eventsNewestFirst'][0]['isUp'])
        self.assertIn('structured_weapon_identity_unknown',[i['code'] for i in issues(session)])
        result=score_session_result(session['documents'],session['ledger'],{'enabled':False})
        self.assertIsNone(result['axes']['signature']['score'])

    def test_unknown_weapon_up_is_kept_unscored(self):
        session=convert(api([api_row(1,'六星武器',6,banner='未收录申领',weapon=True)]))
        self.assertIsNone(session['ledger']['weapon']['KU'])
        self.assertIn('structured_weapon_up_unknown',[i['code'] for i in issues(session)])

    def test_internal_sequence_gaps_block_instead_of_becoming_draw_two(self):
        for seq in (3,6):
            session=convert(api([api_row(1),api_row(seq,'莱万汀',6)]))
            self.assertFalse(session['ledger']['character']['completeHistory'])
            self.assertIsNone(session['ledger']['character']['pools'][0]['initialPity'])
            self.assertIn('structured_history_gap',[i['code'] for i in issues(session)])
            result=score_session_result(session['documents'],session['ledger'],{'enabled':False})
            self.assertIsNone(result['axes']['up']['score'])

    def test_weapon_sequence_gap_does_not_clear_character_initial_collection(self):
        rows=[api_row(1,'莱万汀',6),api_row(1,'四星武器',4,banner='熔铸申领',weapon=True),
              api_row(3,'熔铸火焰',6,banner='熔铸申领',weapon=True)]
        session=convert(api(rows))
        self.assertTrue(session['ledger']['character']['completeHistory'])
        self.assertEqual(session['ledger']['character']['initialOwned'],[])
        self.assertIn('structured_history_gap',[i['code'] for i in session['ledger']['weapon']['issues']])

    def test_single_missing_reward_slot_follows_confirmed_import_policy(self):
        rows=[api_row(n) for n in range(1,61)]+[api_row(62)]
        rows[39].update(charName='莱万汀',rarity=6)
        session=convert(api(rows))
        self.assertNotIn('structured_history_gap',[i['code'] for i in issues(session)])
        gap=session['documents'][0]['sourceSequenceGaps'][0]
        self.assertEqual(gap['classification'],'omitted-reward-slot-at-confirmed-node')
        self.assertEqual(gap['rewardKind'],'next-banner-ticket')
        self.assertEqual(session['ledger']['character']['pools'][0]['total'],61)
        self.assertTrue(session['ledger']['character']['completeHistory'])
        self.assertTrue(any('1处节点缺号' in warning for warning in session['importSummary']['warnings']))
        self.assertFalse(any('未解释' in warning or '水位保持未知' in warning for warning in session['importSummary']['warnings']))

    def test_existing_ticket_prevents_another_missing_slot_from_becoming_reward(self):
        rows=[api_row(n) for n in range(1,61)]+[api_row(61,'未知角色',3),api_row(63)]
        session=convert(api(rows))
        gap=session['documents'][0]['sourceSequenceGaps'][0]
        self.assertEqual(gap['rewardInferenceBlockedBy'],'existing-reward')
        self.assertIn('structured_history_gap',[i['code'] for i in issues(session)])

    def test_unknown_opening_does_not_make_observed_sixty_a_known_reward_node(self):
        rows=[api_row(n,banner='冬猎') for n in range(100,160)]+[api_row(161,banner='冬猎')]
        session=convert(api(rows))
        self.assertIn('structured_history_gap',[i['code'] for i in issues(session)])
        self.assertFalse(any(g['classification']=='omitted-reward-slot-at-confirmed-node'
                             for g in session['documents'][0]['sourceSequenceGaps']))

    def test_earlier_unknown_gap_prevents_later_sixty_reward_inference(self):
        rows=[api_row(n) for n in range(1,11)]+[api_row(n) for n in range(12,62)]+[api_row(63)]
        session=convert(api(rows))
        self.assertTrue(all(g['classification']=='unknown-missing-entries'
                            for g in session['documents'][0]['sourceSequenceGaps']))

    def test_two_missing_slots_at_reward_node_remain_unknown(self):
        session=convert(api([api_row(n) for n in range(1,61)]+[api_row(63)]))
        self.assertIn('structured_history_gap',[i['code'] for i in issues(session)])

    def test_switching_pool_assigns_omitted_reward_to_previous_pool(self):
        rows=[api_row(n) for n in range(1,61)]+[api_row(62,'洁尔佩塔',6,banner='轻飘飘的信使')]
        rows[39].update(charName='莱万汀',rarity=6)
        session=convert(api(rows))
        gap=session['documents'][0]['sourceSequenceGaps'][0]
        self.assertEqual((gap['rewardBanner'],gap['rewardAt']),('熔火灼痕',60))
        self.assertEqual(session['ledger']['character']['pools'][1]['total'],1)

    def test_missing_weapon_gift_does_not_duplicate_fixed_node_inference(self):
        rows=[api_row(n,'四星武器',4,banner='行舟申领',weapon=True) for n in range(1,181)]
        rows[9].update(weaponName='孤舟',rarity=6)
        rows.append(api_row(182,'四星武器',4,banner='行舟申领',weapon=True))
        session=convert(api(rows))
        w=session['ledger']['weapon']
        self.assertEqual((w['N'],w['K6'],w['KU']),(181,1,1))
        self.assertEqual(len(w['sections'][0]['signatureGifts']),1)
        self.assertEqual(w['potentialConfig']['counts'],[1,0,0,0,0])
        self.assertEqual(w['sections'][0]['signatureGifts'][0]['classificationMethod'],'user-confirmed-single-missing-reward-slot')

    def test_existing_shifted_explicit_weapon_gift_prevents_duplicate_reward(self):
        definition={'id':'w','name':'熔铸申领','type':'weapon','up_character':'熔铸火焰'}
        rows=[v3_row('w',n,'四星武器',4) for n in range(1,171)]
        rows[9].update(name='熔铸火焰',rarity=6)
        rows.append(v3_row('w',171,'熔铸火焰',6,specialType='gift'))
        rows.extend(v3_row('w',n,'四星武器',4) for n in range(172,182))
        rows.append(v3_row('w',183,'四星武器',4))
        session=convert(v3([definition],rows))
        gap=session['documents'][0]['sourceSequenceGaps'][0]
        self.assertEqual(gap['rewardInferenceBlockedBy'],'existing-reward')
        self.assertEqual(len(session['ledger']['weapon']['sections'][0]['signatureGifts']),1)
        self.assertEqual(session['ledger']['weapon']['N'],181)

    def test_missing_character_token_does_not_duplicate_fixed_node_token(self):
        rows=[api_row(n) for n in range(1,241)]+[api_row(242)]
        for n in (40,100,160,220):rows[n-1].update(charName='莱万汀',rarity=6)
        session=convert(api(rows))
        p=session['ledger']['character']['pools'][0]
        self.assertEqual((p['total'],len(p['events']),len(p['tokens'])),(241,4,1))
        self.assertEqual(session['documents'][0]['sourceSequenceGaps'][0]['rewardKind'],'character-token')

    def test_missing_supply_box_never_creates_a_signature_weapon(self):
        rows=[api_row(n,'四星武器',4,banner='行舟申领',weapon=True) for n in range(1,101)]
        rows[9].update(weaponName='孤舟',rarity=6)
        rows.append(api_row(102,'四星武器',4,banner='行舟申领',weapon=True))
        session=convert(api(rows))
        w=session['ledger']['weapon']
        self.assertEqual(w['potentialConfig']['counts'],[0,0,0,0,0])
        self.assertFalse(w['sections'][0]['signatureGifts'])
        self.assertEqual(session['documents'][0]['sourceSequenceGaps'][0]['rewardKind'],'weapon-supply-box')

    def test_standard_pool_does_not_have_limited_reward_nodes(self):
        rows=[api_row(n,banner='基础寻访') for n in range(1,61)]+[api_row(62,'莱万汀',6)]
        session=convert(api(rows))
        self.assertFalse(session['documents'][0]['sourceSequenceGaps'][0].get('candidateReward',False))
        self.assertFalse(session['ledger']['character']['completeHistory'])

    def test_unresolved_gap_revokes_inferred_milestone_gifts(self):
        rows=[api_row(n,'四星武器',4,banner='行舟申领',weapon=True) for n in range(1,182) if n!=10]
        rows[20].update(weaponName='孤舟',rarity=6)
        session=convert(api(rows))
        w=session['ledger']['weapon']
        self.assertNotIn('potentialConfig',w)
        self.assertFalse(w['sections'][0]['signatureGifts'])

    def test_v3_per_pool_sequence_reset_does_not_hide_internal_gap(self):
        definitions=[{'id':'a','name':'熔火灼痕','type':'limited'}, {'id':'b','name':'轻飘飘的信使','type':'limited'}]
        rows=[v3_row('a',1),v3_row('a',3,'莱万汀',6),v3_row('b',1),v3_row('b',2,'洁尔佩塔',6)]
        session=convert(v3(definitions,rows))
        self.assertFalse(session['ledger']['character']['completeHistory'])
        self.assertIn('structured_history_gap',[i['code'] for i in issues(session)])

    def test_v3_global_sequences_interleaved_with_standard_are_not_gaps(self):
        definitions=[{'id':'c','name':'熔火灼痕','type':'limited'}, {'id':'s','name':'基础寻访','type':'standard'}]
        rows=[v3_row('c',1),v3_row('s',2),v3_row('c',3,'莱万汀',6)]
        session=convert(v3(definitions,rows))
        self.assertFalse(session['documents'][0]['sourceSequenceGaps'])
        self.assertNotIn('structured_history_gap',[i['code'] for i in issues(session)])

    def test_v3_global_sequence_proves_later_pool_opening_without_start_time(self):
        definitions=[{'id':'a','name':'熔火灼痕','type':'limited'},
                     {'id':'b','name':'轻飘飘的信使','type':'limited'}]
        rows=[v3_row('a',1,'莱万汀',6)]+[v3_row('b',n) for n in range(2,62)]+[v3_row('b',63)]
        rows[30].update(name='洁尔佩塔',rarity=6)
        session=convert(v3(definitions,rows))
        gap=session['documents'][0]['sourceSequenceGaps'][0]
        self.assertEqual(gap['classification'],'omitted-reward-slot-at-confirmed-node')
        self.assertEqual((gap['rewardBanner'],gap['rewardAt']),('轻飘飘的信使',60))
        self.assertTrue(session['ledger']['character']['completeHistory'])
        self.assertNotIn('structured_history_gap',[i['code'] for i in issues(session)])

    def test_v3_global_opening_does_not_hide_earlier_internal_gap(self):
        definition={'id':'a','name':'熔火灼痕','type':'limited'}
        rows=[v3_row('a',n) for n in range(1,11)]+[v3_row('a',n) for n in range(12,62)]+[v3_row('a',63)]
        session=convert(v3([definition],rows))
        self.assertIn('structured_history_gap',[i['code'] for i in issues(session)])
        self.assertTrue(all(g['classification']=='unknown-missing-entries'
                            for g in session['documents'][0]['sourceSequenceGaps']))

    def test_v3_repeated_sequence_across_pools_is_not_duplicate_draw(self):
        definitions=[{'id':'c','name':'熔火灼痕','type':'limited'}, {'id':'s','name':'基础寻访','type':'standard'}]
        rows=[v3_row('c',1,'莱万汀',6),v3_row('s',1)]
        self.assertEqual(convert(v3(definitions,rows))['importSummary']['sourceRows'],2)
        with self.assertRaisesRegex(ValueError,'重复序号'):
            convert(v3(definitions,[rows[0],rows[0]]))

    def test_partial_weapon_scope_does_not_invent_unlisted_gifts(self):
        rows=[api_row(n,'四星武器',4,banner='行舟申领',weapon=True) for n in range(201,381)]
        rows[20].update(weaponName='孤舟',rarity=6)
        source={'uid':'demo-account','data':{'武器寻访-行舟申领':rows}}
        unknown=convert(source)
        self.assertNotIn('potentialConfig',unknown['ledger']['weapon'])
        confirmed=convert(source,confirmed_complete_pools=['行舟申领'])
        self.assertEqual(confirmed['ledger']['weapon']['potentialConfig']['counts'][0],1)
        self.assertEqual(confirmed['documents'][0]['userConfirmations']['fullPoolHistories'],['行舟申领'])

    def test_rush_uses_source_position_and_excludes_it_from_pity(self):
        rows=[api_row(n) for n in range(1,34)]
        rows += [api_row(n,'余烬' if n==34 else '四星角色',6 if n==34 else 4,isFree=True) for n in range(34,44)]
        rows.append(api_row(44,'莱万汀',6))
        p=convert(api(rows))['ledger']['character']['pools'][0]
        self.assertEqual((p['total'],p['rushAt'],p['events'][0]['at']),(34,33,34))
        self.assertEqual(p['rush'][0]['character'],'余烬')

    def test_partial_rush_remains_review_error(self):
        rows=[api_row(n) for n in range(1,31)]+[api_row(31,isFree=True)]
        self.assertIn('structured_partial_rush',[i['code'] for i in issues(convert(api(rows)))])

    def test_standard_weapon_without_six_is_auxiliary(self):
        source=api([api_row(1,'莱万汀',6),api_row(1,'四星武器',4,banner='星声申领',weapon=True)])
        session=convert(source)
        self.assertIsNone(session['ledger']['weapon'])
        self.assertEqual(len(session['documents'][0]['auxiliaryRecords']),1)

    def test_reprint_and_celebration_pools_are_retained_outside_scoring(self):
        session=convert(api([api_row(1,'莱万汀',6),
                             api_row(2,'伊冯',6,banner='绚丽异彩'),
                             api_row(3,'洁尔佩塔',6,banner='辉光庆典')]))
        pools=session['ledger']['character']['pools']
        self.assertEqual([(p['banner'],p['total'],len(p['events'])) for p in pools],[('熔火灼痕',1,1)])
        auxiliary=session['documents'][0]['auxiliaryRecords']
        self.assertEqual([a['scoreScope'] for a in auxiliary],['auxiliary-reprint','auxiliary-celebration'])
        self.assertEqual(len(session['documents'][0]['sourceRows']),3)
        self.assertIn('已跳过2个复刻／庆典池',session['importSummary']['message'])
        self.assertEqual(score_session_result(session['documents'],session['ledger'],{'enabled':False})['scoredAxes'],4)

    def test_explicit_reprint_and_celebration_types_override_reused_regular_names(self):
        for kind in ('rerun','reprint','celebration'):
            with self.subTest(kind=kind):
                definitions=[{'id':'main','name':'熔火灼痕','type':'limited','up_character':'莱万汀'},
                             {'id':'auxiliary','name':'熔火灼痕','type':kind,'up_character':'明河'}]
                session=convert(v3(definitions,[v3_row('main',1,'莱万汀',6),v3_row('auxiliary',2,'明河',6)]))
                self.assertEqual(len(session['ledger']['character']['pools']),1)
                self.assertEqual(session['ledger']['character']['pools'][0]['total'],1)
                self.assertTrue(session['documents'][0]['auxiliaryRecords'][0]['scoreScope'].startswith('auxiliary-'))

    def test_reprint_and_celebration_only_file_can_be_archived_without_a_score(self):
        session=convert(api([api_row(1,'伊冯',6,banner='绚丽异彩'),api_row(2,'洁尔佩塔',6,banner='辉光庆典')]))
        self.assertEqual(session['ledger']['character']['pools'],[])
        result=score_session_result(session['documents'],session['ledger'],{'enabled':False})
        self.assertEqual(result['scoredAxes'],0)
        self.assertTrue(all(axis['score'] is None for axis in result['axes'].values()))

    def test_ignored_pool_sequence_resets_do_not_block_regular_v3_records(self):
        definitions=[{'id':'main','name':'熔火灼痕','type':'limited'},
                     {'id':'rerun','name':'绚丽异彩','type':'rerun'},
                     {'id':'celebration','name':'辉光庆典','type':'celebration'}]
        rows=[v3_row(pid,seq,'莱万汀' if pid=='main' else '伊冯',6 if seq==1 else 4)
              for pid in ('main','rerun','celebration') for seq in (1,2)]
        session=convert(v3(definitions,rows))
        self.assertNotIn('structured_history_gap',[i['code'] for i in issues(session)])
        self.assertEqual(len(session['ledger']['character']['pools']),1)
        self.assertEqual(score_session_result(session['documents'],session['ledger'],{'enabled':False})['scoredAxes'],4)

    def test_missing_sequence_in_excluded_pools_does_not_block_regular_scores(self):
        session=convert(api([api_row(1,'莱万汀',6),api_row(2,'伊冯',6,banner='绚丽异彩'),
                             api_row(5,'伊冯',6,banner='绚丽异彩')]))
        self.assertNotIn('structured_history_gap',[i['code'] for i in issues(session)])
        self.assertEqual(session['documents'][0]['sourceSequenceGaps'][0]['classification'],'excluded-pool-gap')
        self.assertEqual(score_session_result(session['documents'],session['ledger'],{'enabled':False})['scoredAxes'],4)

    def test_profile_preserves_multiple_full_and_individual_overflow(self):
        rows=[]
        for banner,name,n in [('熔铸申领','熔铸火焰',7),('迅行申领','使命必达',8)]:
            for i in range(n):rows.append(api_row(len(rows)+1,name,6,banner=banner,weapon=True))
        config=convert(api(rows))['ledger']['weapon']['potentialConfig']
        self.assertEqual(config,{'totalTypes':2,'counts':[0,0,0,0,2],'overflowCopies':3,'overflowByType':[1,2]})

    def test_multiple_accounts_and_unsupported_structures_fail_clearly(self):
        invalid=[{},[],{'code':1,'data':{'list':[]}}, {'data':{'anything':42}},
                 {'formatId':'internal_json_v3','pools':[],'history':[],'accounts':[{},{}]}]
        for value in invalid:
            with self.assertRaises(ValueError):convert(value)
        for text in ('', 'not a draw record','{"a":NaN}','1,熔火灼痕,角色-5-1-0\n1,熔火灼痕,角色-5-1-0'):
            with self.assertRaises(ValueError):import_record_text(text)

    def test_source_is_not_mutated(self):
        source=api([api_row(1,'莱万汀',6)])
        before=json.dumps(source,sort_keys=True)
        session=convert(source)
        self.assertEqual(before,json.dumps(source,sort_keys=True))
        self.assertEqual(session['documents'][0]['sourceExport'],source)


if __name__=='__main__':
    unittest.main()
