"""Build a self-contained static site; never copy local histories or credentials."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
CORE_FILES = {
    'gacha_rating_app':['importer.py','record_import.py','structured_export.py','service.py','planning.py',
        'opportunity.py','hypothesis.py','history_interruption.py','weapon_scoring.py',
        'water_values.json','character_up_reference.json','character_score.js'],
    'weapon_score_v2':['scorer.py','ten_pool_reference.py','potential_profile_score.py','average_inference.py'],
    'gacha_ocr_prototype':['recognize.py','avatar_locator.py','avatar_match.py','header_avatar.py','assets/manifest.json'],
}


def character_bundle():
    """Bundle the existing CommonJS graph without a second algorithm copy."""
    modules = {}
    def add(path):
        key = path.relative_to(ROOT/'tools').as_posix()
        if key in modules:
            return key
        if path.suffix == '.json':
            modules[key] = 'module.exports='+path.read_text(encoding='utf-8')+';'
            return key
        source = path.read_text(encoding='utf-8')
        modules[key] = ''
        if key == 'character_five_score/scorer.js':
            source = source.replace("const fs = require('node:fs');",'').replace("const path = require('node:path');",'')
            old = "JSON.parse(fs.readFileSync(path.join(__dirname,'parameters.json'),'utf8'))"
            if old not in source:
                raise ValueError('Five-star parameter loader changed; update browser bundle')
            source = source.replace(old, "require('./parameters.json')")
        source = source.replace("const {performance}=require('node:perf_hooks');", "const {performance}=globalThis;")
        def dependency(match):
            name = match[1]
            if not name.startswith('.'):
                raise ValueError('Unsupported browser dependency '+name)
            target = (path.parent/name).resolve()
            if not target.suffix:
                target = target.with_suffix('.js')
            return '__require('+json.dumps(add(target))+')'
        modules[key] = re.sub(r"require\(['\"]([^'\"]+)['\"]\)",dependency,source)
        return key
    entry = add(ROOT/'tools/gacha_rating_app/character_score.js')
    definitions=',\n'.join(json.dumps(key)+':function(module,exports,__require){\n'+value+'\n}' for key,value in modules.items())
    return ('// Generated from the same source used by the desktop app.\nconst modules={'+definitions+'};\n'
            'const cache={};function __require(id){if(cache[id])return cache[id].exports;'
            'const module={exports:{}};cache[id]=module;modules[id](module,module.exports,__require);return module.exports;}\n'
            'const entry=__require('+json.dumps(entry)+');export const scoreCharacter=entry.scoreCharacter;export const VERSION=entry.VERSION;\n')


def build_site(output):
    if output == ROOT/'dist' or not output.is_relative_to(ROOT/'dist'):
        raise ValueError('Build output must be inside this repository dist directory')
    vendor = ROOT/'browser/vendor'
    manifest = json.loads((vendor/'runtime-manifest.json').read_text())
    for name,digest in manifest['files'].items():
        if hashlib.sha256((vendor/name).read_bytes()).hexdigest() != digest:
            raise ValueError('Runtime checksum mismatch: '+name)
    output.mkdir(parents=True,exist_ok=True)
    for name in ['pyodide','onnxruntime']:
        shutil.copytree(vendor/name, output/'vendor'/name,dirs_exist_ok=True)
    shutil.copy2(vendor/'runtime-manifest.json',output/'vendor/runtime-manifest.json')
    source=ROOT/'tools/gacha_rating_app/static'
    for name in ['app.js','ui-model.js','character-edit.js','manual-supplement.js','style.css']:
        shutil.copy2(source/name,output/name)
    html=(source/'index.html').read_text(encoding='utf-8')
    html=re.sub(r'<script defer src="/[^"]+"></script>','',html)
    html=html.replace('href="/style.css"','href="./style.css"').replace('href="/"','href="./"')
    html=html.replace('</head>','<script type="module" src="./browser/boot.js"></script></head>')
    html=html.replace('本机处理 · 不上传云端','浏览器本地计算 · 数据不上传')
    html=html.replace('<main>', '<main><p id="browserRuntimeStatus" class="muted" role="status">正在准备本地计算环境…</p>')
    html=html.replace('打开本机记录，或导入抽卡记录 TXT / JSON。','记录保存在当前浏览器。可导入旧版导出的 JSON；清除网站数据会删除这些记录，请保存 JSON 备份。')
    (output/'index.html').write_text(html,encoding='utf-8')
    for folder in ['core','ocr']:
        (output/'browser'/folder).mkdir(parents=True,exist_ok=True)
        for path in (ROOT/'browser'/folder).iterdir():
            if path.is_file() and path.suffix in ('.js','.mjs','.json'):
                shutil.copy2(path,output/'browser'/folder/path.name)
    for path in (ROOT/'browser').glob('*.js'):
        shutil.copy2(path,output/'browser'/path.name)
    (output/'browser/core/character.js').write_text(character_bundle(),encoding='utf-8')
    with ZipFile(output/'browser/python-core.zip','w',ZIP_DEFLATED) as archive:
        for folder,names in CORE_FILES.items():
            for name in names:
                archive.write(ROOT/'tools'/folder/name, 'tools/'+folder+'/'+name)
        for path in (ROOT/'browser/python').glob('*.py'):
            archive.write(path,'browser/python/'+path.name)
        # Avatar files are generated site assets, excluded from the Git repo.
        # No player's image or record may enter this build.
        assets=ROOT/'tools/gacha_ocr_prototype/assets'
        art=json.loads((assets/'manifest.json').read_text(encoding='utf-8'))
        for entry in art['characters']:
            path=assets/entry['file']
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
                raise ValueError('Missing or changed public avatar: run scripts/download_assets.py')
            archive.write(path,'tools/gacha_ocr_prototype/assets/'+entry['file'])
    ocrassets=vendor/'ocr'
    if not ocrassets.is_dir():
        raise ValueError('Build browser OCR resources first: scripts/build_browser_ocr.py --output browser/vendor/ocr')
    ocrmanifest=json.loads((ocrassets/'manifest.json').read_text(encoding='utf-8'))
    for name,digest in ocrmanifest['assets'].items():
        if hashlib.sha256((ocrassets/name).read_bytes()).hexdigest()!=digest:
            raise ValueError('OCR resource checksum mismatch: '+name+'; rebuild browser OCR assets')
    for name in ('runtime.mjs','pipeline.py'):
        if (ocrassets/name).read_bytes()!=(ROOT/'browser/ocr'/name).read_bytes():
            raise ValueError('OCR source changed; run scripts/build_browser_ocr.py again')
    shutil.copytree(ocrassets,output/'browser/ocr/assets',dirs_exist_ok=True)
    for name in ['LICENSE','THIRD_PARTY_NOTICES.md']:
        shutil.copy2(ROOT/name,output/name)
    hashes={path.relative_to(output).as_posix():hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(output.rglob('*')) if path.is_file() and path.name!='build-manifest.json'}
    (output/'build-manifest.json').write_text(json.dumps({'schema':'browser-site-v1','files':hashes},indent=2)+'\n',encoding='utf-8')


def build(output):
    dist=(ROOT/'dist').resolve()
    if output==dist or not output.is_relative_to(dist):
        raise ValueError('Build output must be a child of this repository dist directory')
    dist.mkdir(exist_ok=True)
    # Build a fresh allowlisted tree first. Do not accidentally retain deleted
    # resources, or publish files someone left in a previous output directory.
    with tempfile.TemporaryDirectory(prefix='.browser-build-',dir=dist) as temporary:
        staging=Path(temporary).resolve()
        if staging.parent!=dist or not staging.name.startswith('.browser-build-'):
            raise ValueError('Unexpected staging directory')
        build_site(staging)
        incoming={p.relative_to(staging).as_posix() for p in staging.rglob('*') if p.is_file()}
        existing=[]
        if output.exists():
            if not output.is_dir():
                raise ValueError('Build output is not a directory')
            for path in output.rglob('*'):
                if path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(output):
                    raise ValueError('Build output contains a link; choose a fresh directory')
                if path.is_file():
                    existing.append(path)
            if existing:
                marker=output/'build-manifest.json'
                if not marker.is_file():
                    raise ValueError('Nonempty output is not a previous browser build; choose a fresh directory')
                previous=json.loads(marker.read_text(encoding='utf-8'))
                if previous.get('schema')!='browser-site-v1':
                    raise ValueError('Unexpected previous build manifest')
                known=set(previous['files'])|{'build-manifest.json'}
                unknown=[p.relative_to(output).as_posix() for p in existing if p.relative_to(output).as_posix() not in known]
                if unknown:
                    raise ValueError('Output contains unrelated files; move them before rebuilding: '+', '.join(unknown[:5]))
        # These deletions are individual files from the prior generated
        # manifest, after the complete target tree and absolute bounds check.
        for path in existing:
            if path.relative_to(output).as_posix() not in incoming:
                if not path.resolve().is_relative_to(output):
                    raise ValueError('Output file escaped the build directory')
                path.unlink()
        shutil.copytree(staging,output,dirs_exist_ok=True)
    print('Static browser site:',output,flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'dist/browser-site')
    build(parser.parse_args().output.resolve())
