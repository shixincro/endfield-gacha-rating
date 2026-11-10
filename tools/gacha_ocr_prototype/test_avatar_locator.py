"""Geometry-only regression tests: no screenshot answers and no OCR engine.

These synthetic checks validate frame coordinates and abstention, not character
recognition accuracy. The full eight-image run reports the latter separately.
"""
from __future__ import annotations

import unittest

import numpy as np

from avatar_locator import locate_avatar


class AvatarLocatorTests(unittest.TestCase):
    def make_case(self, box=(96, 94, 70, 70), color=(70, 150, 210)):
        image = np.full((260, 420, 3), 235, dtype=np.uint8)
        x, y, w, h = box
        image[y:y+h, x:x+w] = color
        image[104:154, 185:385] = (0, 220, 190)
        return image, [185, 104, 200, 50]

    def test_color_frame_uses_real_bounds_not_bar_scale(self):
        expected = [96, 94, 70, 70]
        image, bar = self.make_case(expected)
        actual = locate_avatar(image, bar)
        self.assertEqual(actual["box"], expected)
        self.assertEqual(actual["method"], "frame_component")
        self.assertFalse(actual["needs_review"])

    def test_gray_frame_is_not_discarded_for_low_saturation(self):
        image, bar = self.make_case(color=(170, 170, 170))
        actual = locate_avatar(image, bar)
        self.assertEqual(actual["box"], [96, 94, 70, 70])
        self.assertFalse(actual["needs_review"])

    def test_offsets_and_sizes_are_read_from_pixels(self):
        for expected in ([87, 88, 80, 80], [108, 100, 56, 56], [93, 102, 72, 65]):
            with self.subTest(box=expected):
                image, bar = self.make_case(expected)
                actual = locate_avatar(image, bar)
                self.assertEqual(actual["box"], expected)
                self.assertFalse(actual["needs_review"])

    def test_empty_background_explicitly_requires_review(self):
        image = np.full((260, 420, 3), 235, dtype=np.uint8)
        actual = locate_avatar(image, [185, 104, 200, 50])
        self.assertEqual(actual["method"], "fallback")
        self.assertTrue(actual["needs_review"])

    def test_non_square_noise_is_not_a_frame(self):
        image = np.full((260, 420, 3), 235, dtype=np.uint8)
        image[115:135, 90:166] = (50, 100, 170)
        actual = locate_avatar(image, [185, 104, 200, 50])
        self.assertEqual(actual["method"], "fallback")
        self.assertTrue(actual["needs_review"])

    def test_empty_search_at_left_edge_does_not_crash(self):
        image = np.full((260, 420, 3), 235, dtype=np.uint8)
        actual = locate_avatar(image, [0, 0, 200, 50])
        self.assertEqual(actual["method"], "fallback")
        self.assertTrue(actual["needs_review"])
        self.assertEqual(actual["box"][:2], [0, 0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
