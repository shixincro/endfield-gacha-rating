# 终末地抽卡评分工具

识别小黑盒抽卡截图或导入 TXT / JSON 记录，核对账本并计算六维欧非与规划亏损。网页可直接使用，识图、评分和记录保存都在访问者的浏览器内完成。

维护者：[shixincro](https://github.com/shixincro)。原创代码使用 [MIT 许可证](LICENSE)。游戏素材与第三方依赖遵循各自的许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 在线体验

**[打开终末地抽卡评分工具（shixincro.top）](https://shixincro.top/)**

浏览器版无需安装 Python 或 Node.js。记录保存在当前浏览器和当前网址下。从旧网址换到正式站时，可先导出记录 JSON，再到正式站导入。

<details>
<summary>早期在线入口</summary>

旧站与正式站的浏览器记录各自保存，网页版本也可能不同。

- [Cloudflare](https://endfield-gacha-rating.endfield-gacha-rating-cloudflare.workers.dev/)
- [ChatGPT Sites](https://endfield-gacha-rating.aqargwbmncht.chatgpt.site/)

</details>

## 算法与仿真文档

| 页面 | 内容 |
| --- | --- |
| [算法总览](docs/ALGORITHMS.md) | 六轴怎么看、计算边界与模块版本 |
| [角色欧非](docs/CHARACTER_SCORING.md) | 120保底区、无120保底区、加急合分、歪 New 修正与五星校准 |
| [武器欧非](docs/WEAPON_SCORING.md) | 六星武器和当期专武的十池参照、潜能与直赠 |
| [规划亏损](docs/PLANNING_LOSS.md) | 期望、机会和实际亏损，逐池结算与示例 |
| [导入与账本](docs/RECORD_FORMAT.md) | 赠品、数据缺项、中断修正与假设保底 |
| [角色仿真对照](docs/CHARACTER_SCORE_SIMULATION.md) | 24 种抽法、12,288 条合成账本，查看总分、分段、分布和 New 调整 |
| [浏览器版说明](docs/BROWSER.md) | 本地计算、记录迁移与构建部署 |

## 功能

- 截图识别：从限定角色池长截图读取角色池、抽数、头像、加急出货、武库配额及武器汇总。
- TXT / JSON 导入：按内容识别已适配的导出格式，自动整理出货、加急、赠品与武器配置。
- 六维评分：角色六星、当期 UP、限定、角色五星、六星武器、当期专武。
- 记录修正：即时校验、手动补充记录、中断修正、首池信息、单池专武产出及溢出配置。
- 规划亏损：期望、机会和实际亏损，支持逐池查看、豁免和假设补到保底。
- 本机历史：保存、重开、批量删除、导出与恢复记录 JSON。
- 结果图片保留规划亏损与六维欧非的左右布局，可复制到剪贴板或保存为 PNG，也可加上本地设置的昵称水印。

目前常规限定池目录覆盖至“锻砧、行囊与蜜糖／小刻”。复刻、庆典及常驻角色池未纳入常规限定角色评分。

## 安装与启动

### Windows 便携版

下载 [Windows x64 便携版 v0.3.0](https://github.com/shixincro/endfield-gacha-rating/releases/download/v0.3.0/EndfieldGacha-Windows-x64-v0.3.0.zip)，完整解压后双击“启动抽卡工具.cmd”。包内已包含 Python、Node.js 和 OCR 模型，不需要另外安装。版本说明和校验文件见 [v0.3.0 Release](https://github.com/shixincro/endfield-gacha-rating/releases/tag/v0.3.0)。

首次启动会联网准备头像素材，之后可离线使用。若下载暂时失败，可先导入 TXT / JSON，联网后运行“下载头像素材.cmd”。停止后台服务请双击“停止抽卡工具.cmd”。

旧版用户先备份 `tools/gacha_rating_app/data/`；新包解压到新文件夹后，可把这个记录目录复制到相同位置。根目录 `data/` 是启动状态，无需迁移。

### 从源码运行

已验证环境为 Windows x64、Python 3.12、Node.js 24。其他系统可尝试命令行启动，但尚未完成相同程度的验收。不需要安装 npm 依赖。

1. 安装 [Python 3.12](https://www.python.org/downloads/) 和 [Node.js 24](https://nodejs.org/en/download)，确保终端能执行 `python` 和 `node`。
2. 下载此仓库 ZIP 并解压，或执行 `git clone https://github.com/shixincro/endfield-gacha-rating.git`。
3. 在仓库目录打开 PowerShell，执行：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r tools/gacha_ocr_prototype/requirements.txt
.\.venv\Scripts\python.exe scripts/download_assets.py
.\.venv\Scripts\python.exe scripts/check_environment.py
```

头像是游戏素材，仓库只保留下载地址和校验清单；下载步骤需要联网，使用时请遵守素材权利人的要求。OCR 模型随 Python 依赖安装。安装完成后，识图和评分无需联网。

双击 `启动抽卡工具.cmd`，或执行：

```powershell
.\.venv\Scripts\python.exe tools/gacha_rating_app/server.py --port 4320
```

浏览器打开 <http://127.0.0.1:4320/>。命令行启动时按 Ctrl+C 停止服务。

## 使用

1. 首页每次选择或拖入一个截图、TXT 或 JSON 文件，点击“开始导入”。截图请使用限定角色池长截图。
2. 用“限定池识别结果”修正角色信息，用“武器修正”填写武器配置。红色入口表示存在待处理矛盾，绿色表示记录自洽。
3. 截图外的记忆记录通过“手动补充记录”追加。截图中的“已垫”是原记录推算值，补充后会重新计算相连卡池的水位。
4. 在六维雷达图查看评分，悬停角色轴可看明细。用“设置昵称”添加水印，留空可清除。“复制图片”可直接粘贴，“保存图片”下载同一张 PNG，“保存记录JSON”用于备份和恢复记录。

记录丢失时，可在“限定池识别结果 → 中断修正”排除缺失卡池，并在恢复点补充六星图鉴与起始水位。补充六星只更新持有图鉴，不增加抽数或出货数；图鉴补齐后勾选“此处六星图鉴已补全”。补充水位只用于欧非，亏损估值仍按中断后的零水位计算。

首页和“本机历史记录”中的“导入 TXT / JSON”均可导入第三方记录或恢复本工具的备份。可以先导入 [`examples/demo-session.json`](examples/demo-session.json) 体验功能，它是人工构造的演示数据。复刻池和辉光庆典作为辅助记录保存，暂不参与评分；仅含这类池的文件也能保存。

目前适配批次 TXT、按时间戳分组的 JSON（裸对象或 `info/data` 包装）、`data.list` 接口导出、`internal_json_v3`（含 generator）、EndUID 分组 JSON，以及 Endfield Gacha（bhaoo）的本机记录和 WebDAV 单账号备份。扩展名不决定格式，例如正文是 JSON 的 TXT 也能读取。本工具的 `gacha-rating-session-v1` 单人记录与 `gacha-rating-collection-v1` 合集仍可恢复。

Endfield Gacha 用户可在原工具的数据目录中选择 `userData/gachaData/<账号键>.json`（Windows 的 `userData` 位于程序同目录），或选择 WebDAV 同步目录下 `accounts/<账号键>.json` 的单账号备份。两者都可使用上述任一导入入口。 [Endfield Gacha 数据目录](https://github.com/bhaoo/endfield-gacha#数据存储位置)

单份第三方文件最多 8 MB，含多账号时请分别导出。池起点和奖励位置可确认时，赠券、信物或武器赠品节点恰好缺 1 个序号、且未列出对应奖励，会按漏导赠品处理并保留推断依据；不增加实际抽数、抽出的六星或配额。其他缺口、未知出货和不明 UP 映射仍需核对。无原图记录的亏损详情会显示文字出货表。

### 数据保存

桌面版截图、裁片和记录保存在 `tools/gacha_rating_app/data/`，该目录已被 Git 忽略。备份本机记录时请连同该目录一起备份。浏览器版改为当前网站、当前浏览器的 IndexedDB 存储，清除网站数据会删除记录。两版可通过本工具导出的 JSON 交换账本；JSON 不内嵌原图，没有原图时详情显示文字记录。

桌面版 Python 服务只用于本机访问；在线使用应部署浏览器版生成的静态目录，不要把桌面版服务直接暴露到公网。浏览器版不提供账号或云同步。提交 Issue 时请使用演示记录或脱敏材料，避免附带玩家 UID、原始截图与私人记录。

### 识图适用范围

识图主要支持小黑盒单列截图。已适配一类宽屏布局，但居中、大面积留白、双列、遮挡和低清头像仍可能需要人工核对；识别到总抽数不代表六项评分所需信息都完整。

## 开发与检查

```powershell
.\.venv\Scripts\python.exe scripts/run_tests.py
.\.venv\Scripts\python.exe scripts/run_tests.py --ocr
```

第一条运行不需要头像素材的应用、算法和界面逻辑测试；第二条额外运行 OCR 测试，需要先下载头像。未附带的五星校准样本核验会明确跳过；OCR 测试有两项已标记的已知不足。GitHub Actions 运行基础回归。

目录结构：

```text
tools/gacha_rating_app/      本地服务、网页、账本校验、角色评分与规划
tools/gacha_ocr_prototype/   OCR、头像定位和匹配、素材清单
tools/character_abc_score/  角色六星、当期 UP 和限定评分
tools/character_five_score/ 五星评分与冻结校准参数
tools/weapon_score_v2/      武器 DP 与评分
browser/                    浏览器 Worker、IndexedDB、武器 JS、Python/OCR 桥
scripts/                    安装辅助、自检和测试入口
examples/                   合成演示记录
docs/                       算法说明
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。调整算法时，请同时说明参照模型、输入分母和验证方式。

维护者制作 Windows 便携版本见 [发布说明](docs/RELEASING.md)。
