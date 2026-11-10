# 发布 Windows 便携版

构建在 Windows x64、Python 3.12 的干净虚拟环境中进行，安装项目的固定 requirements。先运行 `python scripts/run_tests.py` 并提交发布代码；构建器要求工作区干净，包内记录对应 Git 提交。

准备 Node.js 官方 Windows x64 发行包及其 LICENSE，使用官方 `SHASUMS256.txt` 核对压缩包和 `node.exe`。Microsoft VC 运行库需要已获许可、可再分发的原始 x64 文件：`msvcp140.dll`、`msvcp140_1.dll`、`msvcp140_2.dll`、`vcruntime140.dll`、`vcruntime140_1.dll`，并保留微软 Runtime 许可原文。还需准备 PaddleOCR 上游的 Apache-2.0 LICENSE。第三方范围见根目录 `THIRD_PARTY_NOTICES.md`。

```powershell
.\.venv\Scripts\python.exe scripts/build_windows_release.py `
  --version v0.1.0 `
  --node <node.exe路径> --node-license <Node-LICENSE路径> `
  --node-sha256 <官方node.exe校验值> `
  --vc-runtime <原始x64运行库目录> `
  --msvc-license <微软Runtime许可docx路径> `
  --paddle-license <PaddleOCR-LICENSE路径> `
  --geos-source <对应GEOS版本源码tar.bz2路径> `
  --shapely-source <对应Shapely版本源码tar.gz路径>
```

输出位于 `dist/`，包括 ZIP 与 SHA-256 文件；已有同名包不会被覆盖。源代码使用明确允许的文件清单，游戏图片、玩家数据、开发环境及 Git 登录状态不会被复制。Python 依赖来自当前干净虚拟环境，许可证随库保留。

发布前应将 ZIP 解压到含中文和空格的新目录，用包内 Python 和 Node 完成环境自检、首次素材下载、TXT/JSON 导入、示例恢复、六项评分、记录保存重开、未知格式弹窗和后台启停验证。原始 ZIP 保持无玩家数据状态，测试记录只写在解压后的临时副本。

通过后向同一 Git 提交添加版本 tag，将 ZIP 与 SHA-256 文件上传到 GitHub Release，再公开发布。源码 ZIP 由 GitHub 自动提供。
