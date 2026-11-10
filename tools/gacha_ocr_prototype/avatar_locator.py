"""Locate the visible portrait frame beside a result bar, without identity input.

Coordinates refer to the already normalized screenshot. The bar constrains a
small search region, but its height is not used as the final portrait size.
"""
from __future__ import annotations

import cv2
import numpy as np


def locate_avatar(image: np.ndarray, bar) -> dict:
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
    for contour in contours:
        rx, ry, rw, rh = cv2.boundingRect(contour)
        if not (.9*h <= rw <= 1.75*h and .9*h <= rh <= 1.75*h):
            continue
        if not (.8 <= rw/rh <= 1.25):
            continue
        if abs(y0+ry+rh/2-cy) > .3*h:
            continue
        fill = cv2.contourArea(contour)/(rw*rh)
        if fill < .35:
            continue
        candidates.append((fill*rw*rh, [x0+rx, y0+ry, rw, rh]))
    if not candidates:
        return {"box": fallback, "method": "fallback", "needs_review": True}
    _, box = max(candidates)
    return {"box": box, "method": "frame_component", "needs_review": False}
