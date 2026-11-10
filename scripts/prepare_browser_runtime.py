"""Download version-pinned browser runtimes. No user records are read.

Run once on the build machine; visitors only download static files. Wheel
hashes are checked against the upstream Pyodide lock, and the npm tarball
against npm's published integrity digest. Subsequent builds work offline.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PYODIDE = '0.29.3'
ORT = '1.23.2'
PACKAGES = ['numpy', 'opencv-python', 'pillow', 'pyclipper', 'shapely', 'pyyaml']


def fetch(url, path, sha256=None):
    if path.is_file():
        blob = path.read_bytes()
        if not sha256 or hashlib.sha256(blob).hexdigest() == sha256:
            return blob
    print('Downloading', path.name, flush=True)
    request = urllib.request.Request(url, headers={'User-Agent':'EndfieldGacha-Browser-Build/1'})
    with urllib.request.urlopen(request, timeout=120) as response:
        blob = response.read()
    if sha256 and hashlib.sha256(blob).hexdigest() != sha256:
        raise ValueError('SHA256 mismatch: '+path.name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    return blob


def prepare(destination):
    pyroot = destination/'pyodide'
    base = f'https://cdn.jsdelivr.net/pyodide/v{PYODIDE}/full/'
    lock = json.loads(fetch(base+'pyodide-lock.json', pyroot/'pyodide-lock.json'))
    for name in ['pyodide.mjs', 'pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip']:
        fetch(base+name, pyroot/name)
    fetched = set()
    def package(name):
        name = name.lower()
        if name in fetched:
            return
        metadata = lock['packages'][name]
        for dependency in metadata['depends']:
            package(dependency)
        filename = metadata['file_name']
        fetch(base+filename, pyroot/filename, metadata['sha256'])
        fetched.add(name)
    for name in PACKAGES:
        package(name)
    fetch(f'https://raw.githubusercontent.com/pyodide/pyodide/{PYODIDE}/LICENSE', pyroot/'LICENSE')
    ortroot = destination/'onnxruntime'
    metadata = json.loads(fetch(f'https://registry.npmjs.org/onnxruntime-web/{ORT}', destination/'onnxruntime-package.json'))
    archive = fetch(metadata['dist']['tarball'], destination/f'onnxruntime-web-{ORT}.tgz')
    algorithm, expected = metadata['dist']['integrity'].split('-', 1)
    if base64.b64encode(hashlib.new(algorithm, archive).digest()).decode() != expected:
        raise ValueError('ONNX Runtime npm integrity mismatch')
    # WASM CPU backend only: one thread, no SharedArrayBuffer/cross-origin
    # isolation requirement. Do not ship WebGPU/JSEP/training binaries.
    wanted = {'dist/ort.wasm.min.mjs', 'dist/ort-wasm-simd-threaded.mjs',
              'dist/ort-wasm-simd-threaded.wasm', 'README.md', 'package.json'}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for relative in wanted:
            member = tar.getmember('package/'+relative)
            if not member.isfile():
                raise ValueError('Unexpected npm archive entry')
            output = ortroot/Path(relative).name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(tar.extractfile(member).read())
    fetch(f'https://raw.githubusercontent.com/microsoft/onnxruntime/v{ORT}/LICENSE',ortroot/'LICENSE')
    fetch(f'https://raw.githubusercontent.com/microsoft/onnxruntime/v{ORT}/ThirdPartyNotices.txt',ortroot/'ThirdPartyNotices.txt')
    manifest = {'pyodide':PYODIDE, 'onnxruntimeWeb':ORT, 'packages':sorted(fetched),
                'files':{path.relative_to(destination).as_posix():hashlib.sha256(path.read_bytes()).hexdigest()
                         for folder in [pyroot,ortroot] for path in sorted(folder.rglob('*')) if path.is_file()}}
    (destination/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print('Browser runtime ready:', destination, flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'browser/vendor')
    prepare(parser.parse_args().output.resolve())
