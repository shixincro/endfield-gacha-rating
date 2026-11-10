"""Portable test entry point. Tests create only synthetic temporary records."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=ROOT):
    print('Running: ' + ' '.join(map(str, args)), flush=True)
    subprocess.run(args, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ocr', action='store_true', help='Also run OCR tests (avatar assets required).')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required.')
    app = ROOT/'tools/gacha_rating_app'
    (app/'test_outputs').mkdir(exist_ok=True)
    run([sys.executable,'-X','utf8','-m','unittest','discover','-s','tools/gacha_rating_app','-p','test_*.py'])
    js_tests = sorted(app.glob('test_*.js')) + sorted((ROOT/'tools/character_five_score').glob('test_*.js'))
    run([node,'--test',*map(str,js_tests)])
    run([sys.executable,'-X','utf8','-m','unittest','discover','-s','tools/weapon_score_v2','-p','test_*.py'])
    if args.ocr:
        run([sys.executable,'-X','utf8','scripts/check_environment.py'])
        run([sys.executable,'-X','utf8','-m','unittest','discover','-s','tools/gacha_ocr_prototype','-p','test_*.py'])


if __name__ == '__main__':
    main()
