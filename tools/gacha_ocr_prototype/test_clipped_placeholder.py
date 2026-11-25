import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from avatar_locator import locate_avatar
import recognize


class ClippedRushPlaceholderTests(unittest.TestCase):
    bar = [184, 256, 184, 51]

    def make_case(self, icon="cross", frame=True, shade=(196, 196, 196)):
        image = np.full((600, 1000, 3), 242, dtype=np.uint8)
        image[256:307, 184:368] = (130, 205, 0)
        if frame:
            image[244:310, 85:168] = shade
        if icon == "cross":
            g = np.arange(27)
            diagonal = abs(g[:, None] - g[None, :]) <= 4
            image[275:302, 113:140][diagonal | diagonal.T[:, ::-1]] = 242
        elif icon == "question":
            cv2.putText(image, "?", (111, 298), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (244, 244, 244), 4)
        elif icon == "plus":
            cv2.line(image, (113, 288), (139, 288), (242, 242, 242), 5)
            cv2.line(image, (126, 275), (126, 301), (242, 242, 242), 5)
        return image

    def row(self, text, x, y):
        return {"text": text, "x": x, "y": y, "box": [x-30, y-10, x+30, y+10], "confidence": .99}

    def parse(self, image, *, rush=True, label="10抽"):
        rows = [self.row("冬猎", 120, 100), self.row("合计30抽垫30", 210, 150),
                self.row(label, 230, 284)]
        if rush:
            rows.append(self.row("免费十连", 138, 216))
        with (patch.object(recognize, "find_bars", return_value=[self.bar]),
              patch.object(recognize, "save_image")):
            return recognize.parse(image, rows, Path("synthetic_no_files_written"))[0]

    def test_rush_with_clipped_gray_cross_is_confirmed_no_six(self):
        image = self.make_case()
        self.assertTrue(locate_avatar(image, self.bar)["needs_review"])
        self.assertEqual(locate_avatar(image, self.bar, clipped_rush_placeholder=True),
                         {"box":[85,244,83,66], "method":"clipped_rush_cross", "needs_review":False})
        pool = self.parse(image)
        self.assertEqual(pool["rush"], [])
        self.assertEqual(pool["rush_no_six"]["kind"], "no_six")
        self.assertNotIn("placeholder_needs_review", pool["needs_review"])

    def test_similar_shapes_and_missing_frame_remain_unconfirmed(self):
        for image in (self.make_case("question"), self.make_case("plus"), self.make_case("blank"),
                      self.make_case(frame=False), self.make_case(shade=(145,165,196))):
            with self.subTest(image=image[244,85].tolist()):
                self.assertTrue(locate_avatar(image, self.bar, clipped_rush_placeholder=True)["needs_review"])

    def test_main_or_unreadable_rush_bar_does_not_use_clipped_cross(self):
        image = self.make_case()
        for kwargs in ({"rush":False}, {"label":"10?"}, {"label":"9抽"}):
            with self.subTest(kwargs=kwargs):
                self.assertIn("placeholder_needs_review", self.parse(image, **kwargs)["needs_review"])


if __name__ == "__main__":
    unittest.main()
