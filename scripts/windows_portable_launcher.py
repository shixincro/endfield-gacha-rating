"""Windows portable launcher; copied to the distributable's root directory.

Only this wrapper owns its server token/process record. Production scoring and
server sources stay unchanged, and no installation/global setting is required.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from urllib.request import ProxyHandler, build_opener
import webbrowser


ROOT = Path(__file__).resolve().parent
VERSION = "gacha-rating-local-v1"
TOKEN_ENV = "ENDFIELD_PORTABLE_START_TOKEN"


def layout(root=ROOT):
    root = Path(root).resolve()
    app = root / "tools" / "gacha_rating_app"
    return {"root": root, "app": app, "python": root / "runtime/python/python.exe",
            "node": root / "runtime/node/node.exe", "server": app / "server.py",
            "state": root / "data/portable-server.json", "log": app / "data/server.log"}


def child_environment(paths, token):
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith("PYTHON") and k.upper() not in ("NODE_OPTIONS", "NODE_PATH")}
    env["PATH"] = str(paths["node"].parent) + os.pathsep + env.get("PATH", "")
    env[TOKEN_ENV] = token
    return env


def live_config(port, timeout=0.8):
    if type(port) is not int or not 1024 <= port <= 65535:
        return None
    try:
        # Local traffic must not be redirected by machine-specific proxy vars.
        with build_opener(ProxyHandler({})).open(
                f"http://127.0.0.1:{port}/api/config", timeout=timeout) as response:
            body = response.read(65537)
        if len(body) > 65536:
            return None
        config = json.loads(body)
        return config if isinstance(config, dict) else None
    except (OSError, ValueError, TimeoutError):
        return None


def windows_api():
    if os.name != "nt":
        raise RuntimeError("此便携包仅支持 Windows。")
    from ctypes import wintypes as w
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "OpenProcess": ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "QueryFullProcessImageNameW": ([w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)], w.BOOL),
        "GetProcessTimes": ([w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4, w.BOOL),
        "TerminateProcess": ([w.HANDLE, w.UINT], w.BOOL),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "CreateMutexW": ([ctypes.c_void_p, w.BOOL, w.LPCWSTR], w.HANDLE),
        "ReleaseMutex": ([w.HANDLE], w.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(dll, name)
        function.argtypes, function.restype = args, result
    return dll, w


def handle_identity(dll, w, handle):
    size = w.DWORD(32768)
    buffer = ctypes.create_unicode_buffer(size.value)
    times = [w.FILETIME() for _ in range(4)]
    if not dll.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
        return None
    if not dll.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
        return None
    return {"executable": os.path.normcase(os.path.realpath(buffer.value)),
            "created": (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime}


def process_identity(pid):
    if type(pid) is not int or pid <= 0:
        return None
    dll, w = windows_api()
    handle = dll.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        return handle_identity(dll, w, handle)
    finally:
        dll.CloseHandle(handle)


def identity_matches(state, identity, paths):
    expected = os.path.normcase(os.path.realpath(paths["python"]))
    return (isinstance(identity, dict) and identity.get("executable") == expected
            and state.get("executable") == expected
            and type(state.get("created")) is int
            and state["created"] == identity.get("created"))


def owns_live_server(state, paths):
    if not isinstance(state, dict) or not isinstance(state.get("token"), str):
        return False
    if not identity_matches(state, process_identity(state.get("pid")), paths):
        return False
    config = live_config(state.get("port"))
    return bool(config and config.get("version") == VERSION
                and isinstance(config.get("token"), str)
                and secrets.compare_digest(config["token"], state["token"]))


def read_state(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


@contextmanager
def launch_lock(root):
    dll, _ = windows_api()
    digest = hashlib.sha256(os.path.normcase(str(root)).encode("utf-8")).hexdigest()[:32]
    handle = dll.CreateMutexW(None, False, "Local\\EndfieldPortable_" + digest)
    if not handle:
        raise RuntimeError("无法创建启动锁，请检查本机权限。")
    acquired = False
    try:
        acquired = dll.WaitForSingleObject(handle, 25000) in (0, 0x80)
        if not acquired:
            raise RuntimeError("另一个启动窗口正在处理，请稍后重试。")
        yield
    finally:
        if acquired:
            dll.ReleaseMutex(handle)
        dll.CloseHandle(handle)


def available_port(requested=None):
    candidates = [requested] if requested is not None else range(4320, 4341)
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("指定端口已被占用。" if requested is not None
                       else "4320—4340 端口都被占用，请用 --port 指定其他端口。")


def stop_server(state, paths):
    if not state:
        print("没有本便携包的后台启动记录。")
        return 0
    if not owns_live_server(state, paths):
        print("未找到可验证的本包后台进程，未关闭任何程序。")
        return 1
    dll, w = windows_api()
    handle = dll.OpenProcess(0x1000 | 0x0001 | 0x00100000, False, state["pid"])
    if not handle:
        raise RuntimeError("无法打开本包后台进程，未关闭任何程序。")
    try:
        # Recheck the actual handle, not just PID, to prevent PID-reuse races.
        if not identity_matches(state, handle_identity(dll, w, handle), paths):
            raise RuntimeError("进程身份已变化，未关闭任何程序。")
        config = live_config(state["port"])
        if not config or config.get("version") != VERSION or config.get("token") != state["token"]:
            raise RuntimeError("后台令牌核验失败，未关闭任何程序。")
        if not dll.TerminateProcess(handle, 0):
            raise RuntimeError("无法关闭本包后台进程。")
        if dll.WaitForSingleObject(handle, 5000) != 0:
            raise RuntimeError("已请求关闭，但未能确认后台退出；启动记录暂时保留。")
    finally:
        dll.CloseHandle(handle)
    paths["state"].unlink(missing_ok=True)
    print("已关闭本便携包的后台服务；已保存的记录保留。")
    return 0


def serve(port, paths):
    token = os.environ.pop(TOKEN_ENV, None)
    if not token:
        raise RuntimeError("后台模式只能由便携启动器调用。")
    sys.path.insert(0, str(paths["app"]))
    import server
    server.TOKEN = token
    sys.argv = [str(paths["server"]), "--port", str(port)]
    server.main()


def launch(paths, requested=None, no_browser=False):
    for key in ("python", "node", "server"):
        if not paths[key].is_file():
            raise RuntimeError(f"缺少文件：{paths[key]}\n请先完整解压便携包，不要直接在压缩包里启动。")
    old = read_state(paths["state"])
    if owns_live_server(old, paths):
        if requested is not None and old["port"] != requested:
            raise RuntimeError(f"本包已在 {old['port']} 端口运行；请先 --stop 再指定新端口。")
        port = old["port"]
        print("已连接本便携包正在运行的服务。")
    else:
        prepare_avatars(paths)
        port = available_port(requested)
        token = secrets.token_urlsafe(32)
        paths["log"].parent.mkdir(parents=True, exist_ok=True)
        with paths["log"].open("a", encoding="utf-8") as log:
            child = subprocess.Popen(
                [str(paths["python"]), "-I", "-B", str(paths["root"] / "portable_launch.py"),
                 "--_serve", "--port", str(port)], cwd=paths["root"],
                env=child_environment(paths, token), stdin=subprocess.DEVNULL,
                stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        started = time.monotonic()
        while time.monotonic() - started < 20:
            if child.poll() is not None:
                raise RuntimeError(f"后台启动失败，请查看日志：{paths['log']}")
            config = live_config(port, timeout=0.3)
            if config and config.get("version") == VERSION and config.get("token") == token:
                identity = process_identity(child.pid)
                if identity is None:
                    child.terminate()  # Popen owns an exact process handle.
                    raise RuntimeError("无法验证新后台进程的身份，已停止本次启动。")
                state = {"pid": child.pid, "port": port, "token": token, **identity}
                if not identity_matches(state, identity, paths):
                    child.terminate()
                    raise RuntimeError("后台解释器路径不符合本包配置，已停止本次启动。")
                try:
                    save_state(paths["state"], state)
                except OSError:
                    child.terminate()
                    raise RuntimeError("无法保存启动记录，请将便携包移到可写的文件夹。")
                break
            time.sleep(0.15)
        else:
            child.terminate()
            raise RuntimeError(f"后台启动超时，本次进程已停止。请查看：{paths['log']}")
        print("抽卡工具已启动（识图和计算均在本机完成）。")
    url = f"http://127.0.0.1:{port}/"
    print(url)
    if not no_browser and not webbrowser.open(url):
        print("浏览器未自动打开，请复制上面的网址到浏览器。")
    return 0


def prepare_avatars(paths):
    assets = paths['root']/'tools/gacha_ocr_prototype/assets'
    manifest = json.loads((assets/'manifest.json').read_text(encoding='utf-8'))
    missing = [item for item in manifest['characters']
               if not (assets/item['file']).is_file()
               or hashlib.sha256((assets/item['file']).read_bytes()).hexdigest() != item['sha256']]
    if not missing:
        return
    print('首次使用，正在准备识图所需的头像素材…', flush=True)
    try:
        subprocess.run([str(paths['python']), '-I', '-B', str(paths['root']/'scripts/download_assets.py')],
                       cwd=paths['root'], env=child_environment(paths, ''), check=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        print('头像暂未下载完成，可先导入 TXT / JSON；识图前请运行“下载头像素材.cmd”。', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="终末地抽卡工具便携启动器")
    parser.add_argument("--port", type=int, help="指定端口（1024—65535），不自动改用其他端口")
    parser.add_argument("--no-browser", action="store_true", help="仅启动后台，不打开浏览器")
    parser.add_argument("--stop", action="store_true", help="核验后关闭本便携包的后台，请先等待计算完成")
    parser.add_argument("--_serve", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("端口须为 1024—65535。")
    paths = layout()
    try:
        if args._serve:
            serve(args.port or 4320, paths)
            return 0
        with launch_lock(paths["root"]):
            if args.stop:
                return stop_server(read_state(paths["state"]), paths)
            return launch(paths, args.port, args.no_browser)
    except (OSError, RuntimeError) as exc:
        print(f"启动器提示：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
