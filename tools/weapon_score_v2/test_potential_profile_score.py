"""Contracts and independent deterministic moment checks for result profiles."""

import inspect
import json
import math
import unittest

import numpy as np

try:
    from .potential_profile_score import (
        _advance, _gift_count, _horizon, _target_moments, clear_cache,
        parse_profile, reference_profile_moments, score_weapon_profile,
    )
    from .scorer import _cycle_kernels
except ImportError:
    from potential_profile_score import (
        _advance, _gift_count, _horizon, _target_moments, clear_cache,
        parse_profile, reference_profile_moments, score_weapon_profile,
    )
    from scorer import _cycle_kernels


class PotentialProfileTests(unittest.TestCase):
    def test_profile_meaning_and_normalization(self):
        plain = parse_profile("12")
        self.assertEqual(plain["copies_per_type"], [1] * 12)
        parsed = parse_profile(" 12\t1  0 5\n")
        self.assertEqual(parsed["normalized"], "12 5 1")
        self.assertEqual(parsed["copies_per_type"], [6, 2] + [1] * 10)
        self.assertEqual(parsed["total_copies"], 18)

    def test_overflow_potential_is_not_capped(self):
        parsed = parse_profile("12 6 1")
        self.assertEqual(parsed["copies_per_type"], [7, 2] + [1] * 10)
        self.assertEqual(parsed["total_copies"], 19)
        self.assertEqual(parsed["overflow_copies"], 1)
        result = score_weapon_profile(1200, 65, 15, "12 6 1")
        self.assertEqual(result["inferred_gifts"], 4)
        self.assertTrue(math.isfinite(result["signature"]["score"]))
        self.assertEqual(_horizon(7), 980)

    def test_profile_permutation_equivalence(self):
        self.assertEqual(score_weapon_profile(1000, 55, 15, "12 5 1"),
                         score_weapon_profile(1000, 55, 15, "12 1 5 0"))

    def test_repeated_potential_is_equivalent_to_explicit_profile_and_score(self):
        expanded = "11 " + " ".join(["5"] * 7)
        for shorthand in ("11 5*7", " 11\t5 * 7\n", "11 05*007"):
            with self.subTest(shorthand=shorthand):
                parsed = parse_profile(shorthand)
                self.assertEqual(parsed, parse_profile(expanded))
                self.assertEqual(parsed["potentials"], [5] * 7 + [0] * 4)
                self.assertEqual(parsed["total_copies"], 46)
                self.assertEqual(score_weapon_profile(2000, 100, 40, shorthand),
                                 score_weapon_profile(2000, 100, 40, expanded))

    def test_repeated_potential_operands_are_not_interchangeable(self):
        full = parse_profile("11 5*7")
        overflow = parse_profile("11 7*5")
        self.assertEqual(full["total_copies"], overflow["total_copies"])
        self.assertEqual(full["overflow_copies"], 0)
        self.assertEqual(overflow["potentials"], [7] * 5 + [0] * 6)
        self.assertEqual(overflow["overflow_copies"], 10)
        self.assertNotEqual(reference_profile_moments("11 5*7"),
                            reference_profile_moments("11 7*5"))

    def test_repeat_groups_mix_with_individual_and_zero_potentials(self):
        self.assertEqual(parse_profile("11 5*7 1*2 0"),
                         parse_profile("11 5 5 5 5 5 5 5 1 1 0"))
        self.assertEqual(parse_profile("3 0*3"), parse_profile("3"))
        self.assertEqual(parse_profile("1 6*1"), parse_profile("1 6"))

    def test_repeat_groups_reject_bad_counts_before_expansion(self):
        for profile in ("11 5*0", "11 5*12", "11 5*7 1*5", "11 5*",
                        "11 *7", "11 5**7", "11 5*7*2", "11 5*-1",
                        "11 5*1.5", "11 -5*7", "11 5.5*7", "11*1 5",
                        "11 5*999999999", "11 5*9999999999", "11 9999999999*1",
                        "11 5x7", "11 5×7", "0 0*1"):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                parse_profile(profile)

    def test_twenty_eighty_and_fifty_fifty_have_identical_inputs_and_scores(self):
        # Their forced-80 histories differ; original total input/output does not.
        forced = score_weapon_profile(20 + 80, 4, 2, "2")
        natural = score_weapon_profile(50 + 50, 4, 2, "2")
        self.assertEqual(forced, natural)
        self.assertNotIn("H80", inspect.signature(score_weapon_profile).parameters)

    def test_gifts_enter_both_axes_without_mutating_raw_counts(self):
        result = score_weapon_profile(340, 14, 5, "1 6")
        self.assertEqual(result["inputs"], {"N": 340, "K6": 14, "KU": 5})
        self.assertEqual(result["inferred_gifts"], 2)
        self.assertEqual(result["six_star"]["raw_count"], 14)
        self.assertEqual(result["six_star"]["effective_count"], 16)
        self.assertEqual(result["signature"]["raw_count"], 5)
        self.assertEqual(result["signature"]["effective_count"], 7)
        self.assertEqual(result["six_star"]["rate"], 16 / 340)
        self.assertEqual(result["signature"]["rate"], 7 / 340)
        moments = result["reference_moments"]
        self.assertGreater(moments["mean_gifts"], 0)
        self.assertAlmostEqual(moments["mean"][1],
                               moments["raw_mean"][1] + moments["mean_gifts"])
        self.assertAlmostEqual(moments["mean"][2],
                               moments["raw_mean"][2] + moments["mean_gifts"])

    def test_gift_nodes_extend_beyond_five_rewards(self):
        self.assertEqual([_gift_count(n) for n in (179, 180, 339, 340, 820, 979, 980)],
                         [0, 1, 1, 2, 5, 5, 6])

    def test_first_target_matches_existing_full_cycle_kernels(self):
        actual = reference_profile_moments("1")
        mean = np.asarray(actual["mean"])
        cov = np.asarray(actual["covariance"])
        for axis_index, axis in ((1, "six_star"), (2, "signature")):
            kernels, _ = _cycle_kernels(axis)
            expected_mean = np.zeros(2)
            expected_second = np.zeros((2, 2))
            for tens, pmf in enumerate(kernels):
                for count, probability in enumerate(pmf):
                    values = np.array([10 * tens, count], dtype=float)
                    expected_mean += probability * values
                    expected_second += probability * np.outer(values, values)
            expected_cov = expected_second - np.outer(expected_mean, expected_mean)
            indices = [0, axis_index]
            np.testing.assert_allclose(mean[indices], expected_mean, atol=2e-12)
            np.testing.assert_allclose(cov[np.ix_(indices, indices)], expected_cov, atol=2e-11)
        self.assertGreater(mean[2], 1.0)  # Keeps later UP in the successful ten.
        self.assertEqual(actual["mean_gifts"], 0.0)

    def test_forced_pity_and_first_guarantee_transition(self):
        active = np.zeros((3, 20, 40))
        active[0, 0, 39] = 1
        after = _advance(active, 40)
        self.assertAlmostEqual(after[0, 0, 0], 0.75)
        self.assertAlmostEqual(after[0, 1, 0], 0.25)
        self.assertAlmostEqual(after[1].sum(), 1)
        active = np.zeros((3, 20, 40))
        active[0, 0, 7] = 1
        forced = _advance(active, 80)
        self.assertEqual(forced[0, 1, 0], 1)
        self.assertEqual(forced[1, 1, 0], 1)
        self.assertEqual(forced[0].sum(), 1)
        # A natural UP already consumed the guarantee; draw 80 is ordinary now.
        active = np.zeros((3, 20, 40))
        active[0, 1, 7] = 1
        ordinary = _advance(active, 80)
        self.assertAlmostEqual(ordinary[0, 1, 8], 0.96)
        self.assertAlmostEqual(ordinary[0, 2, 0], 0.01)

    def test_independent_scalar_distribution_before_any_pity(self):
        # Track all three outcome counts independently; no implementation helper
        # is used to obtain expected E[K6], E[K6**2], or P(KU=k).
        active = np.zeros((3, 30, 40))
        active[0, 0, 0] = 1
        for draw in range(1, 11):
            active = _advance(active, draw)
        for up in range(11):
            expected = np.zeros(3)
            for off in range(11 - up):
                miss = 10 - up - off
                probability = (math.factorial(10) / math.factorial(up)
                               / math.factorial(off) / math.factorial(miss)
                               * 0.01 ** up * 0.03 ** off * 0.96 ** miss)
                six = up + off
                expected += probability * np.array([1, six, six * six])
            np.testing.assert_allclose(active[:, up, :].sum(axis=1), expected,
                                       atol=1e-13, rtol=1e-12)

    def test_independent_targets_add_covariances(self):
        single = reference_profile_moments("1 5")
        pair = reference_profile_moments("2 5 5")
        np.testing.assert_allclose(pair["mean"], 2 * np.array(single["mean"]))
        np.testing.assert_allclose(pair["covariance"], 2 * np.array(single["covariance"]))
        for copies in (1, 2, 6, 7):
            _, covariance, mass = _target_moments(copies)
            self.assertAlmostEqual(mass, 1, places=11)
            self.assertGreaterEqual(float(np.linalg.eigvalsh(covariance).min()), -1e-9)

    def test_residual_formula_and_finite_variance(self):
        result = score_weapon_profile(1000, 55, 15, "12 5 1")
        mean = np.array(result["reference_moments"]["mean"])
        covariance = np.array(result["reference_moments"]["covariance"])
        for index, name in ((1, "six_star"), (2, "signature")):
            axis = result[name]
            linear = np.zeros(3)
            linear[0], linear[index] = -axis["rate"], 1
            self.assertAlmostEqual(axis["residual_mean"], float(linear @ mean))
            self.assertAlmostEqual(axis["residual_variance"], float(linear @ covariance @ linear))
            self.assertGreater(axis["residual_variance"], 0)
            self.assertTrue(math.isfinite(axis["z"]))
            self.assertGreaterEqual(axis["score"], 0)
            self.assertLessEqual(axis["score"], 100)
        json.dumps(result, allow_nan=False)

    def test_no_record_is_unscored(self):
        result = score_weapon_profile(0, 0, 0, "0")
        for name in ("six_star", "signature"):
            self.assertIsNone(result[name]["score"])
            self.assertIsNone(result[name]["rate"])
        self.assertEqual(result["inferred_gifts"], 0)

    def test_explicit_individual_draw_flag_preserves_original_N(self):
        with self.assertRaises(ValueError):
            score_weapon_profile(101, 4, 2, "2")
        result = score_weapon_profile(101, 4, 2, "2", allow_individual_draws=True)
        self.assertEqual(result["total_draws"], 101)
        self.assertEqual(result["six_star"]["rate"], 4 / 101)
        self.assertTrue(any("非整十" in text for text in result["warnings"]))
        with self.assertRaises(ValueError):
            score_weapon_profile(100, 4, 2, "2", allow_individual_draws=1)

    def test_invalid_profile_and_work_budget(self):
        for profile in (None, "", "1 -1", "2 1.5", "2 1 2 3", "0 0", "1 +2", "1 a", "1001", "1 9999999999"):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                parse_profile(profile)
        with self.assertRaisesRegex(ValueError, "预算"):
            reference_profile_moments("1 1000")

    def test_incoherent_original_counts_and_profile_rejected(self):
        cases = [(-10, 0, 0, "0"), (10, 11, 1, "1"), (10, 0, 1, "1"),
                 (100, 4, 3, "2"), (100, 4, 2, "3"), (100, 4, 1, "1 1"),
                 (100, 4, 2, "0"), (0, 0, 0, "1"), (True, 0, 0, "0"),
                 (100, 4.0, 2, "2"), (100, 4, True, "2")]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError):
                score_weapon_profile(*args)

    def test_public_moments_do_not_mutate_cache(self):
        first = reference_profile_moments("1 1")
        expected = reference_profile_moments("1 1")
        first["mean"][0] = -999
        first["raw_covariance"][0][0] = -999
        self.assertEqual(reference_profile_moments("1 1"), expected)

    def test_repeat_scores_are_deterministic(self):
        first = score_weapon_profile(1000, 55, 15, "12 5 1")
        clear_cache()
        second = score_weapon_profile(1000, 55, 15, "12 5 1")
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
