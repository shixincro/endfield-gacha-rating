# 第三方内容与许可证

根目录 MIT 许可证覆盖本项目原创代码与文档，不将游戏素材、商标或第三方软件重新许可为 MIT。

## 游戏头像

`tools/gacha_ocr_prototype/assets/manifest.json` 记录角色名称、素材来源及 SHA-256。头像来自 [华法琳档案馆](https://warfarin.wiki/cn/operators)，游戏素材权利属于各自权利人；站点的[关于页面](https://warfarin.wiki/cn/about)说明其非商业粉丝项目定位。

仓库不包含头像图片、拼图、玩家截图或头像裁片。`scripts/download_assets.py` 按清单下载素材供本机匹配使用，下载不会授予额外的公开再分发权利。打包或分发素材时需另行核实授权。

本项目不是鹰角网络、GRYPHLINE 或小黑盒的官方产品。名称仅用于说明兼容的数据与规则。

## 软件与模型

以下组件由用户从各自发行渠道安装，未作为二进制复制进此仓库。准确许可及捆绑组件说明以安装版本随附文件为准。

| 组件 | 许可证或说明 | 上游 |
| --- | --- | --- |
| Python | PSF 等随附许可 | <https://www.python.org/psf/license/> |
| Pyodide | MPL-2.0；其 CPython 与第三方包分别遵循自身许可 | <https://github.com/pyodide/pyodide/blob/0.29.3/LICENSE> |
| Node.js | MIT 及随附第三方许可 | <https://github.com/nodejs/node/blob/main/LICENSE> |
| RapidOCR | Apache-2.0 | <https://github.com/RapidAI/RapidOCR/blob/main/LICENSE> |
| PaddleOCR 模型 | RapidOCR 依赖所含 PP-OCR 检测、识别和分类模型；上游 Apache-2.0 | <https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE> |
| ONNX Runtime | MIT | <https://github.com/microsoft/onnxruntime/blob/main/LICENSE> |
| OpenCV / opencv-python | 核心 Apache-2.0，Python 包装 MIT，捆绑组件另有许可 | <https://github.com/opencv/opencv-python/blob/5.x/LICENSE.txt> |
| NumPy | BSD-3-Clause 及随附组件许可 | <https://github.com/numpy/numpy/blob/main/LICENSE.txt> |
| Pillow | MIT-CMU | <https://github.com/python-pillow/Pillow/blob/main/LICENSE> |
| Shapely / GEOS | Shapely BSD-3-Clause，GEOS LGPL-2.1 | <https://shapely.readthedocs.io>, <https://libgeos.org> |

完整依赖及传递依赖由 pip 解析。若制作二进制分发包，需要包含实际分发组件的许可证，并重新核对游戏素材的分发范围。

## 浏览器构建

浏览器版使用 Pyodide 0.29.3 和 ONNX Runtime Web 1.23.2。准备脚本保留 Pyodide LICENSE、ONNX Runtime LICENSE 与 ThirdPartyNotices，OCR 资源保留 RapidOCR/PaddleOCR 的 Apache-2.0 原文；Pyodide wheel 包内含各自许可证。运行库与模型不进 Git。

本地预览构建会把已下载的游戏头像复制到生成目录，用于浏览器内匹配；这不改变头像的权利归属或授予公开再分发许可。构建目录与代码仓库的分发范围应分别检查。

## Windows 便携下载包

GitHub Release 的 Windows ZIP 附带 Python、Node.js、OCR 模型和实际 Python 依赖。原始许可证分别保留在 `runtime/python/LICENSE.txt`、`runtime/node/LICENSE.txt`、各 Python 包及其 `dist-info` 目录内；PaddleOCR 的 Apache-2.0 原文另附于 RapidOCR 包内。精确版本与文件校验值见 `package-info.json` 和 `SHA256SUMS.json`。

Microsoft Visual C++ 运行库按原样随应用放置在本地目录，适用 [Microsoft Visual C++ Runtime 许可条款](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/)及[再分发说明](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)，不适用本项目 MIT。许可原文附在 `runtime/python/Microsoft-VC-Runtime-License.docx`。

此包不包含游戏头像，首次使用按清单下载。只用于视频编解码的 OpenCV FFmpeg 插件未打入便携包。

GEOS 动态库及 Shapely 绑定的对应源码归档随包放在 `third_party_sources/`，许可证保留在 Shapely 的 `dist-info/licenses/`。可按 LGPL 修改、替换 GEOS 或重建绑定，并允许为调试这些修改进行逆向工程；本项目未对该权利附加限制。
