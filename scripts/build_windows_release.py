"""Build a public Windows x64 ZIP with bundled runtimes, without player data or game art."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from zipfile import ZIP_DEFLATED, ZipFile

ROOT=Path(__file__).resolve().parents[1]
APPLICATION_FILES={
    'gacha_rating_app': [
        'server.py','service.py','importer.py','planning.py','opportunity.py','hypothesis.py',
        'history_interruption.py','weapon_scoring.py','structured_export.py','record_import.py','score_cli.js',
        'character_score.js','character_ledger.js','character_result_score.js','character_result_math.js',
        'character_up_score.js','character_up_dp.js','character_six_count.js','character_limited_count.js',
        'character_up_reference.json','water_values.json','CHARACTER_SCORING.txt',
        'static/index.html','static/style.css','static/app.js','static/ui-model.js',
        'static/character-edit.js','static/manual-supplement.js'],
    'character_five_score':['scorer.js','parameters.json'],
    'weapon_score_v2':['average_inference.py','potential_profile_score.py','ten_pool_reference.py','scorer.py'],
    'gacha_ocr_prototype':['recognize.py','avatar_locator.py','avatar_match.py','header_avatar.py','assets/manifest.json'],
}
VC_FILES=('msvcp140.dll','msvcp140_1.dll','msvcp140_2.dll','vcruntime140.dll','vcruntime140_1.dll')
IGNORE=shutil.ignore_patterns('__pycache__','*.pyc','*.pyo','*.pdb','direct_url.json',
                             '_virtualenv*','pip','pip-*.dist-info','opencv_videoio_ffmpeg*.dll')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def copy(source,target):
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source,target)


def write(path,text):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(text,encoding='utf-8',newline='\r\n' if path.suffix=='.cmd' else '\n')


def build(args):
    if sys.platform!='win32' or platform.machine().upper()!='AMD64' or sys.version_info[:2]!=(3,12):
        raise RuntimeError('Build using a Windows x64 Python 3.12 virtual environment.')
    if sys.prefix==sys.base_prefix:
        raise RuntimeError('Run with the clean project .venv and installed requirements.')
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?',args.version):
        raise ValueError('Use a version such as v0.1.0.')
    dirty=subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True)
    if dirty.strip():
        raise RuntimeError('Commit the release sources before building.')
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    node=args.node.resolve()
    if digest(node)!=args.node_sha256.lower():
        raise ValueError('Node binary does not match the supplied official SHA-256.')
    node_version=subprocess.check_output([str(node),'--version'],text=True).strip()
    site=Path(sys.prefix)/'Lib/site-packages'
    if not (site/'rapidocr_onnxruntime').is_dir():
        raise RuntimeError('Install tools/gacha_ocr_prototype/requirements.txt first.')
    import shapely
    geos_version=shapely.geos_version_string
    if args.geos_source.name!=f'geos-{geos_version}.tar.bz2':
        raise ValueError('Supply the GEOS source archive matching the bundled native library.')
    if args.shapely_source.name.lower()!=f'shapely-{shapely.__version__}.tar.gz':
        raise ValueError('Supply the matching Shapely source archive.')
    base=Path(sys.base_prefix)
    archive=ROOT/'dist'/f'EndfieldGacha-Windows-x64-{args.version}.zip'
    if archive.exists():
        raise FileExistsError(archive)
    staging=ROOT/'dist'/('build-'+args.version+'-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    package=staging/'EndfieldGacha'
    package.mkdir(parents=True,exist_ok=False)
    for directory,names in APPLICATION_FILES.items():
        for name in names:
            copy(ROOT/'tools'/directory/name,package/'tools'/directory/name)
    for name in ('LICENSE','README.md','THIRD_PARTY_NOTICES.md','docs/ALGORITHMS.md','examples/demo-session.json',
                 'scripts/download_assets.py','scripts/check_environment.py'):
        copy(ROOT/name,package/name)
    copy(ROOT/'scripts/windows_portable_launcher.py',package/'portable_launch.py')
    copy(ROOT/'scripts/check_windows_runtime.py',package/'check_runtime.py')
    runtime=package/'runtime/python'
    for name in ('python.exe','python3.dll','python312.dll','LICENSE.txt'):
        copy(base/name,runtime/name)
    shutil.copytree(base/'DLLs',runtime/'DLLs',ignore=shutil.ignore_patterns('*_test*','_tkinter.pyd','tcl86t.dll','tk86t.dll'))
    for entry in (base/'Lib').iterdir():
        if entry.name in {'site-packages','__pycache__','test','tests','idlelib','tkinter','turtledemo','ensurepip','venv'}:
            continue
        if entry.is_dir():
            shutil.copytree(entry,runtime/'Lib'/entry.name,ignore=IGNORE)
        else:
            copy(entry,runtime/'Lib'/entry.name)
    shutil.copytree(site,runtime/'Lib/site-packages',ignore=IGNORE)
    for name in VC_FILES:
        copy(args.vc_runtime/name,runtime/name)
    copy(args.msvc_license,runtime/'Microsoft-VC-Runtime-License.docx')
    copy(args.paddle_license,runtime/'Lib/site-packages/rapidocr_onnxruntime/PADDLEOCR-LICENSE')
    copy(node,package/'runtime/node/node.exe')
    copy(args.node_license,package/'runtime/node/LICENSE.txt')
    copy(args.geos_source,package/'third_party_sources'/args.geos_source.name)
    copy(args.shapely_source,package/'third_party_sources'/args.shapely_source.name)
    write(package/'third_party_sources/README.txt',
          f'This package includes unmodified GEOS {geos_version} (LGPL-2.1) used by Shapely {shapely.__version__}.\n'
          'Complete matching source archives are provided in this directory.\n'
          'GEOS source/build documentation: https://libgeos.org/usage/download/\n'
          'Shapely source/build documentation: https://shapely.readthedocs.io/en/stable/installation.html\n'
          'GEOS is dynamically linked under runtime/python/Lib/site-packages/shapely.libs.\n'
          'You may modify/replace GEOS or rebuild the Shapely binding under their licenses;\n'
          'reverse engineering for debugging modifications to this LGPL library is permitted.\n'
          'The GEOS license is retained in the source archive and Shapely dist-info/licenses/LICENSE_GEOS.\n')
    write(runtime/'python312._pth','.\nDLLs\nLib\nLib/site-packages\n../../tools/gacha_rating_app\nimport site\n')
    for name,command in [('启动抽卡工具.cmd','portable_launch.py'),('停止抽卡工具.cmd','portable_launch.py --stop'),
                         ('运行环境自检.cmd','check_runtime.py'),('下载头像素材.cmd','scripts\\download_assets.py')]:
        script,*options=command.split()
        body='@echo off\nchcp 65001 >nul\nsetlocal\ncd /d "%~dp0"\n'
        body+=f'"%~dp0runtime\\python\\python.exe" -I -B "%~dp0{script}" {" ".join(options)}\n'
        body+=('pause\n' if script!='portable_launch.py' else 'if errorlevel 1 pause\n')
        write(package/name,body)
    write(package/'使用说明.txt',
          f'终末地抽卡评分工具 {args.version}（Windows x64）\n\n'
          '1. 完整解压 ZIP 到可写文件夹。\n'
          '2. 双击“启动抽卡工具.cmd”，浏览器会自动打开。\n'
          '3. 首次启动会下载头像素材；完成后可离线使用，不需要另外安装 Python 或 Node.js。\n'
          '4. 首页可选择或拖入图片、TXT、JSON，每批最多12个文件。\n'
          '5. 用“停止抽卡工具.cmd”关闭本便携包的后台服务。\n\n'
          '如果头像下载未完成，可先导入 TXT/JSON，联网后运行“下载头像素材.cmd”。\n'
          '故障排查：运行“运行环境自检.cmd”。\n'
          '本机记录：tools\\gacha_rating_app\\data。更新前请备份该目录。\n'
          '旧版迁移：解压新版本到新文件夹，把上述记录目录复制到新版本同一位置。\n'
          '请勿迁移根目录 data 中的后台进程状态文件。\n\n'
          '源码和反馈：https://github.com/shixincro/endfield-gacha-rating\n'
          '原创代码 MIT，第三方组件和游戏素材见 THIRD_PARTY_NOTICES.md。\n')
    metadata={'version':args.version,'platform':'Windows x64','sourceCommit':commit,
              'builtAtUtc':datetime.now(timezone.utc).isoformat(timespec='seconds'),
              'python':sys.version.split()[0],'node':node_version,'nodeSha256':digest(node),
              'geos':geos_version,
              'includesUserHistory':False,'includesGameArtwork':False,'includesOcrModels':True,
              'packages':sorted((d.metadata['Name'],d.version) for d in importlib.metadata.distributions()
                                if d.metadata['Name'].lower()!='pip'),
              'applicationSourceSha256':{str(p.relative_to(package)).replace('\\','/'):digest(p)
                                         for p in (package/'tools').rglob('*') if p.is_file()}}
    write(package/'package-info.json',json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    hashes={p.relative_to(package).as_posix():digest(p) for p in sorted(package.rglob('*')) if p.is_file()}
    write(package/'SHA256SUMS.json',json.dumps(hashes,ensure_ascii=False,indent=2)+'\n')
    print('Compressing verified source and runtime files...',flush=True)
    with ZipFile(archive,'x',ZIP_DEFLATED,compresslevel=6) as bundle:
        for file in sorted(package.rglob('*')):
            if file.is_file():
                bundle.write(file,file.relative_to(staging).as_posix())
    checksum=digest(archive)
    write(archive.with_suffix('.sha256.txt'),checksum+'  '+archive.name+'\n')
    print(json.dumps({'archive':str(archive),'package':str(package),'sha256':checksum,
                      'zipBytes':archive.stat().st_size,'files':len(hashes)+1,'sourceCommit':commit},ensure_ascii=False),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--version',required=True)
    for name in ('node','node-license','vc-runtime','msvc-license','paddle-license','geos-source','shapely-source'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--node-sha256',required=True)
    build(parser.parse_args())
