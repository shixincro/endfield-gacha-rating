"""Registration regression tests using public assets and synthetic transforms.

These tests never read screenshot records or reference annotations. Their
purpose is to test registration mechanics, determinism and safe abstention;
passing does not establish recognition accuracy on unseen screenshots.
"""
from __future__ import annotations

import json
import unittest

import cv2
import numpy as np

import avatar_match
import fetch_assets
import recognize


def assets():
    manifest = json.loads((avatar_match.ASSETS / "manifest.json").read_text(encoding="utf-8"))
    result = []
    for item in manifest["characters"]:
        image = cv2.imdecode(
            np.fromfile(avatar_match.ASSETS / item["file"], dtype=np.uint8),
            cv2.IMREAD_UNCHANGED,
        )
        if image is None:
            raise AssertionError(f"Cannot load test asset: {item['file']}")
        if image.ndim == 3 and image.shape[2] == 4:
            alpha = image[:, :, 3:4].astype(np.float32) / 255
            image = (image[:, :, :3] * alpha + 235 * (1 - alpha)).astype(np.uint8)
        result.append((item["name"], image))
    return result


def synthetic_transform(image, scale, dx, dy):
    """Independent fixture generation, deliberately not the production helper."""
    image = cv2.resize(image, (40, 40), interpolation=cv2.INTER_AREA)
    affine = cv2.getRotationMatrix2D((20, 20), 0, scale)
    affine[0, 2] += dx
    affine[1, 2] += dy
    return cv2.warpAffine(
        image, affine, (40, 40), flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(235, 235, 235),
    )


class AvatarRegistrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.asset_images = assets()

    def test_bank_has_equal_pose_coverage_for_every_character(self):
        bank, owners, names, poses = avatar_match._templates()
        self.assertEqual(names, [name for name, _ in self.asset_images])
        supported = set(recognize.BANNERS.values()) | recognize.COMMON_CHARACTERS
        self.assertEqual(set(names), supported, "Every supported six-star needs a local portrait")
        self.assertEqual(fetch_assets.NAMES, supported, "Refreshing the portraits must cover the same catalog")
        self.assertEqual(bank.shape[0], len(names) * 175)
        self.assertEqual(len(owners), len(poses))
        self.assertEqual(len(poses), bank.shape[0])
        self.assertTrue(np.isfinite(bank).all())
        reference_poses = None
        for i, name in enumerate(names):
            with self.subTest(name=name):
                indices = np.flatnonzero(owners == i)
                self.assertEqual(len(indices), 175)
                # JSON normalizes tuple/dict poses without relying on their
                # internal representation. Every character gets the same grid.
                character_poses = [json.dumps(poses[int(j)], sort_keys=True) for j in indices]
                self.assertEqual(len(set(character_poses)), 175)
                if reference_poses is None:
                    reference_poses = character_poses
                self.assertEqual(character_poses, reference_poses)

    def test_template_bank_is_cached_and_not_rebuilt_per_query(self):
        avatar_match._templates.cache_clear()
        first = avatar_match._templates()
        second = avatar_match._templates()
        self.assertIs(first, second)
        avatar_match.match_avatar(self.asset_images[0][1])
        info = avatar_match._templates.cache_info()
        self.assertEqual(info.misses, 1)
        self.assertGreaterEqual(info.hits, 2)

    def test_original_public_assets_match_their_own_name(self):
        for name, image in self.asset_images:
            with self.subTest(name=name):
                answer = avatar_match.match_avatar(image)
                self.assertEqual(answer["candidate"], name)
                self.assertEqual(answer["character"], name)
                self.assertFalse(answer["needs_review"])

    def test_fixed_synthetic_scale_and_translation_preserve_top1(self):
        # Fixed before evaluation; not selected using any screenshot labels.
        # Acceptance is allowed to abstain, but a wrong confident answer is not.
        for name, image in self.asset_images:
            for scale, dx, dy in ((0.90, -2, 2), (1.10, 2, -2), (1.0, -4, 4)):
                with self.subTest(name=name, scale=scale, dx=dx, dy=dy):
                    answer = avatar_match.match_avatar(synthetic_transform(image, scale, dx, dy))
                    self.assertEqual(answer["candidate"], name)
                    self.assertIn(answer["character"], (None, name))

    def test_registration_metadata_and_determinism(self):
        query = synthetic_transform(self.asset_images[0][1], 0.90, -2, 2)
        before = query.copy()
        first = avatar_match.match_avatar(query)
        second = avatar_match.match_avatar(query)
        self.assertEqual(first, second)
        np.testing.assert_array_equal(query, before)
        registration = first["registration"]
        self.assertEqual(set(registration), {"scale", "dx", "dy", "query_trim", "normalized_size"})
        self.assertEqual(registration["normalized_size"], 40)
        self.assertTrue(0.849 <= registration["scale"] <= 1.151)
        self.assertIn(registration["dx"], (-4, -2, 0, 2, 4))
        self.assertIn(registration["dy"], (-4, -2, 0, 2, 4))
        self.assertIn(registration["query_trim"], (0.0, 0.04, 0.08))

    def test_empty_and_tiny_inputs_abstain(self):
        for image in (None, np.empty((0, 0, 3), dtype=np.uint8),
                      np.full((7, 7, 3), 200, dtype=np.uint8)):
            with self.subTest(shape=None if image is None else image.shape):
                answer = avatar_match.match_avatar(image)
                self.assertIsNone(answer["character"])
                self.assertIsNone(answer["candidate"])
                self.assertTrue(answer["needs_review"])

    def test_flat_grey_and_flat_colored_inputs_abstain(self):
        # A single color is not an identifiable portrait. Different channel
        # values also exercise the global-mean normalized correlation path.
        for color in ((0, 0, 0), (235, 235, 235), (255, 255, 255), (20, 70, 150)):
            with self.subTest(color=color):
                image = np.empty((60, 60, 3), dtype=np.uint8)
                image[:] = color
                answer = avatar_match.match_avatar(image)
                self.assertIsNone(answer["character"])
                self.assertTrue(answer["needs_review"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
