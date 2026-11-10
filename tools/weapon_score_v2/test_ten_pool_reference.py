"""Exact and contract tests for the experimental completed-pool ratio reference."""

from fractions import Fraction
import unittest

import numpy as np

try:
    from .scorer import AXES, _cycle_kernels
    from .ten_pool_reference import (
        _joint_pmf, reference_ratio_distribution, score_weapon_completed_pools,
    )
except ImportError:
    from scorer import AXES, _cycle_kernels
    from ten_pool_reference import (
        _joint_pmf, reference_ratio_distribution, score_weapon_completed_pools,
    )


class CompletedPoolReferenceTests(unittest.TestCase):
    def test_one_pool_matches_complete_cycle_exactly(self):
        actual = reference_ratio_distribution(1)
        for axis in AXES:
            completed, _ = _cycle_kernels(axis)
            expected = {}
            for tens, pmf in enumerate(completed[1:], start=1):
                for count, mass in enumerate(pmf):
                    if mass:
                        r = Fraction(count, 10 * tens)
                        expected[r] = expected.get(r, 0.0) + mass
            ref = actual[axis]
            ratios = [Fraction(int(n), int(d)) for n, d in
                      zip(ref["numerators"], ref["denominators"])]
            self.assertEqual(ratios, sorted(expected))
            np.testing.assert_allclose(ref["pmf"], [expected[r] for r in ratios],
                                       atol=2e-14, rtol=2e-12)

    def test_joint_support_and_mass(self):
        for pools in (1, 2, 10):
            for axis in AXES:
                joint = _joint_pmf(pools, axis)
                self.assertAlmostEqual(float(joint.sum()), 1.0, places=11)
                self.assertTrue(np.isfinite(joint).all())
                self.assertTrue((joint >= 0).all())
                self.assertEqual(float(joint[:pools].sum()), 0.0)
                self.assertEqual(float(joint[:, :pools].sum()), 0.0)
                self.assertEqual(joint.shape, (8 * pools + 1, 80 * pools + 1))

    def test_midrank_theoretical_mean_and_order(self):
        for pools in (1, 2, 10):
            for ref in reference_ratio_distribution(pools).values():
                self.assertAlmostEqual(float(ref["pmf"].sum()), 1.0, places=11)
                self.assertAlmostEqual(float(ref["pmf"] @ ref["scores"]), 50.0, places=10)
                self.assertTrue((np.diff(ref["ratios"]) > 0).all())
                self.assertTrue((np.diff(ref["scores"]) >= -1e-12).all())

    def test_exact_fraction_ties_merge_different_draw_counts(self):
        for axis in AXES:
            completed, _ = _cycle_kernels(axis)
            expected_equal = sum(float(completed[tens][tens // 2])
                                 for tens in (2, 4, 6, 8))
            # 1/20, 2/40, 3/60 and 4/80 are exactly the same observed yield.
            for draws, count in ((20, 1), (40, 2), (60, 3), (80, 4)):
                report = score_weapon_completed_pools(draws, count, count, pools=1)
                self.assertAlmostEqual(report[axis]["p_equal"], expected_equal, places=12)

    def test_public_score_monotonicity_and_probability_partition(self):
        reports = [score_weapon_completed_pools(550, count, count)
                   for count in (0, 5, 10, 20, 30, 50, 550)]
        for axis in AXES:
            scores = [report[axis]["score"] for report in reports]
            self.assertTrue((np.diff(scores) >= 0).all())
            for report in reports:
                item = report[axis]
                self.assertAlmostEqual(sum(item[key] for key in
                                           ("p_less", "p_equal", "p_greater")), 1.0, places=11)
                self.assertAlmostEqual(item["score"],
                                       100 * (item["p_less"] + item["p_equal"] / 2), places=11)

    def test_same_ratio_same_score_without_conditioning_on_observed_budget(self):
        baseline = score_weapon_completed_pools(100, 5, 2)
        for draws, six, up in ((10, 0, 0), (200, 10, 4), (1000, 50, 20)):
            actual = score_weapon_completed_pools(draws, six, up)
            if draws != 10:
                for axis in AXES:
                    self.assertEqual(actual[axis]["score"], baseline[axis]["score"])
            self.assertEqual(actual["reference_pools"], 10)

    def test_zero_draws_no_score(self):
        report = score_weapon_completed_pools(0, 0, 0)
        for axis in AXES:
            self.assertIsNone(report[axis]["score"])
            self.assertIsNone(report[axis]["rate"])
            self.assertIsNone(report[axis]["p_equal"])

    def test_public_arrays_cannot_mutate_cache(self):
        expected = score_weapon_completed_pools(550, 30, 10)
        public = reference_ratio_distribution()
        for ref in public.values():
            for value in ref.values():
                if isinstance(value, np.ndarray):
                    value[:] = 0
        self.assertEqual(score_weapon_completed_pools(550, 30, 10), expected)
        self.assertAlmostEqual(float(reference_ratio_distribution()["six_star"]["pmf"].sum()), 1.0)

    def test_invalid_inputs(self):
        for pools in (0, -1, True, 1.0, "10", None):
            with self.assertRaises(ValueError):
                reference_ratio_distribution(pools)
        for args in ((-10, 0, 0), (1, 0, 0), (10.0, 0, 0), (True, 0, 0),
                     (10, 11, 0), (10, 0, 1), (10, 1, -1), (10, True, 0),
                     (10, 1, 0.0), (0, 1, 0)):
            with self.assertRaises(ValueError):
                score_weapon_completed_pools(*args)


if __name__ == "__main__":
    unittest.main()
