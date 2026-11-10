"""Download only the pinned public avatar files; never upload user records."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'tools/gacha_ocr_prototype/assets'


def download(item):
    name = item['file']
    if Path(name).name != name or not name.endswith('.webp'):
        raise ValueError('Invalid asset filename')
    target = ASSETS / name
    expected = item['sha256']
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        return 'cached'
    url = item['url']
    if not url.startswith('https://static.warfarin.wiki/v4/charremoteicon/'):
        raise ValueError('Unexpected avatar source')
    request = Request(url, headers={'User-Agent':'EndfieldGachaRating/1.0'})
    with urlopen(request, timeout=45) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'头像校验失败：{name}；未覆盖已有文件。')
    temporary = target.with_suffix('.download')
    temporary.write_bytes(data)
    temporary.replace(target)
    return 'downloaded'


def main():
    manifest = json.loads((ASSETS/'manifest.json').read_text(encoding='utf-8'))
    print('下载来源：华法琳档案馆。游戏素材权利属于原权利人，不适用本项目 MIT 许可证。')
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(download, manifest['characters']))
    print(f'头像校验完成：{len(results)} 个；本次下载 {results.count("downloaded")} 个。')


if __name__ == '__main__':
    main()
