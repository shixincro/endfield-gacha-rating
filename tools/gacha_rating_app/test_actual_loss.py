import unittest

from actual_loss import score_actual_loss
from importer import BANNERS


SCHEDULE = list(BANNERS.items())
STANDARD = '黎风'
OFF = '莱万汀'


def pool(index, total, hits, **settings):
    banner, up = SCHEDULE[index]
    return dict(id=f'banner-{index}', index=index, banner=banner, up=up,
                total=total, rushUsed=False,
                events=[{'at': at, 'character': up if name == 'UP' else name}
                        for at, name in hits], **settings)


def score(*pools, **settings):
    result = score_actual_loss({'initialOwned': [], 'pools': list(pools), **settings})
    if result['total'] is not None:
        displayed = sum(row['value'] for row in result['pools'] if row['value'] is not None)
        if round(displayed - result['total'], 7) != 0:
            raise AssertionError('source pools do not reconcile to the account total')
    return result


class ActualLossTests(unittest.TestCase):
    def test_simple_120_excess_and_voucher(self):
        for a_up, total, expected in [(20, 50, 10), (30, 60, 0)]:
            with self.subTest(coupon=total == 60):
                result = score(pool(0, total, [(a_up, 'UP')]),
                               pool(1, 100, [(20, STANDARD), (100, 'UP')]))
                self.assertEqual(result['total'], expected)

    def test_reference_coupon_does_not_survive_up_checkpoint(self):
        result = score(pool(0, 45, [(35, 'UP')]), pool(1, 60, [(55, 'UP')]),
                       pool(2, 95, [(25, STANDARD), (95, 'UP')]))
        self.assertEqual([p['value'] for p in result['pools']], [0, -10, 0])
        self.assertEqual(result['pools'][1]['settlements'][0]['referenceAt'], 65)

    def test_one_voucher_funds_up_then_tail_then_extra_character(self):
        a = pool(0, 60, [(45, 'UP')])
        b = pool(1, 20, [(15, 'UP'), (18, STANDARD)])
        c = pool(2, 120, [(40, STANDARD), (118, STANDARD), (120, 'UP')])
        result = score(a, b, c)
        self.assertEqual([p['value'] for p in result['pools']], [-20, 0, 0])
        entries = result['pools'][0]['attributedSettlements']
        self.assertEqual([(e['settledPoolId'], e['voucherCredit'], e['characterValue'])
                          for e in entries if e['voucherCredit'] or e['characterValue']],
                         [(b['id'], 5, 0), (c['id'], 0, 15)])

    def test_voucher_credit_goes_to_earning_pool_not_using_pool(self):
        a = pool(0, 60, [(40, 'UP')])
        b = pool(1, 60, [(37, 'UP')])
        c = pool(2, 120, [(2, STANDARD), (72, STANDARD), (92, STANDARD), (120, 'UP')])
        result = score(a, b, c)
        self.assertEqual([row['value'] for row in result['pools']], [-10, 13, 0])
        self.assertEqual(result['total'], 3)
        for i, value in ((0, -10), (1, 13)):
            entry, = [e for e in result['pools'][i]['attributedSettlements'] if e['voucherCredit']]
            self.assertEqual((entry['settledPoolId'], entry['voucherCredit'], entry['value']),
                             (result['pools'][i+1]['id'], 10, value))

    def test_shared_character_value_is_split_by_contributing_water(self):
        a = pool(0, 45, [(35, 'UP')])
        b = pool(1, 20, [])
        c = pool(2, 120, [(40, STANDARD), (110, STANDARD), (120, 'UP')])
        result = score(a, b, c)
        self.assertEqual([row['value'] for row in result['pools']], [2.5, 2.5, 0])
        self.assertEqual(result['total'], 5)
        self.assertEqual(result['pools'][2]['settlements'][0]['characterValue'], 15)
        for row in result['pools'][:2]:
            entry, = [e for e in row['attributedSettlements'] if e['characterValue']]
            self.assertEqual((entry['settledPoolId'], entry['characterValue']), (c['id'], 7.5))

    def test_last_limited_stop_recognizes_local_path_only(self):
        a = pool(0, 45, [(35, 'UP')])
        b = pool(1, 40, [(20, STANDARD), (40, OFF)])
        self.assertEqual(score(a, b)['total'], 10)

    def test_first_off_limited_does_not_skip_last_off_limited(self):
        result = score(pool(0, 55, [(35, 'UP')]),
                       pool(1, 120, [(40, OFF), (110, OFF), (120, 'UP')]))
        self.assertEqual([p['value'] for p in result['pools']], [-15.83, 0])

    def test_savings_and_extra_standard_both_count(self):
        a = pool(0, 60, [(45, 'UP')])
        b = pool(1, 20, [(15, 'UP')])
        c = pool(2, 117, [(40, STANDARD), (116, STANDARD), (117, 'UP')])
        self.assertEqual(score(a, b, c)['total'], -23)
        self.assertEqual(score(a, b, c, actualLossStandardValue=0)['total'], -8)

    def test_default_stop_settles_closed_path_and_carries_tail(self):
        a = pool(0, 45, [(35, 'UP')])
        b = pool(1, 30, [(20, STANDARD)])
        c = pool(2, 30, [(30, 'UP')])
        settled = score(a, b, c)
        self.assertEqual(settled['total'], 20)
        self.assertEqual(settled['pools'][2]['settlements'][0]['referenceAt'], 40)
        self.assertFalse(settled['pending'])

    def test_later_standard_is_not_covered_by_earlier_limited(self):
        result = score(pool(0, 25, [(15, '伊冯'), (20, STANDARD)]))
        self.assertEqual(result['total'], 5)
        self.assertTrue(result['pending'])

    def test_new_unknown_only_withholds_the_extra_limited_settlement(self):
        a = pool(0, 60, [(35, 'UP')])
        b = pool(1, 120, [(40, STANDARD), (110, '伊冯'), (120, 'UP')])
        unresolved = score(a, b, initialOwned=None)
        self.assertEqual(unresolved['total'], 0)
        self.assertEqual(unresolved['partialPools'], 1)
        self.assertIsNone(unresolved['pools'][1]['value'])
        self.assertEqual(score(a, b)['total'], -36.66)

    def test_legacy_stop_field_cannot_prevent_settlement(self):
        a = pool(0, 35, [(30, STANDARD)], actualLossStopAt=30)
        self.assertEqual(score(a)['total'], 20)

    def test_no_six_star_stop_shows_zero_settled_and_keeps_paid_water(self):
        first = pool(0, 70, [(70, 'UP')])
        second = pool(1, 30, [])
        third = pool(2, 38, [(38, 'UP')])
        result = score(first, second, third)
        row = result['pools'][1]
        self.assertEqual((row['value'], row['tailWater'], row['pendingPaid']), (0, 30, 10))
        self.assertEqual(row['warnings'], [])
        self.assertTrue(row['pending'])
        quote = result['pools'][2]['settlements'][0]
        self.assertEqual((quote['value'], quote['referenceAt']), (0, 48))

    def test_late_free_positions_are_applied_to_the_reference(self):
        a = pool(0, 60, [(45, 'UP')])
        b = pool(1, 30, [(15, 'UP')], freeDrawPositions=list(range(11, 31)))
        actual = score(a, b)['pools'][1]['settlements'][0]
        self.assertEqual((actual['actualPaid'], actual['referencePaid'], actual['value']), (10, 20, 5))

    def test_token_protects_only_water_at_the_reward(self):
        a = pool(0, 250, [(20, 'UP'), (65, 'UP'), (135, 'UP'), (200, 'UP')], tokens=[{'at': 240}])
        b = pool(1, 20, [(20, STANDARD)])
        result = score(a, b)
        self.assertEqual(result['total'], 10)
        self.assertEqual(result['pools'][0]['settlements'][-1]['type'], '信物保护水位')

    def test_rush_up_is_ignored_when_a_main_first_up_is_observed(self):
        a = pool(0, 50, [(20, 'UP')])
        b = pool(1, 100, [(20, STANDARD), (100, 'UP')], rushAt=30)
        b.update(rushUsed=True, rush=[{'character': b['up']}])
        self.assertEqual(score(a, b)['total'], 10)
        b.update(total=35, events=b['events'][:1])
        self.assertEqual(score(a, b)['total'], 30)

    def test_default_rush_at_30_settles_the_120_up_voucher_case(self):
        a = pool(0, 60, [(37, 'UP')])
        b = pool(1, 120, [(2, STANDARD), (72, STANDARD), (92, STANDARD), (120, 'UP')],
                 rushAt=30, rushTimingEvidence='user-default-after-main-30')
        b.update(rushUsed=True, rush=[{'character': '卡缪'}])
        unknown = score(a, b)
        self.assertEqual(unknown['total'], 13)
        self.assertEqual(unknown['partialPools'], 0)
        row = unknown['pools'][1]
        self.assertEqual((row['value'], row['tailWater'], row['warnings']), (0, 0, []))
        self.assertEqual(unknown['pools'][0]['value'], 13)
        self.assertEqual([(s['at'], s['type'], s['value']) for s in row['settlements']],
                         [(120, '首 UP 自费差', 13)])
        self.assertEqual(b['rushTimingEvidence'], 'user-default-after-main-30')
        without_timing = dict(b, rushAt=None, rushTimingEvidence=None)
        self.assertEqual(score(a, without_timing), unknown)

    def test_rush_timing_metadata_does_not_move_settlement_after_30(self):
        a = pool(0, 30, [(30, 'UP')])
        b = pool(1, 75, [(60, STANDARD)], rushAt=30,
                 rushTimingEvidence='user-default-after-main-30')
        b.update(rushUsed=True, rush=[{'character': a['up']}])
        c = pool(2, 20, [(20, STANDARD)])
        score_at_30 = score(a, b, c)
        self.assertEqual(score_at_30['partialPools'], 0)
        self.assertEqual(score_at_30['pools'][1]['value'], 45)
        self.assertEqual(score_at_30['pools'][2]['settlements'][0]['value'], 15)
        for at in (60, 70):
            self.assertEqual(score(a, dict(b, rushAt=at, rushTimingEvidence='explicit'), c),
                             score_at_30)

    def test_rush_follows_same_draw_main_hit_and_still_checks_source_evidence(self):
        a = pool(0, 55, [(35, 'UP')])
        b = pool(1, 34, [(30, STANDARD)])
        b.update(rushUsed=True, rush=[{'character': b['up']}])
        rows = score(a, b)['pools']
        row = rows[1]
        self.assertEqual((rows[0]['value'], row['value'], row['pendingPaid'], row['warnings']),
                         (20, 0, 4, []))
        unknown = score(a, dict(b, rushUsed=None, rush=[]))['pools'][1]
        self.assertIn('加急是否使用未知。', unknown['warnings'])
        before_unlock = dict(pool(0, 29, []), rushUsed=True, rush=[{'character': a['up']}])
        inconsistent = score(before_unlock)['pools'][0]
        self.assertIn('主池未达30抽但记录加急已使用。', inconsistent['warnings'])

    def test_rush_off_does_not_interrupt_first_up_replay_but_counts_for_new(self):
        a = pool(0, 55, [(35, 'UP')])
        b = pool(1, 120, [(5, STANDARD), (70, STANDARD), (110, '卡缪'), (120, 'UP')])
        baseline = score(a, b)
        self.assertEqual(baseline['pools'][0]['value'], -31.66)
        different = dict(b, rushUsed=True, rush=[{'character': '伊冯'}])
        self.assertEqual(score(a, different), baseline)
        same = dict(b, rushUsed=True, rush=[{'character': '卡缪'}])
        rows = score(a, same)['pools']
        row = rows[1]
        self.assertEqual((rows[0]['value'], row['value'], row['warnings']), (-15.83, 0, []))
        self.assertEqual([(s['at'], s['type']) for s in row['settlements']],
                         [(120, '首 UP 前额外歪限定')])

    def test_rush_off_cannot_protect_draws_after_a_main_up(self):
        a = pool(0, 30, [(30, 'UP')])
        b = pool(1, 45, [(20, 'UP'), (40, STANDARD)])
        with_rush = dict(b, rushUsed=True, rush=[{'character': '卡缪'}])
        baseline = score(a, b)['pools'][1]
        self.assertEqual(baseline['value'], 20)
        self.assertEqual(score(a, with_rush)['pools'][1], baseline)

    def test_free_tail_up_has_no_implied_paid_chase(self):
        a = pool(0, 60, [(50, 'UP')])
        b = pool(1, 20, [(5, 'UP'), (18, 'UP')])
        result = score(a, b)
        self.assertEqual(result['pools'][1]['settlements'][-1]['value'], 0)


if __name__ == '__main__':
    unittest.main()
