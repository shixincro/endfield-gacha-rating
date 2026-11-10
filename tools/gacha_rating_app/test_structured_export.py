"""Deterministic regression for v3 weapon reward normalization."""
import copy
import unittest
from structured_export import split_weapon_records


def fixture(total=340):
    rows=[]
    for at in range(1,total+1):
        batch=f'batch-{(at-1)//10}'
        rows.append({'id':f'draw-{at}','batchId':batch,'rarity':6 if at==80 else 4,
                     'name':'当期专武' if at==80 else '普通武器'})
        if at>=100 and (at-100)%80==0:
            rows.append({'id':f'reward-{at}','batchId':batch,'rarity':4,
                         'name':'补充武库箱·测试' if (at-100)%160==0 else '当期专武'})
    return rows


class WeaponRewardTests(unittest.TestCase):
    def test_four_rewards_do_not_increment_draws_or_random_six_count(self):
        rows=fixture();before=copy.deepcopy(rows)
        draws,gifts=split_weapon_records(rows,'当期专武')
        self.assertEqual(len(draws),340)
        self.assertEqual([r['at'] for r in gifts],[100,180,260,340])
        self.assertEqual(sum(r['rarity']==6 for r in draws),1)
        self.assertEqual(sum(r['name']=='当期专武' for r in draws),1)
        self.assertEqual(rows,before)
        self.assertEqual([r['sourceRow']['rarity'] for r in gifts],[4]*4)

    def test_explicit_six_gifts_are_also_excluded(self):
        rows=fixture(100)
        rows[-1].update(specialType='gift',rarity=6,name='直接赠送六星')
        draws,gifts=split_weapon_records(rows,'当期专武')
        self.assertEqual(len(draws),100)
        self.assertEqual(gifts[0]['classificationMethod'],'source-specialType')

    def test_real_tenth_up_at_milestone_is_not_a_gift(self):
        rows=[r for r in fixture(180) if not r['id'].startswith('reward-')]
        rows[-1].update(name='当期专武',rarity=6)
        draws,gifts=split_weapon_records(rows,'当期专武')
        self.assertEqual(len(draws),180)
        self.assertEqual(gifts,[])
        self.assertEqual(draws[-1]['rarity'],6)

    def test_wrong_node_name_or_batch_does_not_silently_drop_a_record(self):
        for change in ({'name':'别的武器'},{'batchId':'different-batch'}):
            rows=fixture(100);rows[-1].update(change)
            draws,gifts=split_weapon_records(rows,'当期专武')
            self.assertEqual(len(draws),101)
            self.assertEqual(gifts,[])
        rows=fixture(100);rows[-1]['name']='当期专武'
        draws,gifts=split_weapon_records(rows,'当期专武')
        self.assertEqual(len(draws),101)
        self.assertEqual(gifts,[])

    def test_regular_draw_positions_no_longer_include_reward_offsets(self):
        rows=fixture()
        next(r for r in rows if r['id']=='draw-220').update(rarity=6,name='别的六星')
        draws,_=split_weapon_records(rows,'当期专武')
        positions=[i+1 for i,r in enumerate(draws) if r['rarity']==6]
        self.assertEqual(positions,[80,220])

    def test_later_nodes_are_not_limited_to_first_340_draws(self):
        draws,gifts=split_weapon_records(fixture(500),'当期专武')
        self.assertEqual(len(draws),500)
        self.assertEqual([r['at'] for r in gifts],[100,180,260,340,420,500])
        self.assertEqual(gifts[-2]['rewardKind'],'weapon-supply-box')
        self.assertEqual(gifts[-1]['rewardKind'],'milestone-signature')


if __name__=='__main__':
    unittest.main()
