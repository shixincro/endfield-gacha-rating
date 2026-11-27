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
    def test_first_limited_quantile_keeps_full_target_window_after_standard(self):
        a = pool(0, 50, [(30, 'UP')])
        b = pool(1, 70, [(20, STANDARD), (70, OFF)])
        result = score(a, b)
        self.assertEqual(result['total'], 11)
        self.assertEqual(result['pools'][0]['value'], 11)
        self.assertFalse(result['pending'])

    def test_second_limited_does_not_reprice_first_and_main_up_replaces_split(self):
        a = pool(0, 50, [(30, 'UP')])
        both_off = pool(1, 70, [(40, OFF), (70, OFF)])
        result = score(a, both_off)
        self.assertEqual([row['value'] for row in result['pools']], [20, 0])
        self.assertFalse(result['pending'])

        main_up = pool(1, 70, [(40, OFF), (70, 'UP')])
        result = score(a, main_up)
        self.assertAlmostEqual(result['total'], 11.14047297, places=7)
        self.assertAlmostEqual(result['pools'][0]['value'], 11.14047297, places=7)
        self.assertFalse(result['pending'])

    def test_first_natural_limited_cutoff_keeps_unspent_incremental_coupon(self):
        a = pool(0, 60, [(40, 'UP')])
        b = pool(1, 25, [(8, OFF), (25, OFF)])
        result = score(a, b)
        self.assertEqual(result['total'], 10)
        self.assertEqual([row['value'] for row in result['pools']], [10, 0])
        self.assertEqual(sum(entry['voucherCredit'] for entry in
                             result['pools'][0]['attributedSettlements']), 10)

    def test_three_red_credit_is_weighted_by_first_six_star_quantile(self):
        a = pool(0, 50, [(30, 'UP')])
        b = pool(1, 120, [(55, STANDARD), (100, STANDARD), (120, 'UP')])
        result = score(a, b)
        self.assertAlmostEqual(result['total'], 9.38201770, places=7)
        self.assertAlmostEqual(result['pools'][0]['value'], 9.38201770, places=7)
        self.assertAlmostEqual(sum(entry['characterValue'] for entry in
                                   result['pools'][0]['attributedSettlements']),
                               10.61798230, places=7)

    def test_rush_only_up_preserves_weighted_reference_water_for_next_pool(self):
        a = pool(0, 55, [(10, 'UP')])
        b = pool(1, 30, [(25, STANDARD)])
        b.update(rushUsed=True, rush=[{'character': b['up']}])
        c = pool(2, 55, [(55, 'UP')])
        self.assertTrue(score(a, b)['pending'])
        result = score(a, b, c)
        self.assertAlmostEqual(result['total'], 61.47286822, places=7)
        self.assertAlmostEqual(result['pools'][0]['value'], 61.47286822, places=7)
        self.assertEqual(result['pools'][2]['pendingPaid'], 0)

    def test_first_up_quantile_uses_one_incremental_voucher(self):
        for a_up, total, expected in [(20, 50, 16.90957247), (30, 60, 6.90957247)]:
            with self.subTest(coupon=total == 60):
                result = score(pool(0, total, [(a_up, 'UP')]),
                               pool(1, 100, [(20, STANDARD), (100, 'UP')]))
                self.assertAlmostEqual(result['total'], expected, places=7)

    def test_reference_coupon_does_not_survive_up_checkpoint(self):
        result = score(pool(0, 50, [(20, 'UP')]), pool(1, 44, [(44, 'UP')]),
                       pool(2, 95, [(25, STANDARD), (95, 'UP')]))
        self.assertAlmostEqual(result['pools'][0]['value'], 1.28797765, places=7)
        self.assertEqual([p['value'] for p in result['pools'][1:]], [0, 0])
        self.assertGreater(result['pools'][1]['settlements'][0]['referenceAt'], 60)
        next_up, = result['pools'][2]['settlements']
        self.assertEqual((next_up['referenceAt'], next_up['actualPaid'], next_up['referencePaid']),
                         (95, 85, 85))

    def test_one_voucher_funds_up_then_tail_then_extra_character(self):
        a = pool(0, 60, [(45, 'UP')])
        b = pool(1, 20, [(15, 'UP'), (18, STANDARD)])
        c = pool(2, 120, [(70, STANDARD), (119, STANDARD), (120, 'UP')])
        result = score(a, b, c)
        self.assertEqual([p['value'] for p in result['pools']], [-5, 0, 0])
        entries = result['pools'][0]['attributedSettlements']
        self.assertEqual([(e['settledPoolId'], e['voucherCredit'], e['characterValue'])
                          for e in entries if e['voucherCredit'] or e['characterValue']],
                         [(b['id'], 5, 0), (c['id'], 0, 15)])

    def test_voucher_credit_goes_to_earning_pool_not_using_pool(self):
        a = pool(0, 60, [(40, 'UP')])
        b = pool(1, 60, [(40, 'UP')])
        c = pool(2, 40, [(40, 'UP')])
        result = score(a, b, c)
        self.assertEqual([row['value'] for row in result['pools']], [10, 10, 0])
        self.assertEqual(result['total'], 20)
        for i in (0, 1):
            entry, = [e for e in result['pools'][i]['attributedSettlements'] if e['voucherCredit']]
            self.assertEqual((entry['settledPoolId'], entry['voucherCredit'], entry['value']),
                             (result['pools'][i+1]['id'], 10, 10))

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
                       pool(1, 120, [(55, OFF), (110, OFF), (120, 'UP')]))
        self.assertEqual([p['value'] for p in result['pools']], [-15.83, 0])

    def test_sixth_off_banner_copy_is_limited_but_seventh_is_standard(self):
        a = pool(0, 100, [(at, 'UP') for at in (20, 40, 60, 80, 100)])
        b = pool(1, 60, [(20, OFF), (60, OFF)])
        row = score(a, b)['pools'][1]
        self.assertEqual(row['value'], 40)
        self.assertEqual([(p['at'], p['type']) for p in row['settlements']],
                         [(20, '歪限定后停手'), (60, '常驻后停手')])
        self.assertEqual(row['tailWater'], 0)
        self.assertEqual(b['events'][-1]['character'], OFF)
        c = pool(2, 120, [(60, STANDARD), (120, 'UP')])
        result = score(a, b, c)
        part, = result['pools'][2]['settlements']
        self.assertEqual((part['actualPaid'], part['referencePaid']), (100, 110))
        self.assertEqual(result['pools'][1]['value'], 30)

    def test_guaranteed_token_can_complete_potential_before_later_off_banner_hit(self):
        hits = [(at, 'UP') for at in (40, 80, 120, 160, 200)]
        b = pool(1, 25, [(25, OFF)])
        self.assertEqual(score(pool(0, 239, hits), b)['pools'][1]['value'], 0)
        token = pool(0, 240, hits, tokens=[{'at': 240}])
        self.assertEqual(score(token, b)['pools'][1]['value'], 5)

    def test_capped_off_banner_hit_before_guarantee_has_standard_value(self):
        a = pool(0, 100, [(at, 'UP') for at in (20, 35, 50, 65, 80)])
        a.update(rushUsed=True, rush=[{'character': OFF}])
        b = pool(1, 120, [(55, STANDARD), (110, OFF), (120, 'UP')])
        result = score(a, b)
        self.assertEqual(result['total'], 5)
        part, = result['pools'][1]['settlements']
        self.assertEqual((part['type'], part['characterValue'], part['extraCharacter']),
                         ('首 UP 前额外常驻', 15, OFF))

    def test_rush_off_banner_overflow_does_not_create_a_stop(self):
        a = pool(0, 100, [(at, 'UP') for at in (20, 40, 60, 80, 100)])
        b = pool(1, 34, [(30, OFF)])
        b.update(rushUsed=True, rush=[{'character': OFF}])
        row = score(a, b)['pools'][1]
        self.assertEqual([(p['at'], p['type']) for p in row['settlements']],
                         [(30, '歪限定后停手')])
        self.assertEqual(row['pendingPaid'], 4)

    def test_current_up_still_settles_after_full_potential(self):
        a = pool(0, 140, [(at, 'UP') for at in range(20, 141, 20)])
        row = score(a)['pools'][0]
        self.assertEqual(row['value'], 0)
        self.assertEqual(row['settlements'][-1]['type'], '主池后续 UP')
        self.assertEqual(row['settlements'][-1]['at'], 140)

    def test_savings_and_extra_standard_both_count(self):
        a = pool(0, 60, [(45, 'UP')])
        b = pool(1, 20, [(15, 'UP')])
        c = pool(2, 119, [(70, STANDARD), (118, STANDARD), (119, 'UP')])
        self.assertEqual(score(a, b, c)['total'], -6)
        self.assertEqual(score(a, b, c, actualLossStandardValue=0)['total'], 9)

    def test_later_main_target_replaces_provisional_end_of_record_settlement(self):
        a = pool(0, 45, [(35, 'UP')])
        b = pool(1, 30, [(20, STANDARD)])
        c = pool(2, 30, [(30, 'UP')])
        provisional = score(a, b)
        self.assertEqual(provisional['total'], 20)
        self.assertEqual(provisional['pools'][1]['pendingPaid'], 10)
        self.assertTrue(provisional['pending'])
        settled = score(a, b, c)
        self.assertEqual(settled['total'], 30)
        self.assertEqual([row['value'] for row in settled['pools']], [10, 20, 0])
        self.assertEqual(settled['pools'][1]['settlements'], [])
        self.assertEqual(settled['pools'][2]['settlements'][0]['referenceAt'], 30)
        self.assertFalse(settled['pending'])

    def test_later_standard_is_not_covered_by_earlier_limited(self):
        result = score(pool(0, 25, [(15, '伊冯'), (20, STANDARD)]))
        self.assertEqual(result['total'], 5)
        self.assertTrue(result['pending'])

    def test_new_unknown_only_withholds_the_extra_limited_settlement(self):
        a = pool(0, 60, [(35, 'UP')])
        b = pool(1, 120, [(50, STANDARD), (110, '伊冯'), (120, 'UP')])
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
        provisional = score(first, second)
        row = provisional['pools'][1]
        self.assertEqual((row['value'], row['tailWater'], row['pendingPaid']), (0, 30, 10))
        self.assertEqual(row['warnings'], [])
        self.assertTrue(row['pending'])
        result = score(first, second, third)
        quote = result['pools'][2]['settlements'][0]
        self.assertAlmostEqual(quote['value'], .58412502, places=7)
        self.assertAlmostEqual(quote['referenceAt'], 47.41587498, places=7)
        self.assertFalse(result['pending'])

    def test_late_free_positions_are_applied_to_the_reference(self):
        a = pool(0, 60, [(45, 'UP')])
        b = pool(1, 30, [(15, 'UP')], freeDrawPositions=list(range(11, 31)))
        actual = score(a, b)['pools'][1]['settlements'][0]
        self.assertEqual((actual['actualPaid'], actual['referencePaid'], actual['value']), (10, 10, 15))

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
        self.assertAlmostEqual(score(a, b)['total'], 16.90957247, places=7)
        b.update(total=35, events=b['events'][:1])
        result = score(a, b)
        self.assertEqual(result['total'], 0)
        self.assertEqual(result['pools'][1]['pendingPaid'], 35)
        self.assertTrue(result['pending'])

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
        self.assertEqual(score_at_30['pools'][2]['settlements'][0]['value'], 45)
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
                         (0, 0, 24, []))
        unknown = score(a, dict(b, rushUsed=None, rush=[]))['pools'][1]
        self.assertIn('加急是否使用未知。', unknown['warnings'])
        before_unlock = dict(pool(0, 29, []), rushUsed=True, rush=[{'character': a['up']}])
        inconsistent = score(before_unlock)['pools'][0]
        self.assertIn('主池未达30抽但记录加急已使用。', inconsistent['warnings'])

    def test_rush_off_does_not_interrupt_first_up_replay_but_counts_for_new(self):
        a = pool(0, 55, [(35, 'UP')])
        b = pool(1, 120, [(55, STANDARD), (110, '卡缪'), (120, 'UP')])
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
