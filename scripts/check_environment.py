"""Check an installed source checkout without reading player data."""
import hashlib
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    errors = []
    if sys.version_info < (3, 12):
        errors.append('请使用 Python 3.12 或更新版本；当前已验证 Python 3.12。')
    for module in ('PIL', 'numpy', 'cv2', 'onnxruntime', 'rapidocr_onnxruntime'):
        try:
            importlib.import_module(module)
        except ImportError:
            errors.append(f'缺少依赖 {module}，请安装 requirements.txt。')
    node = shutil.which('node')
    if not node:
        errors.append('未找到 Node.js，请安装 Node.js 24 并重新打开终端。')
    else:
        result = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=10)
        if result.returncode:
            errors.append('Node.js 无法启动。')
        else:
            print('Node.js ' + result.stdout.strip())
    assets = ROOT/'tools/gacha_ocr_prototype/assets'
    manifest = json.loads((assets/'manifest.json').read_text(encoding='utf-8'))
    invalid = [item['file'] for item in manifest['characters']
               if not (assets/item['file']).is_file()
               or hashlib.sha256((assets/item['file']).read_bytes()).hexdigest() != item['sha256']]
    if invalid:
        errors.append(f'{len(invalid)} 个头像缺失或校验不符，请运行 scripts/download_assets.py。')
    for error in errors:
        print(error)
    if errors:
        return 1
    print(f'环境自检通过：Python {sys.version.split()[0]}，{len(manifest["characters"])} 个头像。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
