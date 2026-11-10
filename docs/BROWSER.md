# 浏览器本地计算版本

本版已把评分、TXT/JSON 导入、截图识别和记录保存接到浏览器本地。网站只提供 HTML、代码、模型和运行库；导入的图片、抽卡文件和计算请求不会发送到服务器。访问者不需要安装 Python、Node.js 或开发环境。

当前是可运行、已在 Windows Edge 上验证的迁移版本，尚未发布公网地址或替换 Windows v0.1.0 下载包。手机硬件、Safari、Firefox 和低内存设备尚未完成实机验收。

## 实现方式

| 部分 | 浏览器实现 |
| --- | --- |
| 角色四轴 | 打包现有 JavaScript 算法，放在 module Worker 中运行 |
| 武器两轴 | 原生 JavaScript，保留潜能表、溢出和亏损修正的原参照 |
| 导入、校验、规划亏损、中断修正、假设保底 | 原 Python 逻辑通过 Pyodide WebAssembly 在同一 Worker 内运行 |
| OCR | ONNX Runtime Web 执行原 PP-OCRv4 模型，Pyodide 执行原图像处理和头像校验 |
| 历史、原图、裁片 | 当前网站的 IndexedDB；显示时生成临时 Blob URL |

这不是全部重写成 JavaScript。保留成熟的 Python 解析逻辑，是为了沿用已有规则和测试；Python 运行环境由网页自动加载，不需要用户安装。Worker 中没有本机进程、后台评分接口或云识图回退。桌面版原算法仍作为对照基准。

武器潜能参照在浏览器执行 Float64 DP。默认十池参照使用从原确定性 DP 生成的静态表；其生成脚本和合成对照样本均已保留。两者都没有引入随机采样。

## 构建与本地预览

以下操作只由开发者或网站维护者执行。先按根目录 README 准备 `.venv`、固定 OCR 依赖及头像素材，然后运行：

```powershell
.\.venv\Scripts\python.exe scripts/prepare_browser_runtime.py
.\.venv\Scripts\python.exe scripts/build_browser_ocr.py --output browser/vendor/ocr
.\.venv\Scripts\python.exe scripts/build_browser.py
.\.venv\Scripts\python.exe -m http.server 4321 --bind 127.0.0.1 --directory dist/browser-site
```

打开 `http://127.0.0.1:4321/`。这里的预览服务仅发送静态文件，不运行评分或 OCR。不能直接双击 `index.html` 使用 `file://`，Worker、WebAssembly 和剪贴板需要合适的网站环境。

固定运行库为 Pyodide 0.29.3、ONNX Runtime Web 1.23.2、RapidOCR 1.4.4。准备脚本校验 Pyodide wheel 的上游 SHA-256 以及 npm 发布包的完整性摘要；本地构建再次校验运行库文件。第三方资源在 `browser/vendor/`，不进 Git。`build-manifest.json` 记录产物文件校验值。

运行库与模型全部从站点本身加载，无运行时 CDN 依赖。OCR 组件首次识图时才加载；纯 TXT/JSON 不加载模型。当前静态目录约 56 MiB，首次打开和首次识图需要加载相应资源。没有 Service Worker 离线页面缓存，不能把已打开页面内的本地计算等同于离线冷启动。

## 部署条件

部署对象是 `dist/browser-site/`，不是整个仓库，也不是桌面版 Python 服务。可放在普通 HTTPS 静态托管上，根目录或子目录均采用相对资源路径。

- 保留目录结构，让 `.js` / `.mjs` 使用 JavaScript MIME，`.wasm` 使用 `application/wasm`，未知文件不要全部回退为 HTML。
- 使用 HTTPS；本机开发可用 localhost。剪贴板写入仍需浏览器支持和用户授权。
- ONNX 使用单线程 WASM，不要求 `SharedArrayBuffer` 或跨源隔离。
- 如自行配置 CSP，需允许本站 Worker、WASM 编译及本地 Blob 图片；不要复制桌面版服务器的旧 CSP 原样限制新运行时。
- 本次构建为识图复制了已下载的公开游戏头像，未写入 Git；公开托管或分发时仍需遵守素材权利人的要求，见第三方说明。

## 记录与迁移

浏览器版和桌面版有独立记录库。旧版先点击“保存记录 JSON”，新版通过首页或历史窗口导入即可；不用重新识图。已有单人记录和最多 12 人的合集格式继续支持。

记录、原图和裁片只保存在当前网站对应的浏览器存储。更换浏览器、浏览器用户、域名或端口，不会自动共享数据。清除网站数据、隐私模式结束或浏览器存储被清理可能导致记录消失，请导出 JSON 备份。

JSON 保留账本、修正、原始导入内容和评分，不内嵌原图。导入另一个浏览器后，没有图片的详情显示文字表；这与桌面版 JSON 的原图引用约定一致。新识别截图的原图及裁片会在当前浏览器内一并持久化，刷新后仍可查看。

每张图片独立建档；单张识别失败不会删除其他成功结果。保存记录与图片使用同一个 IndexedDB 事务，存储不足时明确提示失败。批量删除会保留其他记录仍引用的图片。

连续修改按同一记录顺序保存；每次提交生成独立版本标记。其他标签页修改过的数据会要求重新打开，计算完成时若记录已被删除，不会重新生成它。

## 验证

无浏览器依赖的对照测试：

```powershell
.\.venv\Scripts\python.exe scripts/run_tests.py
.\.venv\Scripts\python.exe browser/tests/python_bridge_test.py
node --test browser/tests/weapon.test.mjs
```

准备 Playwright 和 Edge 后，对构建后的静态页运行：

```powershell
node browser/tests/browser-integration.cjs http://127.0.0.1:4321/
node browser/tests/storage-concurrency.cjs <安装了Playwright的目录>
```

可用 `PLAYWRIGHT_MODULE_PATH`、`PYTHON`、`BROWSER_CHANNEL` 指定测试工具。以上开发测试依赖不属于用户运行要求。

本次已完成：

- 202 项武器 JS 测试，185 条合成记录与原 Python 逐字段对照；最大分数误差约 `1.34e-12`。
- 12 项 Python 桥对照；六类文件格式、假设、校验和既有会话恢复。
- 真正 Edge 页面：六格式导入、六轴与亏损对照、手动补录、豁免、假设最终计分、刷新、历史隔离、批量删除和格式错误提示。
- 9 份用户历史导出私下对照，完整账本与结果一致；本来缺记录的两份仍保留异常，未改成虚假完整评分。私人文件未放进仓库。
- 两张真实截图：2304×10102 宽屏图 12 池、1280×10375 手机图 13 池；账本和六轴与桌面版一致。当前电脑识图约 19—21 秒，不代表其他设备速度。
- 两张图片一次导入后独立建档，刷新再开详情，原图裁片正常显示。
- 浏览器测试监测网络：计算和识图过程中只有静态 GET，零评分 API 请求、零用户数据上传。
- 独立的 10 类存储并发测试覆盖连续修改、跨标签同版本冲突、计算期间删除及失败事务；子路径部署可用。页面运行库加载后禁止所有 HTTP 请求，导入 TXT、修正、六轴重算与存档仍可完成。

六类导入、两种截图布局验证不代表任意新格式或截图都能正确识别；已有的疑点复核机制继续生效。
