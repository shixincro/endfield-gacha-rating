"""Small parser audit suite. Expected failures are known risks, not passes.

No OCR engine is run here and no human truth file is read. These synthetic tests
are separate from the eight-image end-to-end benchmark and do not measure its
accuracy. In particular, a low-saturation counterexample is not evidence that
every real silver-haired portrait is lost.
Parser fixtures isolate avatar localization with a mock; real frame detection
has its own geometry tests in test_avatar_locator.py.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import avatar_match
import header_avatar
import recognize


def row(text, x, y):
    return {"text": text, "confidence": 0.99, "x": x, "y": y,
            "box": [x-40, y-10, x+40, y+10]}


def match(character="提弗洛斯", review=False):
    return {"character": None if review else character, "candidate": character,
            "needs_review": review, "similarity": 0.4 if review else 0.95,
            "margin": 0.01 if review else 0.3}


class PrototypeAudit(unittest.TestCase):
    def parse_case(self, rows, bars, saturated=True, answer=None):
        im = np.full((600, 1000, 3), 210, dtype=np.uint8)
        if saturated:
            im[:, :, 0] = 60
        def located(_image, bar):
            x, y, _, h = bar
            return {"box": [x-70, y-10, 60, 60],
                    "method": "frame_component", "needs_review": False}
        with patch.object(recognize, "find_bars", return_value=bars), \
             patch.object(recognize, "locate_avatar", side_effect=located), \
             patch.object(recognize, "save_image", return_value=None), \
             patch("avatar_match.match_avatar", return_value=answer or match()):
            return recognize.parse(im, rows, Path("synthetic_no_files_written"))

    def base_rows(self, event="58抽"):
        return [row("冬猎", 120, 100), row("合计60抽垫2", 240, 145),
                row(event, 230, 250)]

    def test_text_helpers_and_named_banner(self):
        self.assertEqual(recognize.clean("春雷动，万物生 2026/10"), "春雷动万物生202610")
        self.assertEqual(recognize.first_number("已垫66抽"), 66)
        self.assertIsNone(recognize.first_number("未抽出六星"))
        self.assertEqual(recognize.banner_from_text("拳出无悔")[1], "拳出无悔")
        self.assertEqual(recognize.BANNERS["拳出无悔"], "弭弗")
        self.assertEqual(recognize.BANNERS["逐罪者"], "卡缪")
        self.assertEqual(recognize.BANNERS["临渊望北"], "诀")
        self.assertEqual(recognize.banner_from_text("万物更新")[1], "万物更新")
        self.assertEqual(recognize.BANNERS["万物更新"], "祀")

    def test_template_top1_is_not_automatic_acceptance(self):
        value = avatar_match.match_avatar(np.full((60, 60, 3), 235, dtype=np.uint8))
        self.assertIsNotNone(value["candidate"])
        self.assertIsNone(value["character"])
        self.assertTrue(value["needs_review"])

    def test_bar_joined_to_colored_avatar_is_recovered_once(self):
        image = np.full((600, 1000, 3), 235, dtype=np.uint8)
        color = (20, 210, 240)
        expected = [[180, y, 300, 50] for y in (60, 160, 260, 390)]
        for x, y, w, h in expected:
            image[y:y+h, x:x+w] = color
        # The closing kernel joins this avatar to the fourth bar across a
        # six-pixel gap. Three intact rows establish the shared bar column.
        image[380:450, 90:174] = color
        self.assertEqual(recognize.find_bars(image), expected)

    def test_compact_rows_follow_the_portrait_column_at_different_scales(self):
        for height in (25, 37):
            with self.subTest(height=height):
                image = np.full((600, 1000, 3), 235, dtype=np.uint8)
                left, side = round(2.45*height), round(1.35*height)
                expected = []
                for number, y in enumerate((80, 230, 390)):
                    gap = 2 if number == 2 else round(.25*height)
                    top = y + (height-side)//2
                    image[top:top+side, left-gap-side:left-gap] = (40, 160, 225)
                    width = 3*height + number*55
                    image[y:y+height, left:left+width] = (0, 220, 190)
                    expected.append([left,y,width,height])
                    # Small portraits are sometimes shown beneath each pull.
                    for i in range(4):
                        start = left + i*(height//2+2)
                        image[y+height+6:y+height+6+height//2, start:start+height//2] = (30, 100, 190)
                self.assertEqual(recognize.find_bars(image), expected)

    def test_single_compact_row_wins_over_a_summary_badge_without_portrait(self):
        image = np.full((450, 1000, 3), 235, dtype=np.uint8)
        image[30:80, 220:370] = (0, 220, 190)
        image[225:273, 30:78] = (90, 110, 140)
        image[230:267, 90:202] = (0, 220, 190)
        self.assertEqual(recognize.find_bars(image), [[90,230,112,37]])

    def test_main_and_rush_are_separated_when_label_is_read(self):
        rows = self.base_rows() + [row("免费十连", 150, 320), row("4抽", 230, 400)]
        pools = self.parse_case(rows, [[180, 230, 300, 40], [180, 380, 300, 40]])
        self.assertEqual([e["pulls"] for e in pools[0]["events"]], [58])
        self.assertEqual([e["pulls"] for e in pools[0]["rush"]], [4])
        self.assertTrue(pools[0]["rush_present"])

    def test_bottom_pool_without_six_star_rows_is_retained(self):
        # A visible pool card with zero six-star hits still carries pulls and
        # pity. It must not disappear merely because there is no colored bar.
        rows = self.base_rows() + [
            row("熔火灼痕01月22日～02月07日", 220, 450),
            row("合计5抽垫5?产出100", 230, 505),
            row("该卡池未抽出六星", 500, 560),
        ]
        pools = self.parse_case(rows, [[180, 230, 300, 40]])
        self.assertEqual([p["banner"] for p in pools], ["冬猎", "熔火灼痕"])
        first_pool = pools[-1]
        self.assertEqual((first_pool["total"], first_pool["tail"]), (5, 5))
        self.assertEqual(first_pool["events"], [])
        self.assertEqual(first_pool["rush"], [])
        self.assertFalse(first_pool["rush_present"])
        self.assertEqual(first_pool["needs_review"], [])

    def test_damaged_title_uses_reliable_header_avatar_and_never_merges_rush(self):
        rows=self.base_rows()+[row("免费十连",150,320),row("10抽",230,350),
                              row("破损池名",120,400),row("合计49抽垫0产出4160",240,440),row("49抽",230,510)]
        recovery={'banner':'熔火灼痕','up':'莱万汀','needs_review':False,'box':[890,420,40,40]}
        with patch.object(header_avatar,'recover_header_banner',return_value=recovery):
            pools=self.parse_case(rows,[[180,230,300,40],[180,490,300,40]],answer=match('莱万汀'))
        self.assertEqual([p['banner'] for p in pools],['冬猎','熔火灼痕'])
        self.assertEqual(pools[0]['rush'],[])
        self.assertEqual([e['pulls'] for e in pools[1]['events']],[49])
        self.assertEqual(pools[1]['evidence']['bannerIdentity'],recovery)
        self.assertEqual(pools[1]['cardBoundary']['totalY'],440)

    def test_unknown_header_is_still_a_boundary_and_keeps_its_evidence(self):
        rows=self.base_rows()+[row("免费十连",150,320),row("破损池名",120,400),
                              row("合计49抽垫0产出4160",240,440),row("49抽",230,510)]
        with patch.object(header_avatar,'recover_header_banner',return_value={'banner':None,'needs_review':True}):
            pools=self.parse_case(rows,[[180,230,300,40],[180,490,300,40]],answer=match('莱万汀'))
        self.assertEqual(len(pools),2);self.assertIsNone(pools[1]['banner']);self.assertEqual(pools[0]['rush'],[])
        self.assertEqual(pools[1]['events'][0]['character'],'莱万汀')
        self.assertIsNone(pools[1]['events'][0]['off'])
        self.assertIn('banner_identity_unknown',pools[1]['needs_review'])

    def test_absent_title_and_duplicate_ocr_total_do_not_create_duplicate_cards(self):
        rows=self.base_rows()+[row("免费十连",150,320),row("合计49抽",240,440),row("合计49抽",241,442),row("49抽",230,510)]
        with patch.object(header_avatar,'recover_header_banner',return_value={'banner':None,'needs_review':True}):
            pools=self.parse_case(rows,[[180,230,300,40],[180,490,300,40]])
        self.assertEqual(len(pools),2);self.assertEqual(pools[0]['rush'],[])
        self.assertEqual(pools[1]['banner_raw'],'');self.assertEqual(pools[1]['total'],49)

    def test_unrelated_total_without_any_character_evidence_does_not_create_a_pool(self):
        with patch.object(header_avatar,'recover_header_banner',return_value={'banner':None,'needs_review':True}):
            self.assertEqual(self.parse_case([row('合计50抽',240,145)],[]),[])

    def test_heading_and_total_in_one_ocr_row_are_one_card(self):
        with patch.object(header_avatar,'recover_header_banner',side_effect=AssertionError('title already known')):
            pools=self.parse_case([row('冬猎合计49抽',240,145),row('49抽',230,250)],[[180,230,300,40]])
        self.assertEqual(len(pools),1);self.assertEqual(pools[0]['total'],49)

    def test_recovered_duplicate_banner_is_quarantined_instead_of_merged(self):
        rows=self.base_rows()+[row('破损池名',120,400),row('合计49抽',240,440)]
        with patch.object(header_avatar,'recover_header_banner',return_value={'banner':'冬猎','needs_review':False}):
            pools=self.parse_case(rows,[])
        self.assertIsNone(pools[1]['banner']);self.assertEqual(pools[1]['evidence']['bannerIdentity']['reason'],'duplicate_banner_identity')

    def test_raw_pity_conflict_is_preserved_and_flagged(self):
        pools = self.parse_case(self.base_rows("29抽已垫66抽歪"), [[180, 230, 300, 40]])
        event = pools[0]["events"][0]
        self.assertEqual((event["pulls"], event["pity"]), (29, 66))
        self.assertIn("raw_pity_plus_pulls_exceeds_80_do_not_autocorrect", pools[0]["needs_review"])

    def test_grey_placeholder_not_fabricated_as_six_star(self):
        pools = self.parse_case(self.base_rows("10抽"), [[180, 230, 300, 40]], saturated=False)
        self.assertEqual(pools[0]["events"], [])
        self.assertEqual(pools[0]["open_interval"]["kind"], "no_six")

    def test_placeholder_frame_fallback_keeps_manual_review_warning(self):
        # A missing screenshot section must not become a silent valid row just
        # because the fallback crop resembles a grey no-hit placeholder.
        im = np.full((600, 1000, 3), 210, dtype=np.uint8)
        location = {"box": [110, 220, 60, 60], "method": "fallback",
                    "needs_review": True}
        rows = self.base_rows("10抽")
        with patch.object(recognize, "find_bars", return_value=[[180, 230, 300, 40]]), \
             patch.object(recognize, "locate_avatar", return_value=location), \
             patch.object(recognize, "save_image", return_value=None):
            pool = recognize.parse(im, rows, Path("synthetic_no_files_written"))[0]
        self.assertEqual(pool["events"], [])
        self.assertEqual(pool["open_interval"]["kind"], "no_six")
        self.assertEqual(pool["open_interval"]["needs_review"],
                         "avatar_frame_not_found_check_source_or_manual_entry")
        self.assertIn("placeholder_needs_review", pool["needs_review"])

    @unittest.expectedFailure
    def test_known_risk_low_saturation_real_portrait_is_not_silently_lost(self):
        # A synthetic desaturated portrait cannot safely be rejected using colour alone.
        pools = self.parse_case(self.base_rows("58抽歪"), [[180, 230, 300, 40]],
                                saturated=False, answer=match("骏卫"))
        self.assertEqual(len(pools[0]["events"]), 1)

    def test_abstention_and_missing_off_badge_require_review(self):
        pools = self.parse_case(self.base_rows(), [[180, 230, 300, 40]],
                                answer=match("骏卫", review=True))
        event = pools[0]["events"][0]
        self.assertTrue(event.get("needs_review") or pools[0]["needs_review"])
        self.assertIsNone(event["character"])
        self.assertIsNone(event["off"])

    @unittest.expectedFailure
    def test_known_risk_missing_tail_must_not_silently_become_zero(self):
        rows = [row("冬猎", 120, 100), row("合计60抽", 240, 145), row("58抽", 230, 250)]
        pool = self.parse_case(rows, [[180, 230, 300, 40]])[0]
        self.assertTrue(pool["tail"] is None or pool["needs_review"])

    def test_recognition_source_has_no_truth_file_reference(self):
        # Static guard only: this is not a security proof against arbitrary future code.
        for module in (recognize, avatar_match):
            tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
            docstring = tree.body[0].value.value if isinstance(tree.body[0], ast.Expr) else None
            literals = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)
                        and isinstance(n.value, str) and n.value != docstring]
            self.assertFalse([s for s in literals if "truth" in s.lower()])

    def test_ocr_cache_is_explicit_opt_in_and_logged(self):
        source = Path(recognize.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        cli_calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                     and any(isinstance(a, ast.Constant) and a.value == "--reuse-ocr" for a in n.args)]
        self.assertEqual(len(cli_calls), 1)
        kwargs = {k.arg: k.value.value for k in cli_calls[0].keywords if isinstance(k.value, ast.Constant)}
        self.assertEqual(kwargs.get("action"), "store_true")
        self.assertFalse(kwargs.get("default", False))
        self.assertIn("ocr_cache_used=reused", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
