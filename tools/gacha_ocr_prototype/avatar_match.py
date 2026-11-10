"""Small deterministic avatar matcher using only independently downloaded assets.

Similarity is normalized image correlation, NOT a calibrated probability.
Thresholds are deliberately provisional; measure raw top-1 and abstention rates
separately, and do not claim validated confidence from this prototype.
"""
from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
import cv2
import numpy as np

ASSETS = Path(__file__).resolve().parent / "assets"
SIZE = 40
SIMILARITY_THRESHOLD = 0.65
MARGIN_THRESHOLD = 0.08
SCALES = (.85, .90, .95, 1.0, 1.05, 1.10, 1.15)
OFFSETS = (-4, -2, 0, 2, 4)
QUERY_TRIMS = (0.0, 0.04, 0.08)


def _vector(image: np.ndarray) -> np.ndarray:
    """Suppress border and count badges, retain shape and relative RGB colors."""
    image = cv2.resize(image, (SIZE, SIZE), interpolation=cv2.INTER_AREA).astype(np.float32)
    # Top-right counters and bottom rarity stripe are not character content.
    mask = np.ones((SIZE, SIZE), dtype=bool)
    mask[:3, :] = False
    mask[-4:, :] = False
    mask[:, :3] = False
    mask[:, -3:] = False
    mask[:12, -12:] = False
    vector = image[mask].reshape(-1)
    vector -= vector.mean()
    return vector / max(float(np.linalg.norm(vector)), 1e-6)


def _crops(image: np.ndarray):
    h, w = image.shape[:2]
    for trim in QUERY_TRIMS:
        dx, dy = round(w * trim), round(h * trim)
        yield image[dy:h-dy if dy else h, dx:w-dx if dx else w]


@lru_cache(maxsize=1)
def _templates():
    manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
    vectors, owners, names, poses = [], [], [], []
    for index, item in enumerate(manifest["characters"]):
        image = cv2.imdecode(np.fromfile(ASSETS / item["file"], dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if image is None:
            raise RuntimeError(f"Cannot load avatar: {item['file']}")
        if image.ndim == 3 and image.shape[2] == 4:
            alpha = image[:, :, 3:4].astype(np.float32) / 255
            image = (image[:, :, :3] * alpha + 235 * (1-alpha)).astype(np.uint8)
        names.append(item["name"])
        image = cv2.resize(image, (SIZE, SIZE), interpolation=cv2.INTER_AREA)
        # Every character receives the same search bank. Frame detection stays
        # separate: this aligns the artwork *inside* a correctly located frame.
        # Build once per process, not once per portrait.
        center = (SIZE-1)/2
        for scale in SCALES:
            for dx in OFFSETS:
                for dy in OFFSETS:
                    matrix = np.array([[scale, 0, (1-scale)*center+dx],
                                       [0, scale, (1-scale)*center+dy]], np.float32)
                    aligned = cv2.warpAffine(image, matrix, (SIZE, SIZE),
                                             flags=cv2.INTER_LINEAR,
                                             borderMode=cv2.BORDER_CONSTANT,
                                             borderValue=(235,235,235))
                    vectors.append(_vector(aligned))
                    owners.append(index)
                    poses.append((scale,dx,dy))
    return np.stack(vectors), np.array(owners), names, poses


def match_avatar(crop_bgr: np.ndarray) -> dict:
    """Return a top candidate plus explicit abstention; input is a tight icon crop."""
    if crop_bgr is None or crop_bgr.size == 0 or min(crop_bgr.shape[:2]) < 8:
        return {"character": None, "candidate": None, "similarity": 0.0,
                "margin": 0.0, "needs_review": True, "reason": "empty_or_tiny_crop"}
    if crop_bgr.ndim == 2:
        crop_bgr = cv2.cvtColor(crop_bgr, cv2.COLOR_GRAY2BGR)
    crop_bgr = crop_bgr[:, :, :3]
    templates, owners, names, poses = _templates()
    queries = np.stack([_vector(crop) for crop in _crops(crop_bgr)])
    correlations = queries @ templates.T
    all_scores = correlations.max(axis=0)
    scores = np.array([all_scores[owners == i].max() for i in range(len(names))])
    order = np.argsort(scores)[::-1]
    first, second = int(order[0]), int(order[1])
    similarity = float(scores[first])
    margin = float(scores[first] - scores[second])
    review = similarity < SIMILARITY_THRESHOLD or margin < MARGIN_THRESHOLD
    ids = np.flatnonzero(owners == first)
    winner = int(ids[np.argmax(all_scores[ids])])
    scale,dx,dy = poses[winner]
    query = int(np.argmax(correlations[:,winner]))
    return {"character": None if review else names[first], "candidate": names[first],
            "similarity": round(similarity, 5), "margin": round(margin, 5),
            "needs_review": review,
            "threshold_status": "provisional_not_calibrated",
            "registration": {"scale":scale,"dx":dx,"dy":dy,
                             "query_trim":QUERY_TRIMS[query],"normalized_size":SIZE},
            "top3": [{"name": names[int(i)], "similarity": round(float(scores[i]), 5)} for i in order[:3]]}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("crop", type=Path)
    args = parser.parse_args()
    value = cv2.imdecode(np.fromfile(args.crop, dtype=np.uint8), cv2.IMREAD_COLOR)
    print(json.dumps(match_avatar(value), ensure_ascii=False, indent=2))
