"""Contract, exact-small-case and calibration tests for weapon-score v2."""

import math
import unittest

import numpy as np

try:
    from .scorer import reference_pmfs, score_weapon
    from .validate_reference import simulate_one
except ImportError:
    from scorer import reference_pmfs, score_weapon
    from validate_reference import simulate_one


def binomial(n, p):
    return np.array([math.comb(n, k) * p ** k * (1 - p) ** (n - k)
                     for k in range(n + 1)])


class AlwaysMiss:
    def random(self):
        return 0.999


class WeaponScoreTests(unittest.TestCase):
    def test_ten_draws_match_exact_binomials(self):
        pmfs = reference_pmfs(10)
        for axis, probability in (("six_star", 0.04), ("signature", 0.01)):
            expected = binomial(10, probability)
            actual = np.asarray(pmfs[axis])
            np.testing.assert_allclose(actual[:11], expected, atol=1e-13, rtol=1e-12)
            self.assertAlmostEqual(float(actual[11:].sum()), 0.0, places=13)

    def test_thirty_draws_before_any_hard_pity_match_binomials(self):
        pmfs = reference_pmfs(30)
        for axis, probability in (("six_star", 0.04), ("signature", 0.01)):
            expected = binomial(30, probability)
            np.testing.assert_allclose(pmfs[axis][:31], expected, atol=1e-12, rtol=1e-11)

    def test_forty_guarantees_at_least_one_six(self):
        self.assertLess(abs(reference_pmfs(40)["six_star"][0]), 1e-13)

    def test_eighty_guarantees_at_least_one_signature(self):
        self.assertLess(abs(reference_pmfs(80)["signature"][0]), 1e-13)

    def test_independent_simulator_forced_40_and_80(self):
        self.assertEqual(simulate_one(30, AlwaysMiss()), (0, 0))
        self.assertEqual(simulate_one(40, AlwaysMiss()), (1, 0))
        self.assertEqual(simulate_one(80, AlwaysMiss()), (2, 1))
        self.assertEqual(simulate_one(160, AlwaysMiss()), (4, 2))

    def test_pmf_mass_support_and_midrank_mean(self):
        for n in (0, 10, 80, 400):
            with self.subTest(total_draws=n):
                pmfs = reference_pmfs(n)
                for axis in ("six_star", "signature"):
                    pmf = np.asarray(pmfs[axis])
                    self.assertEqual(pmf.ndim, 1)
                    self.assertTrue(np.all(np.isfinite(pmf)))
                    self.assertGreaterEqual(float(pmf.min()), -1e-13)
                    self.assertAlmostEqual(float(pmf.sum()), 1.0, places=10)
                    self.assertLessEqual(len(pmf), n + 1)
                    midrank = 100 * (np.cumsum(pmf) - 0.5 * pmf)
                    self.assertAlmostEqual(float(np.dot(pmf, midrank)), 50.0, places=8)
                support_six = np.arange(len(pmfs["six_star"]))
                support_up = np.arange(len(pmfs["signature"]))
                self.assertGreaterEqual(float(support_six @ pmfs["six_star"]),
                                        float(support_up @ pmfs["signature"]))

    def test_zero_draws_is_no_score(self):
        pmfs = reference_pmfs(0)
        np.testing.assert_array_equal(pmfs["six_star"], [1.0])
        np.testing.assert_array_equal(pmfs["signature"], [1.0])
        result = score_weapon(0, 0, 0)
        for axis in ("six_star", "signature"):
            self.assertIsNone(result[axis]["score"])
            self.assertIsNone(result[axis]["rate"])

    def test_report_is_midrank_not_upper_tail(self):
        for count in (0, 1, 2, 10):
            result = score_weapon(10, count, count)
            pmfs = reference_pmfs(10)
            for axis in ("six_star", "signature"):
                item = result[axis]
                pmf = pmfs[axis]
                expected = 100 * (float(pmf[:count].sum()) + 0.5 * float(pmf[count]))
                self.assertAlmostEqual(item["score"], expected, places=10)
                self.assertAlmostEqual(item["p_less"] + item["p_equal"] + item["p_greater"], 1.0, places=10)
                self.assertAlmostEqual(item["rate"], count / 10)

    def test_score_monotonicity(self):
        reports = [score_weapon(10, n, n) for n in range(11)]
        for axis in ("six_star", "signature"):
            values = np.array([report[axis]["score"] for report in reports])
            self.assertTrue(np.all(np.diff(values) >= -1e-10))
            self.assertGreaterEqual(float(values.min()), 0.0)
            self.assertLessEqual(float(values.max()), 100.0 + 1e-10)

    def test_axes_do_not_mix_each_others_counts(self):
        baseline = score_weapon(400, 20, 7)
        more_off_target = score_weapon(400, 24, 7)
        more_signature = score_weapon(400, 20, 10)
        self.assertEqual(baseline["signature"], more_off_target["signature"])
        self.assertEqual(baseline["six_star"], more_signature["six_star"])
        self.assertGreater(more_off_target["six_star"]["score"], baseline["six_star"]["score"])
        self.assertGreater(more_signature["signature"]["score"], baseline["signature"]["score"])

    def test_public_pmf_mutation_does_not_corrupt_cache(self):
        before = reference_pmfs(80)
        expected = before["six_star"].copy()
        before["six_star"][:] = 0
        before["signature"] = np.ones(5)
        after = reference_pmfs(80)
        np.testing.assert_array_equal(after["six_star"], expected)
        self.assertAlmostEqual(float(after["signature"].sum()), 1.0)

    def test_invalid_draw_counts(self):
        for value in (-10, 1, 11, 10.0, True, "10", None, 5010):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    reference_pmfs(value)
                with self.assertRaises(ValueError):
                    score_weapon(value, 0, 0)

    def test_invalid_observed_counts(self):
        cases = [(0, 1, 0), (10, -1, 0), (10, 11, 0), (10, 1, 2),
                 (10, 1, -1), (10, True, 0), (10, 1, True),
                 (10, 1.0, 0), (10, 1, 0.0), (10, None, 0)]
        for args in cases:
            with self.subTest(args=args):
                with self.assertRaises(ValueError):
                    score_weapon(*args)


if __name__ == "__main__":
    unittest.main()
