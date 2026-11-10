"""Identity precedence regressions; no OCR, player records or matcher retuning."""
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

import recognize


def accepted(name):
    return {"character": name, "candidate": name, "needs_review": False,
            "similarity": .95, "margin": .3}


def row(text, x, y):
    return {"text": text, "confidence": .99, "x": x, "y": y,
            "box": [x-40, y-10, x+40, y+10]}


class AvatarIdentityTests(unittest.TestCase):
    def parse_events(self, text, answers, *, rush=False, gift=False, location_ok=True):
        rows = [row("临渊望北", 120, 100), row("合计240抽垫0", 240, 145),
                row(text, 230, 250)]
        bars = [[180, 230, 300, 40]]
        if gift:
            rows.append(row("赠", 230, 290))
        if rush:
            rows.extend([row("免费十连", 150, 320), row("4抽超非", 230, 400)])
            bars.append([180, 380, 300, 40])
        image = np.full((600, 1000, 3), 210, dtype=np.uint8)
        image[:, :, 0] = 60
        def located(_image, bar):
            return {"box": [110, bar[1]-10, 60, 60],
                    "method": "frame_component" if location_ok else "fallback",
                    "needs_review": not location_ok}
        with patch.object(recognize, "find_bars", return_value=bars), \
             patch.object(recognize, "locate_avatar", side_effect=located), \
             patch.object(recognize, "save_image"), \
             patch("avatar_match.match_avatar", side_effect=answers):
            return recognize.parse(image, rows, Path("synthetic_no_files_written"))[0]

    def test_hidden_off_badge_and_super_unlucky_text_use_portrait(self):
        for text in ("76抽", "76抽超非", "76抽更新", "76抽超非歪"):
            with self.subTest(text=text):
                pool = self.parse_events(text, [accepted("艾尔黛拉")])
                event = pool["events"][0]
                self.assertEqual(event["character"], "艾尔黛拉")
                self.assertTrue(event["off"])
                self.assertEqual(event["offBadgeObserved"], "歪" in text)
                self.assertEqual(event["identitySource"], "avatar")
                self.assertNotIn("needs_review", event)
                self.assertNotIn("event_needs_review", pool["needs_review"])

    def test_legal_limited_off_banner_does_not_become_current_up(self):
        event = self.parse_events("76抽超非", [accepted("卡缪")])["events"][0]
        self.assertEqual(event["character"], "卡缪")
        self.assertTrue(event["off"])

    def test_accepted_up_remains_up(self):
        event = self.parse_events("76抽超非", [accepted("诀")])["events"][0]
        self.assertEqual(event["character"], "诀")
        self.assertFalse(event["off"])
        self.assertNotIn("needs_review", event)

    def test_explicit_conflicting_off_badge_keeps_avatar_and_warning(self):
        pool = self.parse_events("76抽歪", [accepted("诀")])
        event = pool["events"][0]
        self.assertEqual(event["character"], "诀")
        self.assertFalse(event["off"])
        self.assertEqual(event["needs_review"], "avatar_conflicts_with_off_badge")
        self.assertIn("event_needs_review", pool["needs_review"])

    def test_abstained_candidate_is_unknown_even_without_off_badge(self):
        abstained = {**accepted("艾尔黛拉"), "character": None, "needs_review": True}
        event = self.parse_events("76抽超非", [abstained])["events"][0]
        self.assertIsNone(event["character"])
        self.assertIsNone(event["off"])
        self.assertEqual(event["identitySource"], "unknown")
        self.assertEqual(event["avatar_match"]["candidate"], "艾尔黛拉")
        self.assertEqual(event["needs_review"], "avatar_identity_unresolved")

    def test_review_flag_or_missing_acceptance_cannot_fill_identity(self):
        for match in ({**accepted("诀"), "needs_review": True},
                      {"character": "诀", "candidate": "诀"},
                      {"needs_review": True, "reason": "assets_unavailable"}):
            with self.subTest(match=match):
                event = self.parse_events("76抽", [match])["events"][0]
                self.assertIsNone(event["character"])
                self.assertEqual(event["needs_review"], "avatar_identity_unresolved")

    def test_accepted_but_impossible_banner_character_stays_unknown(self):
        for name in ("祀", "莱万汀", "未配置角色"):
            with self.subTest(name=name):
                event = self.parse_events("76抽歪", [accepted(name)])["events"][0]
                self.assertIsNone(event["character"])
                self.assertIsNone(event["off"])
                self.assertEqual(event["avatar_match"]["character"], name)
                self.assertEqual(event["needs_review"], "avatar_character_not_in_banner")

    def test_first_two_banner_exceptions_and_latest_pool_membership(self):
        common = {"余烬", "黎风", "艾尔黛拉", "别礼", "骏卫"}
        for banner in ("熔火灼痕", "轻飘飘的信使", "热烈色彩"):
            self.assertEqual(recognize.banner_characters(banner),
                             common | {"莱万汀", "洁尔佩塔", "伊冯"})
        self.assertEqual(recognize.banner_characters("万物更新"),
                         common | {"祀", "提弗洛斯", "梨诺"})
        self.assertEqual(recognize.banner_characters("烟火邀星河"),
                         common | {"明河", "祀", "提弗洛斯"})
        self.assertEqual(recognize.banner_characters("不存在"), set())

    def test_fallback_location_does_not_autoaccept_portrait(self):
        event = self.parse_events("76抽", [accepted("诀")], location_ok=False)["events"][0]
        self.assertIsNone(event["character"])
        self.assertEqual(event["needs_review"], "avatar_frame_not_found_check_source_or_manual_entry")

    def test_rush_uses_same_identity_rule_and_gift_stays_separate(self):
        pool = self.parse_events("76抽", [accepted("诀"), accepted("艾尔黛拉")],
                                 rush=True, gift=True)
        self.assertEqual(len(pool["events"]), 1)
        self.assertEqual(len(pool["rush"]), 1)
        self.assertEqual(pool["token_count"], 1)
        self.assertEqual(pool["rush"][0]["character"], "艾尔黛拉")
        self.assertTrue(pool["rush"][0]["off"])
        self.assertEqual(pool["rush"][0]["identitySource"], "avatar")
        self.assertNotIn("needs_review", pool["rush"][0])

    def test_missing_pull_count_still_requires_review(self):
        event = self.parse_events("超非", [accepted("艾尔黛拉")])["events"][0]
        self.assertEqual(event["character"], "艾尔黛拉")
        self.assertIsNone(event["pulls"])
        self.assertEqual(event["needs_review"], "missing_character_or_pulls")


if __name__ == "__main__":
    unittest.main(verbosity=2)
