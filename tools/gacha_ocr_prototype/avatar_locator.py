"""Locate the visible portrait frame beside a result bar, without identity input.

Coordinates refer to the already normalized screenshot. The bar constrains a
small search region, but its height is not used as the final portrait size.
"""
from __future__ import annotations

import cv2
import numpy as np


def _is_gray_cross(image: np.ndarray) -> bool:
    if np.mean(np.ptp(image, axis=2) > 18) > .01:
        return False
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright = (gray >= max(210, float(np.median(gray)) + 24)).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(bright)
    height, width = gray.shape
    for index, (x, y, w, h, _) in enumerate(stats[1:], start=1):
        if not (.22 * width <= w <= .45 * width and .8 * w <= h <= 1.25 * w
                and .35 * width <= x + w / 2 <= .65 * width
                and .4 * height <= y + h / 2 <= .8 * height):
            continue
        cells = cv2.resize((labels[y:y+h, x:x+w] == index).astype(np.float32),
                           (3, 3), interpolation=cv2.INTER_AREA)
        if (np.min(cells[::2, ::2]) >= .5 and cells[1, 1] >= .75
                and max(cells[0, 1], cells[2, 1], cells[1, 0], cells[1, 2]) <= .45):
            return True
    return False


def locate_avatar(image: np.ndarray, bar, *, clipped_rush_placeholder=False) -> dict:
    x, y, w, h = map(int, bar)
    cy = y + h / 2
    x0, x1 = max(0, x - round(2.1*h)), max(0, x - round(.12*h))
    y0, y1 = max(0, round(cy-h)), min(image.shape[0], round(cy+h))
    roi = image[y0:y1, x0:x1]
    # The strip immediately to the left of a colour bar is plain card backing.
    # Comparing with it preserves grey-haired portraits as well as coloured ones.
    fallback_size = round(1.4*h)
    fallback = [max(0, x-round(.32*h)-fallback_size),
                max(0, round(cy-fallback_size/2)), fallback_size, fallback_size]
    if roi.size == 0:
        return {"box": fallback, "method": "fallback", "needs_review": True}
    backing = np.median(roi[:, -max(2, round(.07*h)):, :].reshape(-1, 3), axis=0)
    difference = np.max(np.abs(roi.astype(np.float32)-backing), axis=2)
    mask = (difference > 22).astype(np.uint8)*255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    clipped = []
    for contour in contours:
        rx, ry, rw, rh = cv2.boundingRect(contour)
        if not (.9*h <= rw <= 1.75*h and .9*h <= rh <= 1.75*h):
            continue
        if abs(y0+ry+rh/2-cy) > .3*h:
            continue
        fill = cv2.contourArea(contour)/(rw*rh)
        box = [x0+rx, y0+ry, rw, rh]
        if .8 <= rw/rh <= 1.25 and fill >= .35:
            candidates.append((fill*rw*rh, box))
        elif clipped_rush_placeholder and 1.25 < rw/rh <= 1.30 and fill >= .85:
            crop = roi[ry:ry+rh, rx:rx+rw]
            if _is_gray_cross(crop):
                clipped.append((fill*rw*rh, box))
    if candidates:
        _, box = max(candidates)
        return {"box": box, "method": "frame_component", "needs_review": False}
    if len(clipped) == 1:
        return {"box": clipped[0][1], "method": "clipped_rush_cross", "needs_review": False}
    return {"box": fallback, "method": "fallback", "needs_review": True}
