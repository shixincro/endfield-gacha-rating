"""Offline portable-package diagnostic; never imports or changes user history."""
from pathlib import Path
import ctypes
import json
import math
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def main():
    os.environ['PATH'] = str(ROOT/'runtime/node')+os.pathsep+os.environ.get('PATH', '')
    for key in ('NODE_OPTIONS', 'NODE_PATH', 'PYTHONHOME', 'PYTHONPATH'):
        os.environ.pop(key, None)
    if not Path(sys.executable).resolve().is_relative_to(ROOT/'runtime/python'):
        raise RuntimeError('未使用本包内置的Python。')
    for entry in sys.path:
        if not Path(entry).resolve().is_relative_to(ROOT):
            raise RuntimeError('发现包外Python依赖路径：'+entry)
    node = shutil.which('node')
    assert node and Path(node).resolve() == (ROOT/'runtime/node/node.exe').resolve()
    import numpy
    import cv2
    import PIL
    from importer import create_engine, _prototype, build_ledger
    engine = create_engine()
    rows, _ = engine(numpy.full((80, 300, 3), 255, dtype=numpy.uint8), use_cls=False)
    _prototype()
    import avatar_match
    names = avatar_match._templates()[2]
    from service import score_ledger
    doc = {'file': 'synthetic-self-test.png', 'kind': 'character', 'source_sha256': 'a'*64,
           'identity': {}, 'issues': [],
           'pools': [{'banner': '熔火灼痕', 'total': 10, 'tail': 0, 'quota': 2360,
                      'events': [{'pulls': 10, 'pity': None, 'character': '莱万汀', 'off': False}],
                      'rush': [], 'rush_present': False, 'rush_state': False,
                      'token_count': 0, 'needs_review': []}]}
    ledger = build_ledger([doc])
    ledger['weapon'] = {'N': 60, 'K6': 2, 'KU': 1}
    result = score_ledger(ledger)
    assert result['scoredAxes'] == 6
    assert all(math.isfinite(axis['score']) for axis in result['axes'].values())
    ledger['weapon']['profile'] = '1'
    assert score_ledger(ledger)['scoredAxes'] == 6
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    kernel.GetModuleHandleW.restype = ctypes.c_void_p
    kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint]
    loaded = {}
    for name in ('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        handle = kernel.GetModuleHandleW(name)
        buffer = ctypes.create_unicode_buffer(32768)
        if not handle or not kernel.GetModuleFileNameW(handle, buffer, len(buffer)):
            raise RuntimeError('无法检查运行库：'+name)
        assert Path(buffer.value).resolve().is_relative_to(ROOT/'runtime/python'), buffer.value
        loaded[name] = str(Path(buffer.value).relative_to(ROOT))
    print(json.dumps({'status': 'PASS', 'python': sys.version.split()[0],
                      'node': subprocess.check_output([node, '--version'], text=True).strip(),
                      'numpy': numpy.__version__, 'opencv': cv2.__version__,
                      'pillow': PIL.__version__, 'offlineOcrModels': 3,
                      'avatarTemplates': len(names), 'scoredAxes': result['scoredAxes'],
                      'characterVersion': result['character']['version'],
                      'nativeLibraries': loaded}, ensure_ascii=False, indent=2))
    print('自检通过：离线识图、头像模板、六维评分及武器潜能分支均可运行。未修改历史记录。')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        print('自检失败，请将以上错误信息发回排查。')
        raise SystemExit(1)
