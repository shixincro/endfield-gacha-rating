"""Fetch public six-star avatar references; never sends user screenshots.

The HTML source is used as the name/ID authority, not hand-guessed IDs.
Only explicitly supported gacha six-star characters are kept.
Game artwork remains the property of its original rights holders.
"""
from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
INDEX = "https://warfarin.wiki/cn/operators"
NAMES = {"明河", "祀", "提弗洛斯", "洛茜", "弭弗", "黎风", "余烬", "洁尔佩塔", "艾尔黛拉", "梨诺", "诀", "汤汤", "骏卫", "卡缪", "伊冯", "莱万汀", "别礼", "庄方宜"}


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "LocalGachaOCRPrototype/0.1 (public asset reference download)"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def main() -> None:
    source = get(INDEX).decode("utf-8")
    rows = []
    for anchor in re.findall(r'<a\b[^>]*href="/cn/operators/[^>]+>.*?</a>', source):
        if "★★★★★★" not in anchor:
            continue
        names = [name for name in NAMES if ">" + name + "<" in anchor]
        if len(names) != 1:
            continue
        character_id = re.search(r'icon_(chr_[^"/]+)\.webp', anchor).group(1)
        page = re.search(r'href="([^"]+)"', anchor).group(1)
        rows.append({"name": names[0], "id": character_id,
                     "page": "https://warfarin.wiki" + html.unescape(page),
                     "url": f"https://static.warfarin.wiki/v4/charremoteicon/icon_{character_id}.webp",
                     "file": f"icon_{character_id}.webp"})
    if {row["name"] for row in rows} != NAMES:
        raise RuntimeError(f"Catalog mismatch: {NAMES - {row['name'] for row in rows}}")
    ASSETS.mkdir(parents=True, exist_ok=True)
    previous = json.loads((ASSETS/'manifest.json').read_text(encoding='utf-8')) if (ASSETS/'manifest.json').exists() else {}
    old_by_name = {r['name']:r for r in previous.get('characters',[])}

    def download(row):
        old = old_by_name.get(row['name'], {})
        target = ASSETS / row['file']
        if (old.get('id') == row['id'] and old.get('file') == row['file']
                and target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == old.get('sha256')):
            return {**row,'bytes':old['bytes'],'sha256':old['sha256']}, True
        data = get(row["url"])
        (ASSETS / row["file"]).write_bytes(data)
        row["bytes"] = len(data)
        row["sha256"] = hashlib.sha256(data).hexdigest()
        return row, False

    with ThreadPoolExecutor(max_workers=4) as executor:
        downloaded = list(executor.map(download, rows))
    rows = [row for row,_ in downloaded]
    manifest = {"source": INDEX, "scope": f"{len(rows)} six-star gacha characters; no screenshots used as templates", "artwork_rights": "Original game rights holders; public access is not a redistribution license", "characters": rows}
    (ASSETS / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"characters":len(rows),"downloaded":sum(not cached for _,cached in downloaded),"cached":sum(cached for _,cached in downloaded), "bytes": sum(r["bytes"] for r in rows), "names": [r["name"] for r in rows]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
