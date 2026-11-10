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
| Node.js | MIT 及随附第三方许可 | <https://github.com/nodejs/node/blob/main/LICENSE> |
| RapidOCR | Apache-2.0 | <https://github.com/RapidAI/RapidOCR/blob/main/LICENSE> |
| PaddleOCR 模型 | RapidOCR 依赖所含 PP-OCR 检测、识别和分类模型；上游 Apache-2.0 | <https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE> |
| ONNX Runtime | MIT | <https://github.com/microsoft/onnxruntime/blob/main/LICENSE> |
| OpenCV / opencv-python | 核心 Apache-2.0，Python 包装 MIT，捆绑组件另有许可 | <https://github.com/opencv/opencv-python/blob/5.x/LICENSE.txt> |
| NumPy | BSD-3-Clause 及随附组件许可 | <https://github.com/numpy/numpy/blob/main/LICENSE.txt> |
| Pillow | MIT-CMU | <https://github.com/python-pillow/Pillow/blob/main/LICENSE> |

完整依赖及传递依赖由 pip 解析。若制作二进制分发包，需要包含实际分发组件的许可证，并重新核对游戏素材的分发范围。
