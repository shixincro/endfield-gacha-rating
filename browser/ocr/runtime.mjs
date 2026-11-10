// All image pixels and model inference stay inside the browser's worker.
const PACKAGES = ['opencv-python', 'numpy', 'pillow', 'pyclipper', 'shapely', 'pyyaml'];

async function readAsset(baseURL, path, binary = false) {
  const response = await fetch(new URL(path, baseURL));
  if (!response.ok) throw new Error(`识图资源加载失败：${path} (${response.status})`);
  return binary ? new Uint8Array(await response.arrayBuffer()) : response.text();
}

function copyTensor(pyodide) {
  const value = pyodide.runPython('_browser_ocr.tensor');
  const view = value.getBuffer('f32');
  try { return {data: view.data.slice(), dims: Array.from(view.shape)}; }
  finally { view.release(); value.destroy(); }
}

function acceptTensor(pyodide, method, tensor) {
  pyodide.globals.set('_ocr_values', tensor.data);
  pyodide.globals.set('_ocr_dimensions', tensor.dims);
  try {
    return pyodide.runPython(`_browser_ocr.${method}(*receive_tensor(_ocr_values, _ocr_dimensions))`);
  } finally {
    pyodide.globals.delete('_ocr_values');
    pyodide.globals.delete('_ocr_dimensions');
  }
}

function removeTree(fs, path) {
  for (const entry of fs.readdir(path).filter(name => name !== '.' && name !== '..')) {
    const child = `${path}/${entry}`;
    if (fs.isDir(fs.stat(child).mode)) removeTree(fs, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
}

export async function createBrowserOCR(pyodide, {
  baseURL = new URL('./', import.meta.url), ort, onProgress = () => {},
} = {}) {
  if (!ort?.InferenceSession) throw new Error('浏览器识图引擎尚未加载。');
  onProgress('正在加载本地识图组件…');
  await pyodide.loadPackage(PACKAGES);
  const [bundle, script, manifestText] = await Promise.all([
    readAsset(baseURL, 'rapidocr-source.zip', true),
    readAsset(baseURL, 'pipeline.py'), readAsset(baseURL, 'manifest.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  pyodide.unpackArchive(bundle, 'zip', {extractDir:'/browser-ocr-vendor'});
  pyodide.runPython("import sys; sys.path.insert(0, '/browser-ocr-vendor')");
  pyodide.runPython(script);
  pyodide.globals.set('_ocr_characters_json', JSON.stringify(manifest.characters));
  pyodide.runPython('_browser_ocr = BrowserOCR(json.loads(_ocr_characters_json)); del _ocr_characters_json');
  onProgress('正在加载文字识别模型…');
  // One WASM thread works without cross-origin isolation on ordinary hosting.
  ort.env.wasm.numThreads = 1;
  const options = {executionProviders:['wasm'], graphOptimizationLevel:'all'};
  const detector = await ort.InferenceSession.create(new URL(manifest.detector, baseURL).href, options);
  const recognizer = await ort.InferenceSession.create(new URL(manifest.recognizer, baseURL).href, options);
  let running = false;

  async function infer(session) {
    const input = copyTensor(pyodide);
    const result = await session.run({[session.inputNames[0]]:new ort.Tensor('float32', input.data, input.dims)});
    return result[session.outputNames[0]];
  }

  return {
    async recognize({name, bytes, id}) {
      if (running) throw new Error('正在识别上一张图片，请稍候。');
      if (!/^[a-f0-9]{32}$/i.test(id ?? '')) throw new Error('无效的图片记录编号。');
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (!data.length || data.length > 40*1024*1024) throw new Error('请选择小于40 MB的截图。');
      const safeName = String(name || 'screenshot.png').replace(/^.*[\\/]/, '').replace(/[\x00-\x1f]/g, '_');
      if (!/\.(png|jpg|jpeg|webp)$/i.test(safeName)) throw new Error('截图支持 PNG、JPG 或 WEBP 格式。');
      const root = `/browser-evidence/${id}`;
      const source = `${root}/${safeName}`;
      const output = `${root}/parsed`;
      pyodide.FS.mkdirTree(root);
      pyodide.FS.writeFile(source, data);
      running = true;
      const started = performance.now();
      try {
        pyodide.globals.set('_ocr_source', source);
        pyodide.globals.set('_ocr_output', output);
        const tiles = pyodide.runPython('_browser_ocr.start(_ocr_source, _ocr_output)');
        for (let tile=0; tile<tiles; tile++) {
          onProgress(`正在识别图片 ${tile+1}/${tiles}…`);
          if (!pyodide.runPython('_browser_ocr.begin_tile()')) break;
          acceptTensor(pyodide, 'detected', await infer(detector));
          while (pyodide.runPython('_browser_ocr.begin_recognition()')) {
            acceptTensor(pyodide, 'recognized', await infer(recognizer));
          }
          pyodide.runPython('_browser_ocr.finish_tile()');
        }
        onProgress('正在核对卡池和角色头像…');
        const result = JSON.parse(pyodide.runPython('_browser_ocr.finish()'));
        result.files = result.files.map(path => ({
          path, mime: /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg',
          bytes:pyodide.FS.readFile(path),
        }));
        result.document.timing.browser_total_seconds = (performance.now()-started)/1000;
        return result;
      } finally {
        running = false;
        pyodide.runPython('_browser_ocr.reset()');
        pyodide.globals.delete('_ocr_source');
        pyodide.globals.delete('_ocr_output');
        // Evidence bytes have been copied to the caller. The virtual filesystem
        // must not retain every original screenshot for the lifetime of a tab.
        removeTree(pyodide.FS, root);
      }
    },
    async dispose() { await detector.release(); await recognizer.release(); },
  };
}
