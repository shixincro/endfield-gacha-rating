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
            (fixture(30), 4.9826825969, 0),
            (fixture(30, [(30, '诀')]), 0, 0),
            (fixture(30, [(30, '卡缪')]), 0, 0),
            (fixture(50, [(50, '卡缪')]), 2.8513327191, .9576659889),
            (fixture(60, [(50, '卡缪')]), 0, 5.2856577233),
            (fixture(70, [(70, '卡缪')]), 0, 16.4584983165),
            (fixture(70, [(70, '卡缪')], owned=('卡缪',)), 47.8888743482, 16.4584983165),
            (fixture(70, [(70, '别礼')]), 47.8888743482, 16.4584983165),
            (fixture(60), 10.6900087145, 2.0405924831),
            (fixture(119, [(55, '别礼'), (119, '卡缪')]), 0, 60.8578856475),
            (fixture(30, rush=('诀',)), 0, 0),
            (fixture(50, [(30, '卡缪'), (50, '卡缪')]), 20, .9576659889),
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
        self.assertAlmostEqual(row['opportunity']['value'], 16.4584983165)
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
        self.assertAlmostEqual(row['opportunity']['value'], 16.4584983165)

    def test_new_anchor_identity_and_same_position_order(self):
        row = self.row(fixture(30, [(30, '卡缪')], rush=('卡缪',)))
        self.assertEqual(row['anchor']['character'], '卡缪')
        self.assertEqual(row['anchor']['kind'], 'new-limited')
        self.assertEqual(len(row['newLimitedHits']), 1)
        self.assertEqual(row['anchor']['source'], 'main')

    def test_main_up_closes_guarantee_but_ownership_and_rush_up_do_not(self):
        reference = self.row(fixture(30))['opportunity']
        self.assertEqual((reference['status'], reference['reason']), ('ok', 'estimated'))
        self.assertGreater(reference['rawCostDifference'], 0)
        for owned in (None, (), ('诀',)):
            for rush in ((), ('诀',)):
                with self.subTest(owned=owned, rush=rush):
                    self.assertEqual(self.row(fixture(30, owned=owned, rush=rush))
                                     ['opportunity'], reference)
        main_up = self.row(fixture(30, [(30, '诀')]))['opportunity']
        self.assertEqual((main_up['reason'], main_up['value']), ('main-up-already-obtained', 0))

    def test_opportunity_moves_from_120_to_each_next_token(self):
        hits = [(58, '别礼'), (112, '别礼'), (120, '诀'), (170, '卡缪'), (230, '别礼'),
                (288, '别礼'), (345, '卡缪'), (400, '别礼'), (459, '别礼')]
        for total, deadline in ((119, 120), (120, 240), (239, 240), (240, 480), (480, 720)):
            with self.subTest(total=total):
                row = self.row(fixture(total, [hit for hit in hits if hit[0] <= total]))
                self.assertEqual(row['opportunity']['deadline'], deadline)
                self.assertEqual(row['opportunity']['reason'], 'estimated' if total<120 else 'token-vs-flat')

    def test_full_potential_uses_confirmed_copies_but_only_after_120(self):
        hits = [(20, '诀'), (60, '诀'), (120, '诀'), (180, '诀'), (235, '诀')]
        with_token = self.row(fixture(240, hits))['opportunity']
        self.assertEqual((with_token['reason'], with_token['value']), ('target-full-potential', 0))
        self.assertEqual(self.row(fixture(240, hits[1:]))['opportunity']['deadline'], 480)
        at_239 = self.row(fixture(239, hits, owned=('诀',)))['opportunity']
        self.assertEqual(at_239['reason'], 'target-full-potential')
        with_rush = self.row(fixture(239, hits, rush=('诀',)))['opportunity']
        self.assertEqual(with_rush['reason'], 'target-full-potential')
        early = self.row(fixture(110, [(i, '诀') for i in range(10, 61, 10)]))['opportunity']
        self.assertEqual(early['reason'], 'main-up-already-obtained')

    def test_token_uses_paid_cost_vs_flat_less_retained_pity_value(self):
        hits = [(60, '别礼'), (120, '诀'), (180, '别礼')]
        far = self.row(fixture(120, hits[:2]))['opportunity']
        self.assertGreater(far['stay']['paid'], 61.85788564745958)
        self.assertEqual(far['value'], 0)
        next_draw = self.row(fixture(239, hits))['opportunity']
        self.assertEqual(next_draw['stay']['paid'], 1)
        self.assertAlmostEqual(next_draw['rawCostDifference'], 60.85788564745958)
        self.assertAlmostEqual(next_draw['waterSaving'], 26.9324026329)
        self.assertAlmostEqual(next_draw['value'], 33.9254830146)
        reset = self.row(fixture(239, [*hits, (239, '别礼')]))['opportunity']
        self.assertEqual(reset['waterSaving'], 0)
        self.assertAlmostEqual(reset['value'], 60.85788564745958)
        self.assertNotIn('terminal', next_draw['stay'])
        self.assertAlmostEqual(opportunity.paid_to_up_or_token(2, 0), 1.996)

    def test_live_guarantee_uses_first_hit_paid_cost_vs_the_same_flat_benchmark(self):
        for data, state in ((fixture(25), (25, 25, 20, True)),
                            (fixture(50, [(50, '卡缪')]), (50, 0, 20, False))):
            with self.subTest(state=state):
                quote = self.row(data)['opportunity']
                _, paid, _ = forward_quote(*state, apply_policy=False)
                _, paid_with_topup, _ = forward_quote(*state, apply_policy=True)
                self.assertGreater(paid_with_topup, paid)
                self.assertAlmostEqual(quote['stay']['paid'], paid)
                self.assertEqual(quote['benchmark']['paid'], 61.85788564745958)
                expected_water = opportunity.terminal_quote(0,0)-opportunity.terminal_quote(0,state[1])
                self.assertAlmostEqual(quote['waterSaving'], expected_water)
                self.assertAlmostEqual(quote['value'], max(0, 61.85788564745958-paid-expected_water))
                self.assertNotIn('terminal', quote['stay'])
                self.assertNotIn('switch', quote)

    def test_retained_pity_uses_same_next_banner_free_allowance_on_both_sides(self):
        before = self.row(fixture(59, initial=1))['opportunity']
        after = self.row(fixture(60))['opportunity']
        self.assertAlmostEqual(before['waterSaving'], 31.1998349825)
        self.assertAlmostEqual(after['waterSaving'], 27.1988656336)

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
        self.assertEqual(row['opportunity']['status'], 'ok')
        self.assertEqual(row['opportunity']['value'], 0)

    def test_summary_is_two_independent_sums(self):
        result = score_planning(fixture(70, [(70, '卡缪')]))
        self.assertEqual(result['summary']['localLossSignedSum'], 0)
        self.assertEqual(result['summary']['title'], '自律狂人')
        self.assertAlmostEqual(result['summary']['opportunity']['total'], 16.4584983165)
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
