"""Build the local-only browser OCR assets from the pinned desktop dependency.

Run using the project's development venv. Output is a static asset directory;
it contains no native Python/ONNX Runtime binaries and no user screenshots.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.4.4'
LICENSE_URL = 'https://raw.githubusercontent.com/RapidAI/RapidOCR/v1.4.4/LICENSE'
PADDLE_LICENSE_URL = 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/LICENSE'


def build(output: Path):
    import onnxruntime as ort
    distribution = importlib.metadata.distribution('rapidocr-onnxruntime')
    if distribution.version != VERSION:
        raise RuntimeError(f'Browser OCR requires rapidocr-onnxruntime=={VERSION}')
    package = Path(distribution.locate_file('rapidocr_onnxruntime')).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_dir = ROOT/'browser'/'ocr'
    for name in ('pipeline.py', 'runtime.mjs'):
        shutil.copyfile(source_dir/name, output/name)
    licenses = output/'licenses'
    licenses.mkdir(exist_ok=True)
    for name, url in [('RapidOCR-LICENSE.txt', LICENSE_URL), ('PaddleOCR-LICENSE.txt', PADDLE_LICENSE_URL)]:
        existing = licenses/name
        if existing.is_file():
            payload = existing.read_bytes()
        else:
            with urllib.request.urlopen(url, timeout=60) as response:
                payload = response.read()
        if b'Apache License' not in payload:
            raise ValueError(f'Unexpected license payload: {url}')
        (licenses/name).write_bytes(payload)
    archive = output/'rapidocr-source.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        for file in sorted(package.rglob('*.py')):
            target.write(file, file.relative_to(package.parent).as_posix())
        target.write(package/'config.yaml', 'rapidocr_onnxruntime/config.yaml')
        for file in licenses.iterdir():
            target.write(file, 'licenses/'+file.name)
    det_name, rec_name = 'ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx'
    for name in (det_name, rec_name):
        shutil.copyfile(package/'models'/name, output/name)
    session = ort.InferenceSession(str(package/'models'/rec_name), providers=['CPUExecutionProvider'])
    characters = session.get_modelmeta().custom_metadata_map['character'].splitlines()
    manifest = {
        'schema':'browser-ocr-assets-v1', 'rapidocrVersion':VERSION,
        'detector':det_name, 'recognizer':rec_name, 'characters':characters,
        'runtime':'onnxruntime-web-wasm', 'pythonPackages':
            ['opencv-python','numpy','pillow','pyclipper','shapely','pyyaml'],
        'assets':{file.relative_to(output).as_posix():hashlib.sha256(file.read_bytes()).hexdigest()
                  for file in sorted(output.rglob('*')) if file.is_file() and file.name!='manifest.json'},
    }
    (output/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'output':str(output), 'characters':len(characters),
                      'bytes':sum(file.stat().st_size for file in output.rglob('*') if file.is_file())}))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    build(parser.parse_args().output.resolve())
