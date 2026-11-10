# 浏览器本地识图

图片不会提交给计算服务器。主线程把所选文件交给 Worker；Worker 内使用 Pyodide 的 OpenCV、NumPy、Pillow 运行现有图像解析，并使用 ONNX Runtime Web 的 WebAssembly 后端执行文字检测和识别。

此实现保留现有头像定位、头像匹配阈值、卡池边界、宽屏适配和疑点复核规则。它不把未确定的头像当作已识别角色，也不依靠示例记录补造结果。

## 接口

```js
const engine = await createBrowserOCR(pyodide, {baseURL, ort, onProgress});
const {document, files} = await engine.recognize({name, bytes, id});
```

- 调用前将应用 Python 源码解包到 `/app`，把 `/app/tools/gacha_rating_app` 加入 `sys.path`。
- `baseURL` 是包含 `manifest.json`、`pipeline.py`、`rapidocr-source.zip`、两个模型的目录。
- `ort` 由宿主导入本地 `ort.wasm.min.mjs`，宿主设置 `ort.env.wasm.wasmPaths` 指向同版本本地 WASM 目录。
- `id` 是 32 位十六进制记录编号。`bytes` 是所选图片的 `Uint8Array` 或 `ArrayBuffer`。
- 返回的 `document` 使用桌面版现有导入文档结构，交给 `build_ledger` 和重校验流程。
- `files` 中每项包含虚拟文件路径、MIME、完整图片字节。宿主必须持久化这些字节并映射证据路径，不能把暂时的 Blob URL 当成永久存储。
- 返回后虚拟文件系统会清理本张原图和裁剪图，避免连续导入占满 Worker 内存。
- 以上运行库均在浏览器内执行；用户不需要安装 Python、Node 或其他开发环境。

## 构建

在开发环境安装桌面版固定依赖后运行：

```powershell
python scripts/build_browser_ocr.py --output dist/browser-site/browser/ocr/assets
```

构建使用 `rapidocr-onnxruntime==1.4.4` 的原始 Python 源码、PP-OCRv4 检测和识别模型，从识别模型本身的元数据导出字典，并携带 RapidOCR 和 PaddleOCR 的 Apache-2.0 许可证。浏览器不下载或加载原生 ONNX Runtime；Python 中的原生会话入口被显式禁止。旋转分类器在现有桌面识图中关闭，浏览器版也不加载它。

运行库固定为 Pyodide 0.29.3 和 ONNX Runtime Web 1.23.2；所有运行资源由同一个静态站点提供。使用单线程 WASM，无需给站点配置跨源隔离。浏览器第一次使用需要下载相关资源，实际速度取决于设备。

## 验证边界

`browser/tests/ocr_pipeline_test.py` 可用使用者自己提供的截图验证拆分前后处理流程与桌面 RapidOCR 的语义一致性。它使用原生 ORT，不等同于浏览器测试。

迁移时另外执行了真实 Edge 浏览器测试：一张 2304×10102 的宽屏截图识别得到 12 个卡池，一张 1280×10375 的手机截图识别得到 13 个卡池。两张的主要抽数、出货位置、角色、加急和六维评分均与桌面版相同，均能计算六个维度。另记录网络请求确认仅访问本地静态资源。此结果不代表所有手机、平板、浏览器或不同截图结构都已验证。
