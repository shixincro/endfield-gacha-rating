"""Conservative banner recovery from the small portrait in a card header.

Input pixels already use the parser's normalized width. Only geometry next to
an explicit total-pulls row is searched; event portraits and banner order do
not supply identity. Matcher thresholds are unchanged and not probabilities.
"""
from __future__ import annotations

import math
import re

import cv2
import numpy as np

from avatar_match import match_avatar


def _iou(first, second):
    ax, ay, aw, ah = first
    bx, by, bw, bh = second
    overlap = max(0, min(ax+aw, bx+bw)-max(ax, bx)) * max(0, min(ay+ah, by+bh)-max(ay, by))
    return overlap / max(1, aw*ah+bw*bh-overlap)


def locate_header_avatars(image, total_row):
    """Return distinct, small square frame candidates next to a header total."""
    if not isinstance(total_row, dict) or not re.search(r'合计\s*\d+\s*抽', str(total_row.get('text', ''))):
        return []
    if not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] < 3 or image.size == 0:
        return []
    box = total_row.get('box')
    if not isinstance(box, (tuple, list)) or len(box) != 4:
        return []
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in box):
        return []
    height, width = image.shape[:2]
    text_height = box[3]-box[1]
    cy = (box[1]+box[3])/2
    scale = width/1000
    if not 12*scale <= text_height <= 70*scale or not 0 <= cy < height:
        return []
    # The header's tiny UP badge is right of the text. Main/rush portraits
    # belong to the left column and are never searched by this function.
    extent = min(60*scale, 1.75*text_height)
    x0, y0, y1 = round(.7*width), max(0, round(cy-extent)), min(height, round(cy+extent))
    roi = image[y0:y1, x0:, :3]
    if roi.size == 0:
        return []
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    grey = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    # Header art is faded; the icon has an opaque, higher-contrast frame.
    # Edge and contrast masks are geometry proposals only, never identities.
    contrast = (((hsv[:, :, 1] > 90) & (hsv[:, :, 2] < 230)) | (grey < 145)).astype(np.uint8)*255
    masks = [('edges', cv2.Canny(roi, 60, 140), 3),
             ('contrast', contrast, 3), ('contrast', contrast, 5)]
    proposals = []
    for method, mask, kernel in masks:
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((kernel, kernel), np.uint8))
        contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if not (.65*text_height <= w <= 1.65*text_height and .65*text_height <= h <= 1.65*text_height):
                continue
            if not .8 <= w/h <= 1.25 or abs(y0+y+h/2-cy) > .8*text_height:
                continue
            fill = cv2.contourArea(contour)/(w*h)
            polygon = cv2.approxPolyDP(contour, .035*cv2.arcLength(contour, True), True)
            if fill < .72 or not 4 <= len(polygon) <= 8:
                continue
            # A component cut by the search/image edge is not a complete frame.
            if x <= 0 or y <= 0 or x+w >= roi.shape[1] or y+h >= roi.shape[0]:
                continue
            proposals.append({'box':[x0+x, y0+y, w, h], 'method':'header-square-'+method,
                              'fill':round(fill, 5), 'textHeight':text_height,
                              'quality':fill*min(w, h)/max(w, h)})
    # Several masks may trace the same physical frame. Deduplicate by pixels,
    # before running the matcher, rather than by whichever identity it returns.
    distinct = []
    for proposal in sorted(proposals, key=lambda item:item['quality'], reverse=True):
        if not any(_iou(proposal['box'], kept['box']) > .55 for kept in distinct):
            distinct.append(proposal)
    return sorted(distinct, key=lambda item:item['box'][0])


def recover_header_banner(image, total_row, banner_by_up):
    """Return a banner only for one accepted, legal limited-UP header portrait.

    ``banner_by_up`` is supplied by the caller; this module owns no separate
    character catalogue. ``needs_review`` is false only on automatic recovery.
    """
    result = {'banner':None, 'up':None, 'box':None, 'needs_review':True,
              'reason':'header_avatar_not_found', 'candidates':[]}
    candidates = locate_header_avatars(image, total_row)
    for geometry in candidates:
        x, y, w, h = geometry['box']
        try:
            match = match_avatar(image[y:y+h, x:x+w, :3])
        except (ImportError, FileNotFoundError) as exc:
            match = {'character':None, 'needs_review':True, 'reason':str(exc)}
        result['candidates'].append({'geometry':geometry, 'avatar_match':match})
    accepted = [item for item in result['candidates']
                if item['avatar_match'].get('character') and item['avatar_match'].get('needs_review') is False]
    if not accepted:
        if candidates:
            result['reason'] = 'header_avatar_unresolved'
        return result
    if len(accepted) != 1:
        result['reason'] = 'multiple_header_avatars'
        return result
    candidate = accepted[0]
    up = candidate['avatar_match']['character']
    if not isinstance(banner_by_up, dict) or up not in banner_by_up:
        result['reason'] = 'header_avatar_not_limited_up'
        return result
    result.update(banner=banner_by_up[up], up=up, box=candidate['geometry']['box'],
                  geometry=candidate['geometry'], avatar_match=candidate['avatar_match'],
                  needs_review=False, reason='accepted_header_avatar')
    return result
