"""Production dual metrics: deterministic examples and ownership/source boundaries."""
import copy
import math
import unittest

from planning import score_planning, TABLE_FILE
import opportunity


def fixture(total, events=(), *, owned=(), free=20, rush=(), initial=0):
    main = [{'at': at, 'character': name, 'forced': False, 'source': 'main'} for at, name in events]
    tail = total - max((e['at'] for e in main), default=-initial)
    p = {'id': 'test', 'index': 8, 'banner': '临渊望北', 'up': '诀', 'total': total,
         'initialPity': initial, 'tail': tail, 'events': main, 'rushUsed': total >= 30,
         'rushAt': 30 if total >= 30 else None, 'rush': [{'character': name} for name in rush],
         'tokens': [{'at': at} for at in range(240, total+1, 240)], 'ended': True,
         'freeAllowance': free, 'issues': []}
    return {'pools': [p], 'completeHistory': False, 'initialPity': initial,
            'initialOwned': None if owned is None else list(owned)}


def forward_quote(t, n, free, rush, apply_policy=True):
    """Independent forward mass/paid-cost flow, including post-hit free draws."""
    active={(n,rush):(1.,0.)};finished=[]

    def finish(mass, spent, at, age):
        stop=max(free,60 if 46<=at<=59 else at) if apply_policy else at
        endpoints={age:(mass,spent)}
        for step in range(at+1,stop+1):
            following={}
            for pity,(weight,cost) in endpoints.items():
                chance=1. if pity==79 else .008 if pity<65 else .008+.05*(pity-64)
                for dest,p in ((0,chance),(min(pity+1,79),1-chance)):
                    if not p:continue
                    a,b=following.get(dest,(0.,0.))
                    following[dest]=(a+weight*p,b+(cost+weight*(step>free))*p)
            endpoints=following
        for pity,(weight,cost) in endpoints.items():
            finished.append((weight,cost,weight*opportunity.terminal_quote(stop,pity)))

    for at in range(t,120):
        before={}
        for (age,rush_available),(mass,spent) in active.items():
            if rush_available and at>=30:
                p=1-.996**10
                finish(mass*p,spent*p,at,age)
                mass*=1-p;spent*=1-p;rush_available=False
            a,b=before.get((age,rush_available),(0.,0.))
            before[(age,rush_available)]=(a+mass,b+spent)
        active={}
        for (age,rush_available),(mass,spent) in before.items():
            step=at+1;spent+=mass*(step>free)
            if step==120:
                finish(mass,spent,step,0);continue
            p=1. if age==79 else .008 if age<65 else .008+.05*(age-64)
            finish(mass*p/2,spent*p/2,step,0)
            for dest,chance in ((0,p/2),(min(age+1,79),1-p)):
                if not chance:continue
                key=(dest,rush_available);a,b=active.get(key,(0.,0.))
                active[key]=(a+mass*chance,b+spent*chance)
    return tuple(sum(x[i] for x in finished) for i in range(3))


class DualPlanningTests(unittest.TestCase):
    def row(self, data):
        before = copy.deepcopy(data)
        result = score_planning(data)
        self.assertEqual(data, before, 'scoring must not change real identities or source ledger')
        return result['pools'][0]

    def test_validated_examples(self):
        cases = [
            (fixture(20), 0, 0),
            (fixture(30), 4.9826825969, 1.3404073991),
            (fixture(30, [(30, '诀')]), 0, 0),
            (fixture(30, [(30, '卡缪')]), 0, .2012596164),
            (fixture(50, [(50, '卡缪')]), 2.8513327191, 10.0790808946),
            (fixture(60, [(50, '卡缪')]), 0, 4.9110465778),
            (fixture(70, [(70, '卡缪')]), 0, 16.0780670871),
            (fixture(70, [(70, '卡缪')], owned=('卡缪',)), 47.8888743482, 16.0780670871),
            (fixture(70, [(70, '别礼')]), 47.8888743482, 16.0780670871),
            (fixture(60), 10.6900087145, 4.0132180152),
            (fixture(119, [(55, '别礼'), (119, '卡缪')]), 0, 60.4774544180),
            (fixture(30, rush=('诀',)), 0, 0),
            (fixture(50, [(30, '卡缪'), (50, '卡缪')]), 20, 10.0790808946),
        ]
        for data, a, b in cases:
            with self.subTest(data=data):
                row = self.row(data)
                self.assertEqual(row['status'], 'ok')
                self.assertAlmostEqual(row['localLoss'], a, places=8)
                self.assertAlmostEqual(row['opportunity']['value'], b, places=8)

    def test_unknown_new_is_not_zero_or_current_up(self):
        row = self.row(fixture(70, [(70, '卡缪')], owned=None))
        self.assertIsNone(row['localLoss'])
        self.assertEqual(row['status'], 'partial')
        self.assertEqual(row['unknownNewPositions'], [70])
        self.assertIsNone(row['opportunity']['value'])
        row = self.row(fixture(40, [(30, '卡缪'), (40, '诀')], owned=None))
        self.assertEqual(row['localLoss'], 0)
        self.assertEqual(row['opportunity']['value'], 0)

    def test_new_uncertainty_does_not_suppress_independently_known_b(self):
        data = fixture(70, [(70, '卡缪')], owned=None)
        first = copy.deepcopy(data['pools'][0])
        first.update(id='prior', index=7, total=20, tail=0, up='卡缪', rushUsed=False,
                     rushAt=None, events=[{'at':20,'character':'诀','source':'main'}])
        data['pools'].insert(0, first)
        row = score_planning(data)['pools'][1]
        self.assertIsNone(row['localLoss'])
        self.assertEqual(row['opportunity']['value'], 0)

    def test_new_anchor_identity_and_same_position_order(self):
        row = self.row(fixture(30, [(30, '卡缪')], rush=('卡缪',)))
        self.assertEqual(row['anchor']['character'], '卡缪')
        self.assertEqual(row['anchor']['kind'], 'new-limited')
        self.assertEqual(len(row['newLimitedHits']), 1)
        self.assertEqual(row['anchor']['source'], 'main')

    def test_target_preowned_does_not_force_potential(self):
        row = self.row(fixture(60, owned=('诀',)))
        self.assertEqual(row['opportunity']['value'], 0)
        self.assertEqual(row['opportunity']['reason'], 'target-already-obtained')

    def test_source_errors_remain_unknown(self):
        for change in ({'complete': False}, {'tail': 12}, {'rushUsed': None}):
            data = fixture(60)
            data['pools'][0].update(change)
            row = self.row(data)
            self.assertIsNone(row['opportunity']['value'])
            self.assertNotEqual(row['opportunity']['status'], 'ok')

    def test_gap_invalidates_absence_but_preserves_observed_ownership(self):
        data = fixture(30, [(30, '卡缪')])
        second = copy.deepcopy(data['pools'][0])
        second.update(id='later', index=10, up='提弗洛斯', events=[{'at':30,'character':'梨诺','source':'main'}])
        data['pools'].append(second)
        row = score_planning(data)['pools'][1]
        self.assertIsNone(row['localLoss'])
        self.assertIsNone(row['opportunity']['value'])

    def test_summary_is_two_independent_sums(self):
        result = score_planning(fixture(70, [(70, '卡缪')]))
        self.assertEqual(result['summary']['localLossSignedSum'], 0)
        self.assertEqual(result['summary']['title'], '自律狂人')
        self.assertAlmostEqual(result['summary']['opportunity']['total'], 16.0780670871)
        empty = score_planning({'pools': [], 'initialOwned': []})
        self.assertIsNone(empty['summary']['opportunity']['total'])
        self.assertIsNone(empty['summary']['title'])

    def test_dp_matches_fixed_table_without_topup(self):
        import json
        table = json.loads(TABLE_FILE.read_text(encoding='utf-8'))
        for row in table['rows']:
            for free in (10, 20):
                actual = opportunity.first_up(0, row['pity'], free, True, False)
                self.assertAlmostEqual(actual[0], row['free'+str(free)], places=10)

    def test_dp_mechanical_boundaries(self):
        a = opportunity.first_up(119, 79, 20, False)
        self.assertEqual(a[0:2], (1, 1))
        self.assertEqual(a[2], opportunity.terminal_quote(120, 0))
        expected = (1-(1-.004)**50)/.004
        self.assertAlmostEqual(opportunity.first_up(70, 0, 20, False)[0], expected, places=10)
        self.assertTrue(all(math.isfinite(x) for x in opportunity.first_up(0, 79, 10, True)))

    def test_free_new_limited_also_finishes_free_allowance(self):
        for owned in ((),None):
            data=fixture(20,[(5,'卡缪')],owned=owned)
            row=self.row(data)
            self.assertEqual(row['idealStop'],20)
            self.assertEqual(row['localLoss'],0)
            self.assertEqual(row['opportunity']['value'],0)
        row=self.row(fixture(8,[(5,'卡缪')]))
        self.assertEqual(row['idealStop'],20)
        self.assertGreater(row['localLoss'],0)

    def test_post_hit_free_draws_have_zero_paid_cost(self):
        for free in (10,20):
            paid,draws,terminal=opportunity.after_hit(5,0,free)
            self.assertEqual(paid,0)
            self.assertAlmostEqual(draws,free-5)
            self.assertLess(terminal,opportunity.terminal_quote(5,0))

    def test_dp_free_policy_matches_independent_forward_mass_flow(self):
        states=[(0,0,10,True),(0,79,20,True),(20,20,20,True),(30,30,20,False),
                (45,12,20,False),(50,0,20,False),(70,0,20,False),(119,79,20,False)]
        for state in states:
            for policy in (False,True):
                mass,paid,terminal=forward_quote(*state,policy)
                result=opportunity.first_up(*state,policy)
                self.assertAlmostEqual(mass,1,places=10)
                self.assertAlmostEqual(result[0],paid,places=9)
                self.assertAlmostEqual(result[2],terminal,places=9)


if __name__ == '__main__':
    unittest.main()
