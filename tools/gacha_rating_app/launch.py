"""User double-click launcher, keeps only the local server running in background."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import urlopen
import webbrowser

ROOT=Path(__file__).resolve().parent
URL='http://127.0.0.1:4320/'

def ready():
    try:
        with urlopen(URL+'api/config',timeout=1) as response:
            return json.load(response).get('version')=='gacha-rating-local-v1'
    except Exception:
        return False

def main():
    if not ready():
        logs=ROOT/'data'
        logs.mkdir(exist_ok=True)
        with (logs/'server.log').open('a',encoding='utf-8') as log:
            child=subprocess.Popen([sys.executable,str(ROOT/'server.py'),'--port','4320'],cwd=ROOT,
                                   stdout=log,stderr=log,stdin=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        for _ in range(40):
            if ready():break
            if child.poll() is not None:break
            time.sleep(.25)
    if not ready():
        print('启动失败，请查看 tools/gacha_rating_app/data/server.log。端口4320可能被其他程序占用。')
        return 1
    webbrowser.open(URL)
    print('工具已启动：'+URL)
    print('关闭本窗口不影响本地服务。所有截图只保存在本机。')
    return 0

if __name__=='__main__':
    raise SystemExit(main())
