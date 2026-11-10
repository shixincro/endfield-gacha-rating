"""Header-frame and abstention tests, independent of user screenshot records."""
from pathlib import Path
import json
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import avatar_match
import header_avatar


CATALOGUE = {'莱万汀':'熔火灼痕', '伊冯':'热烈色彩'}


def accepted(name='莱万汀'):
    return {'character':name, 'candidate':name, 'needs_review':False, 'similarity':.95, 'margin':.3}


def row(text='合计122抽垫2产出10200'):
    return {'text':text, 'box':[60, 125, 420, 157], 'x':240, 'y':141}


def canvas():
    return np.full((320, 1000, 3), 235, dtype=np.uint8)


def frame(image, x=820, y=122):
    # A high-contrast 38px framed patch supplies geometry, not identity.
    image[y:y+38, x:x+38] = (30, 100, 180)
    cv2.rectangle(image, (x, y), (x+37, y+37), (30, 30, 30), 2)
    return image


def public_asset(name):
    manifest = json.loads((avatar_match.ASSETS/'manifest.json').read_text(encoding='utf-8'))
    asset = next(item for item in manifest['characters'] if item['name'] == name)
    value = cv2.imdecode(np.fromfile(avatar_match.ASSETS/asset['file'], dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if value.shape[2] == 4:
        alpha = value[:, :, 3:4].astype(np.float32)/255
        value = (value[:, :, :3]*alpha+235*(1-alpha)).astype(np.uint8)
    return cv2.resize(value, (38, 38), interpolation=cv2.INTER_AREA)


class HeaderAvatarTests(unittest.TestCase):
    def test_accepted_unique_frame_recovers_catalogue_banner(self):
        image = frame(canvas())
        with patch.object(header_avatar, 'match_avatar', return_value=accepted()) as matcher:
            result = header_avatar.recover_header_banner(image, row(), CATALOGUE)
        self.assertEqual(result['banner'], '熔火灼痕')
        self.assertFalse(result['needs_review'])
        self.assertEqual(result['up'], '莱万汀')
        self.assertEqual(matcher.call_count, 1)  # Duplicate masks are one frame.
        x, y, width, height = result['box']
        self.assertTrue(818 <= x <= 821 and 120 <= y <= 123)
        self.assertTrue(36 <= width <= 40 and 36 <= height <= 40)

    def test_blank_header_has_no_fallback_candidate(self):
        with patch.object(header_avatar, 'match_avatar') as matcher:
            result = header_avatar.recover_header_banner(canvas(), row(), CATALOGUE)
        self.assertIsNone(result['banner'])
        self.assertEqual(result['reason'], 'header_avatar_not_found')
        matcher.assert_not_called()

    def test_event_avatar_in_left_column_is_never_used(self):
        with patch.object(header_avatar, 'match_avatar') as matcher:
            result = header_avatar.recover_header_banner(frame(canvas(), x=100), row(), CATALOGUE)
        self.assertTrue(result['needs_review'])
        matcher.assert_not_called()

    def test_portrait_below_header_band_is_never_used(self):
        with patch.object(header_avatar, 'match_avatar') as matcher:
            result = header_avatar.recover_header_banner(frame(canvas(), y=230), row(), CATALOGUE)
        self.assertTrue(result['needs_review'])
        matcher.assert_not_called()

    def test_unknown_and_low_confidence_do_not_use_top_candidate(self):
        for match in ({'character':None, 'candidate':'莱万汀', 'needs_review':True},
                      {**accepted(), 'needs_review':True},
                      {'character':'莱万汀', 'candidate':'莱万汀'}):
            with self.subTest(match=match), patch.object(header_avatar, 'match_avatar', return_value=match):
                result = header_avatar.recover_header_banner(frame(canvas()), row(), CATALOGUE)
                self.assertIsNone(result['banner'])
                self.assertTrue(result['needs_review'])

    def test_accepted_common_character_is_not_a_banner(self):
        with patch.object(header_avatar, 'match_avatar', return_value=accepted('艾尔黛拉')):
            result = header_avatar.recover_header_banner(frame(canvas()), row(), CATALOGUE)
        self.assertIsNone(result['banner'])
        self.assertEqual(result['reason'], 'header_avatar_not_limited_up')

    def test_two_separate_accepted_icons_abstain_even_if_same_identity(self):
        image = frame(frame(canvas(), x=800), x=900)
        for names in (('莱万汀','伊冯'), ('莱万汀','莱万汀'), ('莱万汀','艾尔黛拉')):
            with self.subTest(names=names), patch.object(header_avatar, 'match_avatar', side_effect=[accepted(n) for n in names]):
                result = header_avatar.recover_header_banner(image, row(), CATALOGUE)
                self.assertIsNone(result['banner'])
                self.assertEqual(result['reason'], 'multiple_header_avatars')

    def test_half_occluded_frame_is_not_complete_square(self):
        image = frame(canvas())
        image[118:164, 818:842] = 235
        with patch.object(header_avatar, 'match_avatar') as matcher:
            result = header_avatar.recover_header_banner(image, row(), CATALOGUE)
        self.assertIsNone(result['banner'])
        matcher.assert_not_called()

    def test_public_asset_in_small_header_frame_uses_real_matcher(self):
        image = canvas()
        image[122:160, 820:858] = public_asset('莱万汀')
        cv2.rectangle(image, (820,122), (857,159), (30,30,30), 1)
        result = header_avatar.recover_header_banner(image, row(), CATALOGUE)
        self.assertEqual(result['banner'], '熔火灼痕')
        self.assertFalse(result['avatar_match']['needs_review'])

    def test_featureless_colored_square_is_not_identity(self):
        result = header_avatar.recover_header_banner(frame(canvas()), row(), CATALOGUE)
        self.assertIsNone(result['banner'])
        self.assertTrue(result['needs_review'])

    def test_heavily_blurred_header_does_not_invent_identity(self):
        image = canvas()
        image[122:160, 820:858] = public_asset('莱万汀')
        image = cv2.GaussianBlur(image, (31,31), 9)
        result = header_avatar.recover_header_banner(image, row(), CATALOGUE)
        self.assertIsNone(result['banner'])
        self.assertTrue(result['needs_review'])

    def test_no_total_row_or_invalid_geometry_is_rejected(self):
        for header in (row('49抽'), row('免费十连'), {}, {'text':'合计1抽','box':[0, float('nan'), 50, 140]},
                       {'text':'合计1抽','box':[10, 100, 50, 100]}):
            with self.subTest(header=header), patch.object(header_avatar, 'match_avatar') as matcher:
                result = header_avatar.recover_header_banner(frame(canvas()), header, CATALOGUE)
                self.assertIsNone(result['banner'])
                matcher.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
