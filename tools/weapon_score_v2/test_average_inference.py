"""Exact bounded checks for the screenshot average inference, without MC."""
import unittest
from decimal import Decimal, ROUND_HALF_UP

try:
    from .average_inference import infer_weapon_average
except ImportError:
    from average_inference import infer_weapon_average


class AverageInferenceTests(unittest.TestCase):
    def test_user_example_keeps_raw_draw_outputs_separate(self):
        result = infer_weapon_average(680, 37, 11, "51.5")
        self.assertEqual(result["status"], "estimated")
        self.assertEqual((result["a"], result["b"], result["gifts"], result["excluded_draws"]),
                         (670, 13, 2, 10))
        self.assertEqual(result["provenance"]["raw"], {"N": 680, "K6": 37, "KU": 11})
        self.assertEqual(result["displayed_average"], "51.5")

    def test_lower_half_boundary_included_and_upper_excluded(self):
        # 10/8 = 1.25 rounds up to 1.3, even though Python round gives 1.2.
        result = infer_weapon_average(10, 8, 8, "1.3")
        self.assertEqual((result["a"], result["b"]), (10, 8))
        self.assertEqual(infer_weapon_average(10, 8, 8, "1.2")["status"], "unavailable")

    def test_total_need_not_be_multiple_of_ten(self):
        result = infer_weapon_average(689, 37, 11, 51.5)
        self.assertEqual((result["a"], result["b"], result["excluded_draws"]), (670, 13, 19))

    def test_tied_denominators_are_explicit_and_not_artificially_capped(self):
        result = infer_weapon_average(10, 1, 1, ".1")
        self.assertEqual((result["a"], result["b"]), (10, 67))
        self.assertEqual(result["tie_count"], 134)
        self.assertEqual(result["candidate_range"], {"a": 10, "b_min": 67, "b_max": 200})
        self.assertTrue(result["ambiguous"])
        self.assertTrue(result["has_alternatives"])

    def test_missing_zero_no_raw_up_and_no_solution_do_not_invent_counts(self):
        cases = [(None, "missing_average"), ("", "missing_average"),
                 (0, "zero_average_unbounded"), (999, "no_integer_solution")]
        for value, reason in cases:
            with self.subTest(value=value):
                result = infer_weapon_average(100, 5, 2, value)
                self.assertEqual((result["status"], result["reason"]), ("unavailable", reason))
                self.assertTrue(all(result[k] is None for k in ("a", "b", "gifts", "excluded_draws")))
        result = infer_weapon_average(100, 5, 0, 20)
        self.assertEqual(result["reason"], "no_raw_up")
        self.assertIsNone(result["gifts"])
        self.assertEqual(infer_weapon_average(9, 1, 1, 9)["reason"], "no_positive_ten_draw_numerator")

    def test_bad_averages_are_rejected(self):
        for value in (-1, True, "NaN", float("inf"), "51.55", "51.5抽", [], {}):
            with self.subTest(value=value):
                self.assertEqual(infer_weapon_average(100, 5, 2, value)["reason"], "invalid_average")
        self.assertEqual(infer_weapon_average(680, 37, 11, Decimal("51.50"))["a"], 670)

    def test_bad_raw_counts_are_rejected(self):
        for counts in ((True, 1, 1), (100.0, 5, 2), (100, -1, 0),
                       (10, 11, 1), (100, 5, 6), (100, None, 2)):
            with self.subTest(counts=counts):
                self.assertEqual(infer_weapon_average(*counts, 20)["reason"], "invalid_raw_counts")

    def test_maximality_and_complete_candidate_count_against_decimal_bruteforce(self):
        for N in (10, 19, 20, 31, 50):
            for KU in (1, 2, 5):
                for q in (1, 3, 7, 12, 13, 20, 39, 100, 200, 999):
                    c = Decimal(q) / 10
                    # For c >= .1, b <= 20*N covers the complete support.
                    candidates = [(a, b) for a in range(10, N + 1, 10)
                                  for b in range(KU, 20 * N + 1)
                                  if (Decimal(a) / Decimal(b)).quantize(Decimal(".1"), rounding=ROUND_HALF_UP) == c]
                    result = infer_weapon_average(N, max(KU, 5), KU, str(c))
                    with self.subTest(N=N, KU=KU, c=c):
                        self.assertEqual(result["candidate_count"], len(candidates))
                        if not candidates:
                            self.assertEqual(result["status"], "unavailable")
                            continue
                        a, b = min(candidates, key=lambda pair: (-pair[0], pair[1]))
                        self.assertEqual((result["a"], result["b"]), (a, b))
                        self.assertEqual(result["tie_count"], sum(pair[0] == a for pair in candidates))


if __name__ == "__main__":
    unittest.main()
