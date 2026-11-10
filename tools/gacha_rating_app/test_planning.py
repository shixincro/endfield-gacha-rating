"""Deterministic boundary tests; no MC and no source-workbook modification."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from planning import TABLE_FILE, score_planning, loss_title


def event(at, who="目标", **extra):
    return {"at": at, "character": who, "source": "main", "forced": False, **extra}


def pool(total, events=(), **extra):
    result = {"id": "p0", "banner": "测试", "index": 0, "up": "目标", "total": total,
              "initialPity": 0, "events": list(events), "rushUsed": total >= 30,
              "rush": [], "rushAt": None, "tokens": [], "ended": True}
    result.update(extra)
    return result


def run(*pools):
    return score_planning({"pools": list(pools), "initialPity": 0,
                           "initialOwned": [], "completeHistory": True, "issues": []})


class PlanningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.table = json.loads(TABLE_FILE.read_text(encoding="utf-8"))
        cls.v = {r["pity"]: r for r in cls.table["rows"]}

    def test_source_and_table_bounds(self):
        self.assertEqual(self.table["source"]["sha256"], "f21b25f9f600bb62519f40281d58f4b86fb02dd1e6cbd1e7a4765448a93310aa")
        self.assertEqual(list(self.v), list(range(80)))
        self.assertAlmostEqual(self.v[0]["draws"], 79.2913726765188)

    def test_last_up_tail(self):
        row = run(pool(45, [event(40)]))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["idealStop"], 40)
        self.assertAlmostEqual(row["localLoss"], 5 + self.v[5]["free10"] - self.v[0]["free10"])

    def test_last_copy_not_first(self):
        row = run(pool(40, [event(20), event(38)]))["pools"][0]
        self.assertEqual(row["anchor"]["at"], 38)
        self.assertEqual(row["permanentDelta"], 2)

    def test_same_ten_tail_not_exempt(self):
        row = run(pool(210, [event(60), event(120), event(180), event(203)]))["pools"][0]
        self.assertEqual(row["idealStop"], 203)
        self.assertEqual(row["permanentDelta"], 7)

    def test_46_59_inclusive_supplement(self):
        for at in (46, 50, 59):
            with self.subTest(at=at):
                row = run(pool(60, [event(at)]))["pools"][0]
                self.assertEqual(row["idealStop"], 60)
                self.assertEqual(row["localLoss"], 0)
        row = run(pool(60, [event(45)]))["pools"][0]
        self.assertEqual(row["idealStop"], 45)

    def test_off_six_during_supplement_changes_actual_water(self):
        row = run(pool(63, [event(50), event(58, "常驻")]))["pools"][0]
        self.assertEqual(row["reference"]["pity"], 2)
        self.assertEqual(row["actual"]["pity"], 5)
        self.assertAlmostEqual(row["localLoss"], 3+self.v[5]["free20"]-self.v[2]["free20"])

    def test_early_stop_supplement_uses_water_permanent_and_reward_net(self):
        p = pool(55, [event(50)])
        before = copy.deepcopy(p)
        row = run(p)["pools"][0]
        self.assertEqual(row["idealStop"], 60)
        self.assertEqual(row["branch"], "last-up")
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["actual"]["pity"], 5)
        self.assertEqual(row["reference"]["pity"], 10)
        self.assertEqual(row["missingPity"], 5)
        self.assertEqual(row["referencePitySource"], "early-stop-water-extension")
        self.assertTrue(row["reference"]["pityIsValuation"])
        self.assertEqual(row["permanentDelta"], -5)
        self.assertAlmostEqual(row["rewardValueDelta"], -(self.v[10]["free10"]-self.v[10]["free20"]))
        self.assertAlmostEqual(row["localLoss"], -5+self.v[5]["free10"]-self.v[10]["free20"])
        self.assertAlmostEqual(row["localLoss"], 6.189474206420904)
        self.assertEqual(p, before)

    def test_early_stop_free10_values_missing_water_not_face_draws(self):
        row = run(pool(5))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["branch"], "free-only-skip")
        self.assertEqual(row["idealStop"], 10)
        self.assertEqual(row["missedFree"], 5)
        self.assertEqual(row["missingPity"], 5)
        self.assertEqual(row["referencePitySource"], "early-stop-water-extension")
        self.assertTrue(row["reference"]["pityIsValuation"])
        self.assertEqual(row["actual"]["pity"], 5)
        self.assertEqual(row["reference"]["pity"], 10)
        self.assertEqual(row["permanentDelta"], 0)
        self.assertEqual(row["rewardValueDelta"], 0)
        self.assertAlmostEqual(row["localLoss"], self.v[5]["free10"]-self.v[10]["free10"])
        self.assertAlmostEqual(row["localLoss"], 1.7534469810691)
        self.assertNotAlmostEqual(row["localLoss"], 5)

    def test_early_stop_initial_water_is_not_discarded(self):
        row = run(pool(5, initialPity=7))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["actual"]["pity"], 12)
        self.assertEqual(row["reference"]["pity"], 17)
        self.assertAlmostEqual(row["localLoss"], self.v[12]["free10"]-self.v[17]["free10"])

    def test_early_stop_off_six_uses_true_tail_not_total(self):
        row = run(pool(5, [event(3, "常驻")], initialPity=20))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["idealStop"], 10)
        self.assertEqual(row["actual"]["pity"], 2)
        self.assertEqual(row["reference"]["pity"], 7)
        self.assertAlmostEqual(row["localLoss"], self.v[2]["free10"]-self.v[7]["free10"])

    def test_early_stop_free20_from_previous_node(self):
        row = run(pool(60, [event(60)], tail=0), pool(5, index=1))["pools"][1]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["freeAllowance"], 20)
        self.assertEqual(row["idealStop"], 20)
        self.assertEqual(row["missingPity"], 15)
        self.assertEqual(row["actual"]["pity"], 5)
        self.assertEqual(row["reference"]["pity"], 20)
        self.assertEqual(row["actual"]["nextFree"], 10)
        self.assertEqual(row["reference"]["nextFree"], 10)
        self.assertAlmostEqual(row["localLoss"], self.v[5]["free10"]-self.v[20]["free10"])

    def test_early_stop_explicit_free_positions_do_not_make_unspent_free_paid(self):
        for allowance in (10, 20):
            with self.subTest(allowance=allowance):
                row = run(pool(5, freeAllowance=allowance, freeDrawPositions=[1,2,3,4,5]))["pools"][0]
                self.assertEqual(row["status"], "ok")
                self.assertEqual(row["spendSource"], "explicit-free-positions")
                self.assertEqual(row["actual"]["permanent"], 0)
                self.assertEqual(row["reference"]["permanent"], 0)
                self.assertEqual(row["permanentDelta"], 0)
                self.assertAlmostEqual(row["localLoss"], self.v[5]["free10"]-self.v[allowance]["free10"])

    def test_early_stop_supplement_with_explicit_occurred_free_positions(self):
        row = run(pool(55, [event(50)], freeDrawPositions=list(range(1, 11))))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["actual"]["permanent"], 45)
        self.assertEqual(row["reference"]["permanent"], 50)
        self.assertEqual(row["permanentDelta"], -5)
        self.assertAlmostEqual(row["localLoss"], 6.189474206420904)

    def test_early_stop_unknown_actual_water_stays_partial(self):
        ledger = {"pools": [pool(5, initialPity=None)], "initialPity": None}
        row = score_planning(ledger)["pools"][0]
        self.assertEqual(row["status"], "partial")
        self.assertIsNone(row["localLoss"])

    def test_early_stop_reference_65_uses_extended_table(self):
        row = run(pool(5, initialPity=55))["pools"][0]
        self.assertEqual(row["actual"]["pity"], 60)
        self.assertEqual(row["reference"]["pity"], 65)
        self.assertEqual(row["status"], "ok")
        self.assertAlmostEqual(row["localLoss"], self.v[60]["free10"]-self.v[65]["free10"])

    def test_early_stop_virtual_water_79_is_supported(self):
        row = run(pool(5, initialPity=69))["pools"][0]
        self.assertEqual(row["actual"]["pity"], 74)
        self.assertEqual(row["reference"]["pity"], 79)
        self.assertEqual(row["status"], "ok")
        self.assertTrue(row["reference"]["pityIsValuation"])
        self.assertAlmostEqual(row["localLoss"], self.v[74]["free10"]-self.v[79]["free10"])

    def test_early_stop_virtual_water_80_is_not_a_valid_state(self):
        row = run(pool(5, initialPity=70))["pools"][0]
        self.assertEqual(row["status"], "partial")
        self.assertIsNone(row["localLoss"])
        self.assertIn("0–79", "".join(row["warnings"]))

    def test_previous_ongoing_option_now_settles_at_recorded_stop(self):
        result = run(pool(5, ended=False))
        row = result["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["missedFree"], 5)
        self.assertAlmostEqual(row["localLoss"], self.v[5]["free10"]-self.v[10]["free10"])
        self.assertEqual(result["summary"]["calculatedPools"], 1)
        self.assertEqual(result["summary"]["localLossSignedSum"], row["localLoss"])
        self.assertFalse(result["summary"]["sumIsPartial"])

    def test_early_stop_does_not_change_actual_events_or_next_initial_water(self):
        p = pool(5, tail=5)
        q = pool(10, index=1, id="p1", initialPity=5)
        before = copy.deepcopy([p, q])
        rows = run(p, q)["pools"]
        self.assertEqual(rows[0]["reference"]["pity"], 10)
        self.assertEqual(rows[1]["actual"]["pity"], 15)
        self.assertEqual(rows[1]["localLoss"], 0)
        self.assertEqual([p, q], before)
        self.assertEqual(p["events"], [])
        self.assertEqual(q["initialPity"], 5)

    def test_free_allowance_fully_used_remains_exact_zero(self):
        for allowance in (10, 20):
            with self.subTest(allowance=allowance):
                row = run(pool(allowance, freeAllowance=allowance))["pools"][0]
                self.assertEqual(row["status"], "ok")
                self.assertEqual(row["idealStop"], allowance)
                self.assertEqual(row["actual"]["pity"], allowance)
                self.assertEqual(row["reference"]["pity"], allowance)
                self.assertEqual(row["localLoss"], 0)
                self.assertFalse(row["reference"].get("pityIsValuation", False))

    def test_no_up_free_only_reference(self):
        row = run(pool(60, [], freeAllowance=20))["pools"][0]
        self.assertEqual(row["branch"], "free-only-skip")
        self.assertEqual(row["reference"]["stop"], 20)
        self.assertAlmostEqual(row["localLoss"], 10.6900087145171)
        self.assertAlmostEqual(row["localLoss"], row["permanentDelta"]-row["waterValueDelta"]-row["rewardValueDelta"])

    def test_same_start_no_up_off_six_before_free_end(self):
        row = run(pool(40, [event(8, "常驻")]))["pools"][0]
        self.assertEqual(row["reference"]["pity"], 2)
        self.assertEqual(row["actual"]["pity"], 32)

    def test_next_reward_table_not_face_value_10(self):
        row = run(pool(60, [], freeAllowance=20))["pools"][0]
        self.assertAlmostEqual(row["rewardValueDelta"], self.v[60]["free10"]-self.v[60]["free20"])
        self.assertNotAlmostEqual(row["rewardValueDelta"], 10)

    def test_free_prior_immediate_60(self):
        previous = pool(60, [event(60)], tail=0)
        current = pool(15, [event(15)], id="p1", index=1)
        row = run(previous, current)["pools"][1]
        self.assertEqual(row["freeAllowance"], 20)
        self.assertEqual(row["missedFree"], 5)

    def test_free_gap_unknown(self):
        row = run(pool(60, [event(60)]), pool(15, [event(15)], index=2))["pools"][1]
        self.assertIsNone(row["freeAllowance"])
        self.assertIsNone(row["localLoss"])

    def test_preexisting_current_only_free_uses_same_reference(self):
        ledger = {"pools": [pool(10)], "initialPity": 0, "initialOwned": ["目标"]}
        row = score_planning(ledger)["pools"][0]
        self.assertEqual(row["idealStop"], 10)
        self.assertEqual(row["localLoss"], 0)

    def test_missed_free_separate_from_loss(self):
        row = run(pool(8, [event(8)]))["pools"][0]
        self.assertEqual(row["missedFree"], 2)
        self.assertEqual(row["idealStop"], 10)
        self.assertAlmostEqual(row["localLoss"], self.v[0]['free10']-self.v[2]['free10'])

    def test_free_hit_then_exhaust_allowance_is_zero_not_negative(self):
        for free in (10, 20):
            for at in range(1, free+1):
                with self.subTest(free=free, at=at):
                    row = run(pool(free, [event(at)], freeAllowance=free))["pools"][0]
                    self.assertEqual(row['idealStop'], free)
                    self.assertEqual(row['localLoss'], 0)
                    self.assertEqual(row['actual']['permanent'], 0)
                    self.assertEqual(row['reference']['permanent'], 0)
                    self.assertEqual(row['actual']['pity'], free-at)
                    self.assertEqual(row['reference']['pity'], free-at)

    def test_free_hit_but_free_left_values_only_missing_water(self):
        for free in (10, 20):
            row = run(pool(5, [event(3)], freeAllowance=free))["pools"][0]
            self.assertEqual(row['idealStop'], free)
            self.assertEqual(row['missingPity'], free-5)
            self.assertEqual(row['permanentDelta'], 0)
            self.assertAlmostEqual(row['localLoss'], self.v[2]['free10']-self.v[free-3]['free10'])
            self.assertGreater(row['localLoss'], 0)

    def test_multiple_free_up_copies_still_finish_free(self):
        row = run(pool(20, [event(3), event(15)], freeAllowance=20))["pools"][0]
        self.assertEqual(row['anchor']['at'], 15)
        self.assertEqual(row['idealStop'], 20)
        self.assertEqual(row['localLoss'], 0)

    def test_free_hit_with_explicit_positions_has_no_phantom_gain(self):
        for free in (10, 20):
            row = run(pool(free, [event(3)], freeAllowance=free,
                           freeDrawPositions=list(range(1, free+1))))['pools'][0]
            self.assertEqual(row['idealStop'], free)
            self.assertEqual(row['permanentDelta'], 0)
            self.assertEqual(row['localLoss'], 0)

    def test_free_rule_does_not_extend_paid_hit_or_change_topup60(self):
        for free in (10, 20):
            for at in (free+1, 30, 45, 46, 59, 60):
                stop=60 if 46<=at<=59 else at
                row=run(pool(stop, [event(at)], freeAllowance=free))['pools'][0]
                self.assertEqual(row['idealStop'], stop)
                self.assertEqual(row['localLoss'], 0)

    def test_rush_main_water_not_reset(self):
        row = run(pool(40, [event(10, "常驻")], rush=[{"character": "目标"}], rushAt=30))["pools"][0]
        self.assertEqual(row["reference"]["pity"], 20)
        self.assertEqual(row["actual"]["pity"], 30)

    def test_unfilled_rush_up_time_defaults_after_main_30(self):
        row = run(pool(40, rush=[{"character": "目标"}]))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["anchor"], {"at":30,"source":"rush"})
        self.assertEqual(row["rushAtSource"], "confirmed-default-after-main-30")
        self.assertEqual(row["reference"]["pity"], 30)

    def test_default_rush_is_after_main_six_same_position(self):
        row = run(pool(35, [event(30,"常驻")], rush=[{"character":"目标"}]))["pools"][0]
        self.assertEqual(row["reference"]["pity"], 0)
        self.assertEqual(row["actual"]["pity"], 5)

    def test_explicit_delayed_rush_time_respected(self):
        row = run(pool(40, [event(10,"常驻")], rush=[{"character":"目标"}],rushAt=36))["pools"][0]
        self.assertEqual(row["anchor"]["at"], 36)
        self.assertEqual(row["rushAtSource"], "explicit")
        self.assertEqual(row["reference"]["pity"], 26)

    def test_invalid_explicit_rush_time_not_replaced_by_default(self):
        for at in (0,29,41,30.5,"", "30",False):
            with self.subTest(at=at):
                row = run(pool(40, [event(35)], rushAt=at))["pools"][0]
                self.assertEqual(row["status"], "partial")
                self.assertIsNone(row["localLoss"])

    def test_default_rush_does_not_enable_unused_or_unknown_batch(self):
        for state in (False,None):
            row = run(pool(40, [event(35)], rushUsed=state))["pools"][0]
            self.assertNotIn("rushAt",row)

    def test_rush_default_does_not_modify_input(self):
        p = pool(40, rush=[{"character":"目标"}])
        run(p)
        self.assertIsNone(p["rushAt"])

    def test_nonup_rush_does_not_need_timing(self):
        row = run(pool(40, [event(35)], rush=[{"character": "常驻"}]))["pools"][0]
        self.assertEqual(row["status"], "ok")

    def test_not_used_rush_is_not_auto_used(self):
        row = run(pool(40, [event(35)], rushUsed=False))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["anchor"]["source"], "main")

    def test_unknown_rush_blocks_possible_anchor(self):
        row = run(pool(40, [event(35)], rushUsed=None))["pools"][0]
        self.assertEqual(row["status"], "partial")

    def test_token_anchor_preserves_pity(self):
        events = [event(60), event(120), event(180, "常驻"), event(230, "常驻")]
        row = run(pool(243, events, tokens=[{"at": 240}]))["pools"][0]
        self.assertEqual(row["anchor"], {"at": 240, "source": "token"})
        self.assertEqual(row["reference"]["pity"], 10)
        self.assertEqual(row["actual"]["pity"], 13)

    def test_repeat_tokens_and_copies_have_no_overflow_exception(self):
        events = [event(n) for n in (60, 100, 140, 180, 220, 260, 300, 340, 380, 420, 460, 482)]
        row = run(pool(483, events, tokens=[{"at": 240}, {"at": 480}]))["pools"][0]
        self.assertEqual(row["anchor"]["at"], 482)

    def test_missing_token_blocks(self):
        row = run(pool(243, [event(60), event(120), event(180), event(230)]))["pools"][0]
        self.assertEqual(row["status"], "partial")

    def test_force_120_anchor_and_reset(self):
        row = run(pool(123, [event(70, "常驻"), event(120, forced=True)]))["pools"][0]
        self.assertEqual(row["anchor"]["at"], 120)
        self.assertEqual(row["reference"]["pity"], 0)

    def test_late_signin_free_positions_not_permanent(self):
        events = [event(70, "常驻"), event(120, forced=True)]
        row = run(pool(123, events, freeDrawPositions=[1,2,3,4,5,6,7,121,122,123]))["pools"][0]
        self.assertEqual(row["permanentDelta"], 0)
        self.assertLess(row["localLoss"], 0)

    def test_tail_water_69_uses_extended_table(self):
        row = run(pool(79, [event(10)]))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["actual"]["pity"], 69)
        self.assertEqual(row["reference"]["pity"], 0)
        self.assertEqual(row["permanentDelta"], 69)
        self.assertAlmostEqual(row["localLoss"], 69+self.v[69]["free20"]-self.v[0]["free10"])

    def test_identical_extended_water_can_cancel(self):
        row = run(pool(240, [event(80), event(120), event(175, "常驻")], tokens=[{"at":240}]))["pools"][0]
        self.assertEqual(row["reference"]["pity"], 65)
        self.assertEqual(row["localLoss"], 0)

    def test_unknown_initial_after_first_six_can_score(self):
        ledger = {"pools":[pool(40, [event(35)], initialPity=None)], "initialPity":None}
        self.assertEqual(score_planning(ledger)["pools"][0]["status"], "ok")

    def test_unknown_initial_before_first_six_partial(self):
        ledger = {"pools":[pool(40, [event(35, "常驻")], initialPity=None)], "initialPity":None}
        self.assertEqual(score_planning(ledger)["pools"][0]["status"], "partial")

    def test_last_snapshot_defaults_ended(self):
        p = pool(8, [event(8)])
        del p["ended"]
        row = run(p)["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["missedFree"], 2)
        self.assertEqual(row["unusedFreeAtSnapshot"], 2)
        self.assertEqual(row["endedSource"], "recorded-stop")

    def test_legacy_ongoing_row_uses_recorded_stop(self):
        row = run(pool(8, [event(8)], ended=False))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertTrue(row["ended"])
        self.assertEqual(row["missedFree"], 2)

    def test_null_ended_uses_last_snapshot_default(self):
        row = run(pool(10, ended=None))["pools"][0]
        self.assertEqual(row["status"], "ok")
        self.assertTrue(row["ended"])

    def test_last_snapshot_does_not_invent_previous_free_allowance(self):
        row = run(pool(40, [event(35)], index=3, ended=None))["pools"][0]
        self.assertTrue(row["ended"])
        self.assertIsNone(row["freeAllowance"])
        self.assertEqual(row["status"], "partial")

    def test_confirmed_history_ends_previous_banner(self):
        a, b = pool(10), pool(10, index=1)
        del a["ended"]
        del b["ended"]
        result = run(a, b)
        self.assertEqual(result["pools"][0]["status"], "ok")
        self.assertEqual(result["pools"][1]["status"], "ok")

    def test_signed_sum_offsets_negative_local_result(self):
        # Late, source-attributed sign-in free draws can still yield a signed gain;
        # merely finishing the default free allowance must no longer do so.
        result = run(pool(40, [event(35)]), pool(123, [event(70, '常驻'),event(120,forced=True)], index=1,
                          freeDrawPositions=[1,2,3,4,5,6,7,121,122,123]))
        losses = [r["localLoss"] for r in result["pools"]]
        self.assertGreater(losses[0], 0)
        self.assertLess(losses[1], 0)
        self.assertAlmostEqual(result["summary"]["localLossSignedSum"], sum(losses))
        self.assertAlmostEqual(result["summary"]["localLossSignedSum"],
                               result["summary"]["localLossPositiveSum"] - result["summary"]["localGainMagnitudeSum"])
        self.assertFalse(result["summary"]["sumIsPartial"])

    def test_partial_sum_excludes_missing_but_settles_other_rows(self):
        result = run(pool(40, [event(35)]), pool(5, index=1, complete=False), pool(40, [event(35)], index=2, ended=False))
        self.assertTrue(result["summary"]["sumIsPartial"])
        self.assertEqual(result["summary"]["calculatedPools"], 2)
        self.assertAlmostEqual(result["summary"]["localLossSignedSum"], sum(result["pools"][i]["localLoss"] for i in (0, 2)))
        self.assertIsNone(result["summary"]["title"])
        self.assertIsNone(result["summary"]["lossTier"])

    def test_no_fake_account_total_or_score(self):
        result = run(pool(40, [event(35)]))
        self.assertIsNone(result["summary"]["score"])
        self.assertEqual(result["summary"]["title"], loss_title(result["summary"]["localLossSignedSum"])["title"])
        self.assertIsNone(result["summary"]["accountCounterfactualLoss"])

    def test_large_loss_does_not_turn_into_negative_score(self):
        result = run(pool(400, [event(40)] + [event(n, "常驻") for n in (110,180,250,320,390)],
                          tokens=[{"at":240}]))
        # A long wasted tail after the token is still a finite local loss.
        self.assertGreater(result["summary"]["localLossSignedSum"], 120)
        self.assertIsNone(result["summary"]["score"])
        self.assertEqual(result["summary"]["lossTier"], 4)

    def test_negative_loss_is_preserved_not_clamped(self):
        result = run(pool(123,[event(70,'常驻'),event(120,forced=True)],
                          freeDrawPositions=[1,2,3,4,5,6,7,121,122,123]))["summary"]
        self.assertLess(result["localLossSignedSum"], 0)
        self.assertEqual(result["title"], "自律狂人")
        self.assertEqual(result["lossTier"], 1)
        self.assertIsNone(result["score"])

    def test_empty_record_has_no_loss_title(self):
        summary = run()["summary"]
        self.assertIsNone(summary["title"])
        self.assertIsNone(summary["lossTier"])

    def test_loss_title_boundaries_use_unrounded_signed_loss(self):
        for loss, tier, title in [(-1, 1, "自律狂人"), (20, 1, "自律狂人"),
                                 (20.000001, 2, "精打细算"), (60, 2, "精打细算"),
                                 (60.000001, 3, "随性挥霍"), (120, 3, "随性挥霍"),
                                 (120.000001, 4, "上头豪客"), (240, 4, "上头豪客"),
                                 (240.000001, 5, "亏掉底裤")]:
            with self.subTest(loss=loss):
                self.assertEqual(loss_title(loss), {"lossTier": tier, "title": title})

    def test_invalid_loss_has_no_title(self):
        for value in (None, float("nan"), float("inf"), -float("inf"), "20", True, {}):
            with self.subTest(value=value):
                self.assertEqual(loss_title(value), {"lossTier": None, "title": None})

    def test_bad_and_good_pool_independence(self):
        result = run(pool(50, [event(70)]), pool(40, [event(35)], index=1))
        self.assertEqual(result["pools"][0]["status"], "partial")
        self.assertEqual(result["pools"][1]["status"], "ok")

    def test_no_mutation(self):
        p = pool(40, [event(35)])
        before = copy.deepcopy(p)
        run(p)
        self.assertEqual(p, before)

    def test_quota_missing_does_not_block_planning(self):
        row = run(pool(40, [event(35)], issues=[{"severity":"error","code":"quota_missing","axes":["five"]}]))["pools"][0]
        self.assertEqual(row["status"], "ok")

    def test_pity_conflict_blocks(self):
        row = run(pool(40, [event(35)], tail=7))["pools"][0]
        self.assertEqual(row["status"], "partial")

    def test_known_ocr_structural_conflict_blocks(self):
        row = run(pool(40, [event(35)], issues=[{"severity":"error","code":"local_tail_conflict","message":"池尾不一致"}]))["pools"][0]
        self.assertEqual(row["status"], "partial")

    def test_unconfirmed_avatar_up_issue_blocks(self):
        row = run(pool(40, [event(35)], issues=[{"severity":"error","code":"avatar_ambiguous","axes":["up"],"message":"头像未确认"}]))["pools"][0]
        self.assertEqual(row["status"], "partial")
        self.assertIsNone(row["localLoss"])

    def test_unconfirmed_placeholder_six_issue_blocks(self):
        row = run(pool(40, [event(35)], issues=[{"severity":"error","code":"placeholder_needs_review","axes":["characterSix"],"message":"占位未确认"}]))["pools"][0]
        self.assertEqual(row["status"], "partial")

    def test_unscoped_error_fails_closed(self):
        row = run(pool(40, [event(35)], issues=[{"severity":"error","code":"future_unknown_issue"}]))["pools"][0]
        self.assertEqual(row["status"], "partial")

    def test_scoped_warning_does_not_block(self):
        row = run(pool(40, [event(35)], issues=[{"severity":"warning","code":"avatar_hint","axes":["up"]}]))["pools"][0]
        self.assertEqual(row["status"], "ok")

    def test_partial_row_keeps_actual_total(self):
        row = run(pool(5, complete=False))["pools"][0]
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["total"], 5)

    def test_frontend_default_migration_and_async_revision_guards(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node unavailable: frontend compatibility test not run")
        # Load the complete frontend with its UI model and a mocked DOM/API.
        # Extracting one-line functions broke as soon as app.js was formatted
        # normally and failed to test draft-dialog state or real dependencies.
        completed = subprocess.run([node, str(Path(__file__).with_name("test_ui_dialogs.js"))],
                                   text=True, capture_output=True, encoding="utf-8", timeout=15,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
