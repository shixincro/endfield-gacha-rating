# 导入、账本与评分范围

[算法总览](ALGORITHMS.md) · [角色欧非](CHARACTER_SCORING.md) · [武器欧非](WEAPON_SCORING.md) · [规划亏损](PLANNING_LOSS.md) · **导入与账本** · [角色仿真对照](CHARACTER_SCORE_SIMULATION.md)

## 从原始记录到账本

应用可从支持的小黑盒截图读取出货，也可导入批次 TXT/JSON、`data.list` 接口导出、`internal_json_v3`、EndUID 分组 JSON 和 Endfield Gacha（bhaoo）JSON。内部统一使用 `gacha-ledger-v1` 账本。`gacha-rating-session-v1` 备份还包含来源和评分设置，可在应用里恢复。

Endfield Gacha 的 `userData/gachaData/<账号键>.json` 本机记录和 WebDAV 同步目录下 `accounts/<账号键>.json` 单账号备份都可通过首页或「本机历史记录 → 导入 TXT / JSON」读取。角色记录按行内池 ID 整理。重构、辉光庆典、基础和启程角色池作为辅助记录保留。`isFree: true` 的角色加急单列，`kind` 以 `gift` 开头的赠品单列，两者均不计入主池抽数。 [上游本机记录](https://github.com/bhaoo/endfield-gacha/blob/master/src-tauri/src/lib.rs#L631-L699) · [上游 WebDAV 结构](https://github.com/bhaoo/endfield-gacha/blob/master/src-tauri/src/webdav.rs#L101-L138)

原始条目、截图证据和人工修正分别保留。导入器按来源格式解释稀有度、加急和赠品。位置、角色身份和前后水位冲突时，应用会要求核对。手动补充记录可更新相连卡池的派生水位，截图中的「已垫」只是原记录推算值。

池起点和主抽位置明确、且此前无未解释缺口时，如果固定奖励节点恰好缺一条序号，且没有对应奖励条目，会标记为可能漏导的奖励。角色池第 60 抽是下期赠券，240 的整数倍是信物。武器池从第 100 抽起每 80 抽交替发放武库箱与专武直赠。此推断单独记录，原抽数、随机出货、配额和已有奖励保持各自口径。其他缺口需要核对。 [文件导入器](../tools/gacha_rating_app/record_import.py) · [账本校验](../tools/gacha_rating_app/importer.py)

| 字段 | 含义 |
| --- | --- |
| `character.pools` | 按池序号递增的常规限定池列表 |
| `pool.index / banner / up` | 目录序号、池名和当期 UP，当前序号 0–13 |
| `pool.total` | 本池主抽数，包含免费主抽。加急单列 |
| `pool.events[].at` | 本池从 1 开始的累计出货位置 |
| `pool.events[].character` | 主池出货角色，`source` 为 `main` |
| `pool.initialPity / tail` | 期初、期末连续未出六星数。未知使用 `null` |
| `pool.rushUsed / rushAt / rush` | 是否使用加急、使用时的主池进度、加急六星明细 |
| `pool.tokens` | 信物节点，`at` 为 240 的整数倍 |
| `pool.quota` | 与主池及已用加急范围一致的配额产出 |
| `character.initialOwned` | 首池前已持有的六星角色。`null` 表示未知，空列表表示确认无持有 |
| `character.completeHistory` | 是否确认导入范围内的历史连续 |
| `weapon.potentialConfig` | `totalTypes`、1–5 潜的 `counts`、`overflowCopies` 与分配给各满潜武器的 `overflowByType` |
| `weapon.lossDraws` | 可选的武器亏损抽数，用于当期专武轴的分母 |

## 中断修正

`character.interruptionCorrection` 标记不计入角色评分的卡池。恢复点按用户选定的免费额度重新开始，武器记录单独处理。`resumeInfo` 以恢复点卡池序号为键，可补充 `ownedSixStars` 以及 `initialPity`，并用 `catalogComplete` 说明此处图鉴是否已确认完整。

补角色只更新持有图鉴，既有出货仍按原始记录统计。图鉴未确认完整时，只能确认所列角色已拥有。补水位可设 0–79，默认 0，供角色欧非和假设保底位置使用。规划亏损在恢复点按零水位单独计算。取消修正后按原记录重新核对。 [中断修正实现](../tools/gacha_rating_app/history_interruption.py)

## 假设补到保底

假设方案独立保存为 `scoringScenario`，可追加到最后一个记录池的首 UP 保障或下一次必出六星。启用后，评分及期望、机会亏损使用派生记录，实际亏损仍使用真实记录。关闭后恢复真实记录的对照结果。 [假设补抽实现](../tools/gacha_rating_app/hypothesis.py)

评分结果会给出各轴的 `score`、`status` 和 `details` 或 `reason`。缺项的 `score` 是 `null`。诊断时应同时查看 `scoredAxes`、缺项原因、有效抽数和兼容分支，避免仅凭雷达图形状判断。 [评分入口](../tools/gacha_rating_app/service.py)
