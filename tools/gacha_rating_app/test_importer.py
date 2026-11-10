"""Deterministic adapter tests. No MC, no answer files, no network."""
import copy
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from importer import (BANNERS, _has_detail_layout, augment_pools, build_ledger, parse_identity,
                      parse_summary, parse_weapon, recover_weapon_average)


def row(text, x, y):
    return {"text": text, "x": x, "y": y, "box": [x - 35, y - 9, x + 35, y + 9], "confidence": .98}


def pool(name="熔火灼痕", total=20, tail=5, events=None, **extras):
    result = {"banner": name, "total": total, "tail": tail, "tail_known": True, "quota": 2580,
              "header_raw": f"合计{total}抽垫{tail}产出2580", "rushUsed": False,
              "events": events if events is not None else [{"pulls": 15, "character": "莱万汀", "pity": None}],
              "rush": [], "token_count": 0, "issues": []}
    result.update(extras)
    return result


def doc(pools=None, uid="12345678", sha="a", weapon=None):
    return {"file": sha + ".png", "source_sha256": sha, "kind": "character",
            "identity": {"uid": uid}, "pools": pools if pools is not None else [pool()],
            "weapon": weapon, "issues": []}


def codes(ledger):
    entries = ledger["issues"] + ledger["character"]["issues"]
    for p in ledger["character"]["pools"]:
        entries += p["issues"]
    if ledger["weapon"]:
        entries += ledger["weapon"]["issues"]
    return {i["code"] for i in entries}


class SummaryTests(unittest.TestCase):
    def test_banner_order_and_six_star_names_match_recognizer_and_avatar_catalog(self):
        import sys
        prototype=Path(__file__).resolve().parents[1]/'gacha_ocr_prototype'
        sys.path.insert(0,str(prototype))
        import recognize
        self.assertEqual(list(BANNERS.items()), list(reversed(recognize.BANNERS.items())))
        self.assertEqual(list(BANNERS.items())[11:13], [('万物更新','祀'), ('烟火邀星河','明河')])
        manifest=json.loads((prototype/'assets/manifest.json').read_text(encoding='utf-8'))
        self.assertCountEqual([item['name'] for item in manifest['characters']],
                              [*BANNERS.values(), *recognize.COMMON_CHARACTERS])

    def test_si_banner_preserves_gift_and_chronological_waits(self):
        waits=[(13,'祀'),(72,'别礼'),(68,'祀'),(69,'祀'),(19,'祀'),(31,'骏卫'),(63,'艾尔黛拉'),(59,'祀')]
        events=[{'pulls':n,'character':name,'pity':12 if i==7 else None} for i,(n,name) in enumerate(waits)]
        ledger=build_ledger([doc([pool('万物更新',total=401,tail=7,events=events,
            quota=33060,token_count=1,rushUsed=None)])])
        p=ledger['character']['pools'][0]
        self.assertEqual((p['index'],p['up'],p['initialPity'],p['tail']),(11,'祀',12,7))
        self.assertEqual([e['at'] for e in p['events']],[59,122,153,172,241,309,381,394])
        self.assertEqual(p['tokens'][0]['at'],240)
        self.assertIsNone(p['rushUsed'])
        self.assertIn('rush_usage_unknown',codes(ledger))
        self.assertNotIn('unknown_banner',codes(ledger))

    def rows(self):
        return [row("限定", 190, 400), row("复刻", 470, 400), row("武器", 750, 400),
                row("691", 160, 460), row("抽", 230, 460), row("12/6", 140, 550),
                row("360", 720, 460), row("抽", 790, 460), row("20 /16", 695, 550),
                row("77.8", 810, 550), row("出卡数/歪", 690, 585)]

    def test_split_total(self):
        self.assertEqual(parse_summary(self.rows(), "限定")["N"], 691)

    def test_detail_cards_can_identify_a_screenshot_without_the_logo(self):
        for title in ("冬猎", "幽寒申领"):
            with self.subTest(title=title):
                detail = [row(title, 100, 30), row("合计60抽垫2", 170, 90)]
                self.assertTrue(_has_detail_layout(detail))
                self.assertFalse(_has_detail_layout(detail[:1]))
                self.assertFalse(_has_detail_layout(detail[1:]))
                self.assertFalse(_has_detail_layout([detail[0], row("合计60抽垫2", 170, 510)]))

    def test_result_badge_in_cropped_card_cannot_create_top_summary(self):
        body = [row("限定", 860, 70), row("35抽", 250, 135)]
        self.assertIsNone(parse_summary(body, "限定"))

    def test_weapon_off_is_not_up(self):
        result = parse_summary(self.rows(), "武器")
        self.assertEqual((result["N"], result["K6"], result["KU"]), (360, 20, 4))

    def test_weapon_average_is_aligned_to_its_own_caption(self):
        rows = self.rows() + [row("UP平均", 810, 585), row("99.9", 670, 550)]
        result = parse_weapon(rows)
        self.assertEqual(result["upAverage"], 77.8)
        self.assertEqual((result["N"], result["K6"], result["KU"]), (360, 20, 4))
        self.assertEqual({r["text"] for r in result["upAverageEvidence"]}, {"77.8", "UP平均"})

    def test_weapon_average_missing_never_uses_total_or_another_column(self):
        rows = [r for r in self.rows() if r["text"] != "77.8"]
        rows += [row("UP平均", 810, 585), row("66.6", 530, 550)]
        self.assertIsNone(parse_weapon(rows)["upAverage"])
        # Even a nearby integer total may not substitute for the count row.
        rows += [row("360", 810, 510)]
        self.assertIsNone(parse_weapon(rows)["upAverage"])

    def test_weapon_average_nearest_aligned_numeric_and_inline_value(self):
        rows = self.rows() + [row("UP平均", 810, 585), row("88.8", 810, 530)]
        self.assertEqual(parse_weapon(rows)["upAverage"], 77.8)
        rows = self.rows() + [row("UP平均：51.5", 810, 585)]
        self.assertEqual(parse_weapon(rows)["upAverage"], 51.5)

    def test_conflicting_same_position_average_is_unavailable(self):
        rows = self.rows() + [row("UP平均", 810, 585), row("99.9", 810, 550)]
        self.assertIsNone(parse_weapon(rows)["upAverage"])

    def test_recover_old_weapon_average_is_read_only_and_respects_explicit_clear(self):
        weapon = {"N": 360, "K6": 20, "KU": 4,
                  "evidence": {"rows": self.rows() + [row("UP平均", 810, 585)]}}
        before = copy.deepcopy(weapon)
        recovered = recover_weapon_average(weapon)
        # A production weapon evidence column contains only its own rows.
        self.assertEqual(recovered["value"], 77.8)
        self.assertEqual(recovered["source"], "weapon.evidence.rows")
        recovered["evidence"][0]["text"] = "changed copy"
        self.assertEqual(weapon, before)
        weapon["upAverage"] = None
        self.assertIsNone(recover_weapon_average(weapon))
        weapon["upAverage"] = 51.5
        self.assertEqual(recover_weapon_average(weapon)["value"], 51.5)
        self.assertEqual(recover_weapon_average(weapon)["source"], "weapon.upAverage")

    def test_recovered_average_and_decimal_string_follow_ui_number_contract(self):
        old = {"N": 680, "K6": 33, "KU": 11, "evidence": {"rows": [
            row("680", 730, 460), row("33/22", 700, 550),
            row("51.5", 810, 550), row("UP平均", 810, 585)]}}
        recovered = recover_weapon_average(old)
        self.assertEqual(recovered["value"], 51.5)
        self.assertIsInstance(recovered["value"], (int, float))
        string_value = dict(old, upAverage="51.5")
        self.assertEqual(recover_weapon_average(string_value)["value"], 51.5)
        ledger_weapon = build_ledger([doc(weapon=string_value)])["weapon"]
        self.assertEqual(ledger_weapon["upAverage"], 51.5)
        self.assertIsInstance(ledger_weapon["upAverage"], (int, float))
        if shutil.which("node"):
            model_path = str(Path(__file__).resolve().parent / "static" / "ui-model.js")
            script = "const ui=require(process.argv[1]);const w=JSON.parse(process.argv[2]);if(!Number.isFinite(w.upAverage)||ui.validateWeapon(w).length)process.exit(1);"
            subprocess.run(["node", "-e", script, model_path,
                            json.dumps({"N": 680, "K6": 33, "KU": 11, "upAverage": recovered["value"]})], check=True)

    def test_average_recovery_never_returns_nonfinite_or_boolean_number(self):
        for value in (True, False, "NaN", float("inf"), "1e1000", [], {}):
            with self.subTest(value=value):
                self.assertIsNone(recover_weapon_average({"upAverage": value}))

    def test_weapon_missing_detail_does_not_invent_ten(self):
        self.assertIsNone(parse_weapon(self.rows())["B"])

    def test_weapon_detail_count(self):
        rows = self.rows() + [row("军列申领", 100, 900), row("合计160抽垫3", 200, 940),
                              row("幽寒申领", 100, 1400), row("合计200抽垫1", 200, 1440)]
        self.assertEqual(parse_weapon(rows)["B"], 2)

    def test_weapon_cropped_detail_does_not_publish_wrong_b(self):
        rows = self.rows() + [row("军列申领", 100, 900), row("合计160抽垫3", 200, 940)]
        self.assertIsNone(parse_weapon(rows)["B"])
        self.assertEqual(parse_weapon(rows)["issues"][0]["code"], "weapon_detail_total_mismatch")

    def test_identity(self):
        result = parse_identity([row("UID:12345678", 850, 80), row("Example", 250, 85), row("官服", 200, 130)])
        self.assertEqual(result["uid"], "12345678")
        self.assertEqual(result["name"], "Example")

    def test_unknown_tail_not_zero(self):
        p = pool(header_raw="合计20抽产出2580")
        self.assertIsNone(augment_pools([p], [])[0]["tail"])

    def test_missing_rush_title_not_false(self):
        p = pool(total=60, rush_present=False)
        self.assertIsNone(augment_pools([p], [])[0]["rushUsed"])

    def test_locked_rush_is_false(self):
        p = pool(total=20, rush_present=False)
        self.assertIs(augment_pools([p], [])[0]["rushUsed"], False)

    def test_empty_rush_is_used(self):
        p = pool(total=60, rush_present=True, rush_no_six={"pulls": 10})
        result = augment_pools([p], [])[0]
        self.assertIs(result["rushUsed"], True)
        self.assertEqual(result["rushAt"], 30)
        self.assertEqual(result["rush_timing_evidence"], "user-default-after-main-30")

    def test_rush_unknown_does_not_get_default_time(self):
        p = pool(total=60, rush_present=False)
        result = augment_pools([p], [])[0]
        self.assertIsNone(result["rushUsed"])
        self.assertIsNone(result["rushAt"])

    def test_explicit_later_rush_time_survives_augmentation(self):
        p = pool(total=60, rush_present=True, rush_no_six={"pulls": 10}, rushAt=50)
        result = augment_pools([p], [])[0]
        self.assertEqual(result["rushAt"], 50)
        self.assertEqual(result["rush_timing_evidence"], "provided-main-position")

    def test_quota_extraction(self):
        self.assertEqual(augment_pools([pool(header_raw="合计60抽垫2?产出@5000")], [])[0]["quota"], 5000)

    def test_contained_duplicate_quota_box_not_concatenated(self):
        p = pool(banner_raw="熔火灼痕", header_raw="合计60抽垫2产出50005000")
        rows = [row("熔火灼痕", 100, 100), row("产出5000", 400, 160), row("5000", 455, 160)]
        self.assertEqual(augment_pools([p], rows)[0]["quota"], 5000)

    def test_conflicting_quota_boxes_remain_unknown(self):
        p = pool(banner_raw="熔火灼痕")
        rows = [row("熔火灼痕", 100, 100), row("产出5000", 400, 160), row("产出5800", 400, 165)]
        self.assertIsNone(augment_pools([p], rows)[0]["quota"])

    def test_split_quota_label_and_number(self):
        p = pool(banner_raw="熔火灼痕")
        rows = [row("熔火灼痕", 100, 100), row("产出", 400, 160), row("5000", 480, 160)]
        self.assertEqual(augment_pools([p], rows)[0]["quota"], 5000)


class LedgerTests(unittest.TestCase):
    def test_launch_initial_state(self):
        result = build_ledger([doc()])
        self.assertTrue(result["character"]["completeHistory"])
        self.assertEqual(result["character"]["initialOwned"], [])

    def test_truncated_initial_state_unknown(self):
        result = build_ledger([doc([pool("冬猎")])])
        self.assertIsNone(result["character"]["initialPity"])
        self.assertIsNone(result["character"]["initialOwned"])

    def test_zero_pull_banner_gaps_need_exact_header_proof(self):
        d = doc([pool(), pool("春雷动，万物生")])
        self.assertFalse(build_ledger([d])["character"]["completeHistory"])
        d["overview"] = {"character": {"N": 40, "K6": 2}}
        result = build_ledger([d])
        self.assertTrue(result["character"]["completeHistory"])
        self.assertEqual(result["character"]["historyEvidence"], "launch_and_exact_category_totals_zero_pull_gaps")

    def test_bad_header_cannot_fill_missing_banners(self):
        d = doc([pool(), pool("春雷动，万物生")])
        d["overview"] = {"character": {"N": 50, "K6": 2}}
        self.assertFalse(build_ledger([d])["character"]["completeHistory"])

    def test_cross_pool_nohit_carry(self):
        p1 = pool(total=31, tail=22, events=[{"pulls": 9, "character": "骏卫"}])
        p2 = pool("轻飘飘的信使", total=5, tail=5, events=[])
        p3 = pool("热烈色彩", total=5, tail=5, events=[])
        p4 = pool("河流的女儿", total=40, tail=2, events=[{"pulls": 38, "pity": 32, "character": "汤汤"}])
        result = build_ledger([doc([p4, p3, p2, p1])])
        pools = result["character"]["pools"]
        self.assertEqual([p["tail"] for p in pools], [22, 27, 32, 2])
        self.assertEqual(pools[3]["events"][0]["at"], 38)  # Not 38 + 32.
        self.assertNotIn("inherited_pity_conflict", codes(result))

    def test_explicit_pity_contradiction_preserved(self):
        result = build_ledger([doc([pool(), pool("轻飘飘的信使", total=10, tail=4, events=[{"pulls": 6, "pity": 42, "character": "骏卫"}])])])
        self.assertIn("inherited_pity_conflict", codes(result))

    def test_force_120(self):
        p = pool(total=120, tail=0, events=[{"pulls": 70, "character": "莱万汀"}, {"pulls": 50, "character": "骏卫"}], rushUsed=True)
        result = build_ledger([doc([p])])
        self.assertTrue(result["character"]["pools"][0]["events"][-1]["forced"])

    def test_no_force_after_earlier_up(self):
        p = pool(total=120, tail=0, events=[{"pulls": 70, "character": "莱万汀"}, {"pulls": 50, "character": "莱万汀"}], rushUsed=True)
        self.assertFalse(build_ledger([doc([p])])["character"]["pools"][0]["events"][-1]["forced"])

    def test_rush_up_does_not_remove_120(self):
        p = pool(total=120, tail=0, events=[{"pulls": 70, "character": "莱万汀"}, {"pulls": 50, "character": "骏卫"}],
                 rushUsed=True, rush=[{"pulls": 7, "character": "莱万汀"}])
        self.assertTrue(build_ledger([doc([p])])["character"]["pools"][0]["events"][-1]["forced"])

    def test_ledger_rush_default_30_with_evidence(self):
        p = pool(total=60, tail=45, rushUsed=True, rush=[{"pulls": 2, "character": "骏卫"}])
        p["issues"] = [{"code": "rush_timing_unknown", "severity": "warning", "message": "old draft"}]
        result = build_ledger([doc([p])])
        canonical = result["character"]["pools"][0]
        self.assertEqual(canonical["rushAt"], 30)
        self.assertEqual(canonical["rushTimingEvidence"], "user-default-after-main-30")
        self.assertNotIn("rush_timing_unknown", codes(result))

    def test_old_cache_rush_used_defaults_30(self):
        p = pool(total=60, tail=45, rush_present=True, rush_no_six={"pulls": 10})
        del p["rushUsed"]
        canonical = build_ledger([doc([p])])["character"]["pools"][0]
        self.assertIs(canonical["rushUsed"], True)
        self.assertEqual(canonical["rushAt"], 30)

    def test_preunlock_used_rush_not_given_default(self):
        p = pool(total=20, rushUsed=True)
        result = build_ledger([doc([p])])
        self.assertIsNone(result["character"]["pools"][0]["rushAt"])
        self.assertIn("rush_before_unlock", codes(result))

    def test_explicit_rush_time_valid_preserved_invalid_not_swallowed(self):
        for at in (45, 29, 61, "30", 30.5, True):
            with self.subTest(at=at):
                p = pool(total=60, tail=45, rushUsed=True, rushAt=at)
                result = build_ledger([doc([p])])
                canonical = result["character"]["pools"][0]
                self.assertEqual(canonical["rushAt"], at)
                self.assertEqual("rush_timing_invalid" in codes(result), at != 45)

    def test_unused_rush_no_time(self):
        p = pool(total=60, tail=45, rushUsed=False)
        canonical = build_ledger([doc([p])])["character"]["pools"][0]
        self.assertIsNone(canonical["rushAt"])

    def test_explicit_time_with_unused_rush_is_conflict(self):
        p = pool(total=60, tail=45, rushUsed=False, rushAt=30)
        self.assertIn("rush_timing_without_use", codes(build_ledger([doc([p])])))

    def test_missing_120_up_blocks(self):
        p = pool(total=120, tail=60, events=[{"pulls": 60, "character": "骏卫"}], rushUsed=True)
        self.assertIn("missing_120_up", codes(build_ledger([doc([p])])))

    def test_sha_dedup(self):
        result = build_ledger([doc(), doc()])
        self.assertEqual(len(result["sources"]), 1)
        self.assertIn("duplicate_source_ignored", codes(result))

    def test_overlap_dedup(self):
        result = build_ledger([doc(), doc(sha="b")])
        self.assertEqual(len(result["character"]["pools"]), 1)
        self.assertIn("overlapping_pool_deduplicated", codes(result))

    def test_overlap_conflict(self):
        result = build_ledger([doc(), doc([pool(total=21)], sha="b")])
        self.assertIn("overlapping_pool_conflict", codes(result))

    def test_account_mismatch(self):
        result = build_ledger([doc(), doc(uid="87654321", sha="b")])
        self.assertIn("account_mismatch", codes(result))

    def test_no_uid_merge_not_silent(self):
        result = build_ledger([doc(), doc(uid=None, sha="b")])
        self.assertIn("account_unverified", codes(result))

    def test_weapon_header_and_detail_merge(self):
        header = {"N": 360, "K6": 20, "KU": 4, "B": None, "H80": None}
        detail = dict(header, B=5)
        result = build_ledger([doc(weapon=header), doc([], sha="b", weapon=detail)])
        self.assertEqual(result["weapon"]["B"], 5)
        self.assertIsNone(result["weapon"]["H80"])

    def test_weapon_average_merge_preserves_evidence_and_raw_counts(self):
        header = {"N": 360, "K6": 20, "KU": 4, "B": None, "H80": None,
                  "upAverage": "51.5", "upAverageEvidence": [row("51.5", 800, 550)]}
        detail = {"N": 360, "K6": 20, "KU": 4, "B": 5, "H80": None}
        for sequence in ([doc(weapon=header), doc([], sha="b", weapon=detail)],
                         [doc(weapon=detail), doc([], sha="b", weapon=header)]):
            weapon = build_ledger(sequence)["weapon"]
            self.assertEqual(weapon["upAverage"], 51.5)
            self.assertEqual(weapon["upAverageEvidence"], header["upAverageEvidence"])
            self.assertEqual((weapon["N"], weapon["K6"], weapon["KU"], weapon["B"]), (360, 20, 4, 5))

    def test_unused_average_difference_does_not_block_real_count_conflicts(self):
        header = {"N": 360, "K6": 20, "KU": 4, "B": None, "upAverage": "51.50"}
        equal = dict(header, upAverage=51.5)
        self.assertNotIn("weapon_summary_conflict", codes(build_ledger([doc(weapon=header), doc([], sha="b", weapon=equal)])))
        other = dict(header, upAverage="49.8")
        result = build_ledger([doc(weapon=header), doc([], sha="b", weapon=other)])
        self.assertFalse(any(i["code"] == "weapon_summary_conflict" for i in result["weapon"]["issues"]))
        conflict = build_ledger([doc(weapon=header), doc([], sha="b", weapon=dict(other, K6=19))])
        self.assertTrue(any(i["code"] == "weapon_summary_conflict" and i.get("field") == "K6"
                            for i in conflict["weapon"]["issues"]))

    def test_unknown_weapon_pool_count_warning_not_scoring_block(self):
        header = {"N": 360, "K6": 20, "KU": 4, "B": None, "H80": None}
        result = build_ledger([doc(weapon=header)])
        entries = [i for i in result["weapon"]["issues"] if i["code"] == "weapon_pool_count_missing"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["severity"], "warning")
        self.assertIsNone(result["weapon"]["B"])

    def test_weapon_disjoint_totals_not_added(self):
        header = {"N": 360, "K6": 20, "KU": 4, "B": None, "H80": None}
        other = dict(header, N=370)
        self.assertIn("weapon_summary_conflict", codes(build_ledger([doc(weapon=header), doc([], sha="b", weapon=other)])))

    def test_token_not_counted_as_hit(self):
        events = [{"pulls": 60, "character": "莱万汀"} for _ in range(4)]
        p = pool(total=240, tail=0, events=events, rushUsed=True, token_count=1)
        actual = build_ledger([doc([p])])["character"]["pools"][0]
        self.assertEqual(len(actual["events"]), 4)
        self.assertEqual(actual["tokens"][0]["at"], 240)


if __name__ == "__main__":
    unittest.main()
