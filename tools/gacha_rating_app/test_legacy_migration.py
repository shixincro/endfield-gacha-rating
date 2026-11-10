"""Saved JSON migration regressions; no OCR, player writes, or simulation."""
import copy
import unittest
from unittest.mock import patch

from importer import (CHAR_AXES, RECOGNITION_VERSION, augment_pools, build_ledger,
                      issue, migrate_legacy_ledger, revalidate_ledger_issues)


def fixture(*, raw_character='莱万汀', avatar_character='艾尔黛拉', reason='avatar_disagrees_with_missing_off_badge'):
    event = {'pulls': 15, 'pity': None, 'character': raw_character, 'off': False,
             'identitySource': 'banner_and_badge', 'raw_text': '15抽超非',
             'crop': 'C:/saved/crops/00_00.png', 'needs_review': reason,
             'avatar_match': {'character': avatar_character, 'needs_review': False},
             'avatar_location': {'needs_review': False}}
    review = issue('event_needs_review', '旧识别标记', 'error', CHAR_AXES)
    raw = {'banner': '熔火灼痕', 'total': 20, 'tail': 5, 'tail_known': True,
           'header_raw': '合计20抽垫5产出2560', 'quota': 2560, 'rushUsed': False,
           'events': [event], 'rush': [], 'token_count': 0,
           'issues': [copy.deepcopy(review)], 'needs_review': ['event_needs_review']}
    document = {'file': 'old.png', 'source_sha256': 'source-a', 'kind': 'character',
                'identity': {'uid': '12345678'}, 'pools': [raw], 'issues': [],
                'overview': {'character': {'N': 20, 'K6': 1, 'off': 1}}}
    ledger = build_ledger([document])
    ledger['issues'].append(issue('events_need_review', '旧根级标记', 'error', CHAR_AXES))
    return [document], ledger


def pool(ledger):
    return ledger['character']['pools'][0]


def event(ledger):
    return pool(ledger)['events'][0]


def reviews(ledger):
    return [i for i in pool(ledger)['issues'] if i['code'] in ('event_needs_review', 'events_need_review')]


class LegacyMigrationTests(unittest.TestCase):
    def migrate(self, documents, ledger, **kwargs):
        with patch('importer._prototype', side_effect=AssertionError('must not OCR')):
            result = migrate_legacy_ledger(documents, ledger, **kwargs)
            ledger['issues'] = revalidate_ledger_issues(documents, ledger)
        return result

    def test_unchanged_banner_guess_uses_saved_accepted_avatar_without_ocr(self):
        documents, ledger = fixture()
        original = copy.deepcopy(documents)
        event(ledger)['evidence']['crop'] = '/data/session/crops/00_00.png'
        result = self.migrate(documents, ledger)
        self.assertEqual(result['correctedIdentities'], 1)
        self.assertEqual(event(ledger)['character'], '艾尔黛拉')
        self.assertEqual(event(ledger)['identitySource'], 'avatar-saved-evidence')
        self.assertFalse(reviews(ledger))
        self.assertFalse(ledger['issues'])
        self.assertEqual(documents, original)
        snapshot = copy.deepcopy(ledger)
        again = self.migrate(documents, ledger)
        self.assertFalse(again['changed'])
        self.assertEqual(ledger, snapshot)

    def test_manually_corrected_identity_clears_old_pool_and_root_issues(self):
        documents, ledger = fixture()
        event(ledger)['character'] = '艾尔黛拉'
        event(ledger)['needsReview'] = 'old pending'
        result = self.migrate(documents, ledger, reviewed=True)
        self.assertEqual(result['correctedIdentities'], 0)
        self.assertEqual(event(ledger)['character'], '艾尔黛拉')
        self.assertNotIn('needsReview', event(ledger))
        self.assertFalse(reviews(ledger))
        self.assertFalse(ledger['issues'])

    def test_manual_identity_can_intentionally_disagree_with_avatar(self):
        documents, ledger = fixture()
        event(ledger)['identitySource'] = 'manual'
        result = self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertEqual(result['correctedIdentities'], 0)
        self.assertFalse(reviews(ledger))
        self.assertTrue(any(i['code'] == 'character_summary_mismatch' for i in ledger['issues']))

    def test_global_review_is_not_confirmation_of_every_event(self):
        documents, ledger = fixture()
        result = self.migrate(documents, ledger, reviewed=True)
        self.assertEqual(result['correctedIdentities'], 0)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertEqual(len(reviews(ledger)), 1)
        self.assertEqual(reviews(ledger)[0]['events'][0]['at'], 15)
        self.assertIn('可靠头像', reviews(ledger)[0]['events'][0]['reason'])

    def test_changed_position_does_not_waive_identity_conflict(self):
        documents, ledger = fixture()
        event(ledger)['at'] = 16
        self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['at'], 16)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertTrue(reviews(ledger))

    def test_low_confidence_is_not_promoted_to_avatar_answer(self):
        documents, ledger = fixture()
        avatar = documents[0]['pools'][0]['events'][0]['avatar_match']
        avatar.update(character=None, candidate='艾尔黛拉', needs_review=True)
        self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertTrue(reviews(ledger))

    def test_bad_frame_keeps_review_even_when_match_is_accepted(self):
        documents, ledger = fixture()
        documents[0]['pools'][0]['events'][0]['avatar_location']['needs_review'] = True
        self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertTrue(reviews(ledger))

    def test_avatar_from_outside_banner_is_not_accepted(self):
        documents, ledger = fixture(avatar_character='祀')
        self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertTrue(reviews(ledger))

    def test_explicit_off_badge_conflicting_with_up_survives(self):
        documents, ledger = fixture(avatar_character='莱万汀', reason='avatar_conflicts_with_off_badge')
        documents[0]['pools'][0]['events'][0]['off'] = True
        self.migrate(documents, ledger)
        self.assertTrue(reviews(ledger))
        self.assertIn('歪字', reviews(ledger)[0]['events'][0]['reason'])

    def test_manual_identity_still_requires_legal_character_and_position(self):
        documents, ledger = fixture()
        event(ledger).update(character='祀', at=None, identitySource='manual')
        self.migrate(documents, ledger)
        reason = reviews(ledger)[0]['events'][0]['reason']
        self.assertIn('不属于本池', reason)
        self.assertIn('位置', reason)

    def test_fixed_missing_identity_and_position_can_resolve(self):
        documents, ledger = fixture(raw_character=None, reason='missing_character_or_pulls')
        documents[0]['pools'][0]['events'][0]['pulls'] = None
        event(ledger).update(character='艾尔黛拉', at=15)
        self.migrate(documents, ledger)
        self.assertFalse(reviews(ledger))

    def test_opaque_reason_survives_automatic_recheck(self):
        documents, ledger = fixture(raw_character='艾尔黛拉', reason='unknown_future_conflict')
        self.migrate(documents, ledger)
        self.assertTrue(reviews(ledger))
        self.assertIn('unknown_future_conflict', reviews(ledger)[0]['events'][0]['reason'])

    def test_missing_saved_source_does_not_delete_old_review(self):
        documents, ledger = fixture()
        documents[0]['pools'] = []
        self.migrate(documents, ledger)
        self.assertTrue(reviews(ledger))
        self.assertTrue(any(i['code'] == 'events_need_review' for i in ledger['issues']))

    def test_explicit_pool_and_every_row_confirmation_resolve_missing_source_review(self):
        documents, ledger = fixture()
        documents[0]['pools'] = []
        pool(ledger)['eventReviewConfirmed'] = True
        event(ledger).update(character='艾尔黛拉', identityReviewed=True)
        self.migrate(documents, ledger, reviewed=True)
        self.assertFalse(reviews(ledger))
        self.assertFalse(any(i['code'] in ('event_needs_review', 'events_need_review') for i in ledger['issues']))
        from service import score_ledger
        scored = score_ledger(ledger)
        self.assertTrue(all(isinstance(scored['axes'][key]['score'], (int, float)) for key in CHAR_AXES))

    def test_confirmation_of_one_pool_cannot_clear_unconfirmed_missing_source_pool(self):
        documents, ledger = fixture()
        documents[0]['pools'] = []
        second = copy.deepcopy(pool(ledger))
        second.update(id='banner-1', index=1, banner='轻飘飘的信使', up='洁尔佩塔')
        ledger['character']['pools'].append(second)
        pool(ledger)['eventReviewConfirmed'] = True
        event(ledger).update(character='艾尔黛拉', identityReviewed=True)
        self.migrate(documents, ledger, reviewed=True)
        self.assertFalse(reviews(ledger))
        self.assertTrue(any(i['code'] == 'event_needs_review' for i in second['issues']))
        self.assertTrue(any(i['code'] == 'events_need_review' for i in ledger['issues']))

    def test_missing_source_confirmation_requires_each_current_row_and_nonempty_rows(self):
        for mode in ('only-pool-flag', 'only-row-flag', 'empty', 'new-unconfirmed-row'):
            with self.subTest(mode=mode):
                documents, ledger = fixture()
                documents[0]['pools'] = []
                pool(ledger)['eventReviewConfirmed'] = mode != 'only-row-flag'
                event(ledger).update(character='艾尔黛拉', identityReviewed=mode != 'only-pool-flag')
                if mode == 'empty':
                    pool(ledger)['events'] = []
                elif mode == 'new-unconfirmed-row':
                    pool(ledger)['events'].append({'at': 18, 'character': '余烬', 'forced': False})
                self.migrate(documents, ledger, reviewed=True)
                self.assertTrue(reviews(ledger))
                self.assertTrue(any(i['code'] == 'events_need_review' for i in ledger['issues']))

    def test_explicit_missing_source_confirmation_cannot_clear_invalid_row(self):
        documents, ledger = fixture()
        documents[0]['pools'] = []
        pool(ledger)['eventReviewConfirmed'] = True
        event(ledger).update(character='祀', at=None, identityReviewed=True)
        self.migrate(documents, ledger, reviewed=True)
        self.assertTrue(reviews(ledger))
        self.assertTrue(any(i['code'] == 'events_need_review' for i in ledger['issues']))

    def test_explicit_missing_source_confirmation_preserves_account_and_source_errors(self):
        documents, ledger = fixture()
        documents[0]['pools'] = []
        documents[0]['issues'].append(issue('unsupported_layout', '来源未确认', 'error', CHAR_AXES))
        other = copy.deepcopy(documents[0])
        other.update(file='other.png', source_sha256='different-source')
        other['identity']['uid'] = '87654321'
        documents.append(other)
        pool(ledger)['eventReviewConfirmed'] = True
        event(ledger).update(character='艾尔黛拉', identityReviewed=True)
        self.migrate(documents, ledger, reviewed=True)
        self.assertFalse(reviews(ledger))
        self.assertTrue({'unsupported_layout', 'account_mismatch'} <= {i['code'] for i in ledger['issues']})

    def test_explicit_confirmation_preserves_ambiguous_overlapping_source_conflict(self):
        documents, ledger = fixture()
        other = copy.deepcopy(documents[0])
        other.update(file='other.png', source_sha256='different-source')
        other['pools'][0]['events'][0]['character'] = '黎风'
        documents.append(other)
        pool(ledger).update(evidence={}, eventReviewConfirmed=True)
        event(ledger).update(character='艾尔黛拉', identityReviewed=True)
        self.migrate(documents, ledger, reviewed=True)
        self.assertFalse(reviews(ledger))
        self.assertTrue(any(i['code'] == 'overlapping_pool_conflict' for i in ledger['issues']))

    def test_duplicate_ambiguous_source_does_not_choose_an_avatar(self):
        documents, ledger = fixture()
        other = copy.deepcopy(documents[0])
        other['source_sha256'] = 'source-b'
        other['pools'][0]['events'][0]['character'] = '黎风'
        documents.append(other)
        pool(ledger)['evidence'] = {}
        self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertTrue(reviews(ledger))
        self.assertTrue(any(i['code'] == 'overlapping_pool_conflict' for i in ledger['issues']))

    def test_same_crop_name_from_another_source_cannot_repair_identity(self):
        documents, ledger = fixture()
        event(ledger)['evidence']['source_sha256'] = 'different-source'
        self.migrate(documents, ledger)
        self.assertEqual(event(ledger)['character'], '莱万汀')
        self.assertIn('来源', reviews(ledger)[0]['events'][0]['reason'])

    def test_true_source_and_unrelated_pool_errors_are_preserved(self):
        documents, ledger = fixture()
        documents[0]['issues'].append(issue('unsupported_layout', '真实来源错误', 'error', CHAR_AXES))
        pool(ledger)['issues'].append(issue('quota_ocr_conflict', '配额冲突', 'error', ['five']))
        self.migrate(documents, ledger)
        self.assertTrue(any(i['code'] == 'unsupported_layout' for i in ledger['issues']))
        self.assertTrue(any(i['code'] == 'quota_ocr_conflict' for i in pool(ledger)['issues']))

    def test_auto_correction_refreshes_later_120_forced_flag(self):
        documents, _ = fixture()
        raw = documents[0]['pools'][0]
        first = raw['events'][0]
        raw.update(total=120, tail=0, quota=8340, rushUsed=False)
        raw['events'] = [
            {'pulls': 45, 'character': '莱万汀', 'identitySource': 'avatar', 'crop': 'last.png'},
            {'pulls': 60, 'character': '黎风', 'identitySource': 'avatar', 'crop': 'middle.png'}, first]
        ledger = build_ledger(documents)
        self.assertFalse(pool(ledger)['events'][-1]['forced'])
        self.migrate(documents, ledger)
        self.assertTrue(pool(ledger)['events'][-1]['forced'])
        self.assertFalse(pool(ledger)['events'][0]['forced'])

    def test_manual_fix_can_clear_derived_issue_on_next_save(self):
        documents, ledger = fixture()
        self.migrate(documents, ledger, reviewed=True)
        self.assertTrue(reviews(ledger))
        event(ledger).update(character='艾尔黛拉', identitySource='manual')
        self.migrate(documents, ledger, reviewed=True)
        self.assertFalse(reviews(ledger))
        self.assertNotIn('needsReview', event(ledger))

    def test_same_valid_edited_ledger_recovers_all_four_character_axes(self):
        from service import score_ledger
        documents, ledger = fixture()
        event(ledger)['character'] = '艾尔黛拉'
        before = score_ledger(ledger)
        self.assertTrue(all(before['axes'][key]['score'] is None for key in CHAR_AXES))
        self.migrate(documents, ledger, reviewed=True)
        after = score_ledger(ledger)
        self.assertTrue(all(isinstance(after['axes'][key]['score'], (int, float)) for key in CHAR_AXES))
        self.assertEqual((pool(ledger)['total'], pool(ledger)['quota'], pool(ledger)['tail']), (20, 2560, 5))

    def test_augment_and_saved_evidence_preserve_new_recognizer_fields(self):
        documents, _ = fixture(raw_character='艾尔黛拉', reason=None)
        raw = documents[0]['pools'][0]
        raw['events'][0].update(identitySource='avatar', off=True, offBadgeObserved=False)
        augmented = augment_pools([raw], [])[0]
        self.assertEqual(augmented['events'][0]['identitySource'], 'avatar')
        ledger = build_ledger(documents)
        evidence = event(ledger)['evidence']
        self.assertIs(evidence['offBadgeObserved'], False)
        self.assertEqual(evidence['avatarLocation'], {'needs_review': False})
        self.assertEqual(evidence['identitySource'], 'avatar')


if __name__ == '__main__':
    unittest.main()
