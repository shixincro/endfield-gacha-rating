# 终末地抽卡评分工具

在本机识别小黑盒抽卡截图，核对记录，并计算六维欧非与规划亏损。网页、识图和评分均在本机运行。

维护者：[shixincro](https://github.com/shixincro)。原创代码使用 [MIT 许可证](LICENSE)。游戏素材与第三方依赖遵循各自的许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 功能

- 截图识别：角色池、抽数、头像、加急出货、武库配额及武器汇总；批量图片逐人独立保存。
- 六维评分：角色六星、当期 UP、限定、角色五星、六星武器、当期专武。
- 记录修正：即时校验、手动补充记录、中断修正、首池信息、武器潜能及溢出配置。
- 规划亏损：逐池详情、单项豁免、假设补到保底并重新评分。
- 本机历史：保存、重开、批量删除、导出与恢复记录 JSON。
- 保存结果：将规划亏损与六维图按左右并排布局复制到剪贴板。

目前常规限定池目录覆盖至“烟火邀星河／明河”。复刻、庆典及常驻角色池未纳入常规限定角色评分。

## 安装与启动

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

1. 选择小黑盒截图并点击“开始识别”。头像模糊、缺失卡池或矛盾数据会提示核对。
2. 用“限定池识别结果”修正角色信息，用“武器修正”填写武器配置。红色入口表示存在待处理矛盾，绿色表示记录自洽。
3. 截图外的记忆记录通过“手动补充记录”追加。截图中的“已垫”是原记录推算值，补充后会重新计算相连卡池的水位。
4. 点击六维区域揭晓评分，使用“保存结果”复制结果图，或“保存记录 JSON”备份完整记录。

可以先导入 [`examples/demo-session.json`](examples/demo-session.json) 体验功能。它是人工构造的演示数据，不对应真实玩家。

“导入记录 JSON”支持本工具的 `gacha-rating-session-v1` 单人记录及 `gacha-rating-collection-v1` 合集。第三方抽卡导出的 JSON 结构各不相同，当前网页不提供通用自动转换。

### 数据保存

截图、裁片和记录保存在 `tools/gacha_rating_app/data/`，该目录已被 Git 忽略。备份本机记录时请连同该目录一起备份。导出的 JSON 含识别数据及修正信息，原图使用本机引用，不会自动内嵌原图。

本项目的服务只用于本机访问，未设计账号系统或公网部署功能。提交 Issue 时请使用演示记录或脱敏材料，避免附带玩家 UID、原始截图与私人记录。

## 算法与局限

见 [算法说明](docs/ALGORITHMS.md)。角色六星、UP 等模块使用确定性 DP；五星和武器的最终分数含近似或校准步骤。各轴使用指定参照模型，不等于真实玩家排名，也不保证所有停手策略均分 50。

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
tools/character_five_score/ 五星评分与冻结校准参数
tools/weapon_score_v2/      武器 DP 与评分
scripts/                    安装辅助、自检和测试入口
examples/                   合成演示记录
docs/                       算法说明
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。调整算法时，请同时说明参照模型、输入分母和验证方式。
