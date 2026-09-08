# Specs #30 / #31：Runtime 常驻与目录体验验收

基线 `2ab23a4d144433e1ae8d1d0888989a87558d6c3d`。对应 [#30](https://github.com/JiuZhou-ailab/storyflow/issues/30)、[#31](https://github.com/JiuZhou-ailab/storyflow/issues/31) 及 #32–#37。本次没有新增依赖、设置页、TTL、全文索引或目录缓存层。

## 实施与边界

- 修正 fixture 的全局 Session ID 去重范围。真实 Electron API 确认 20 × 300 = 6000 个独立 Session、每个 workspace 的 1000-message 历史和 400 章节；验证安排在计时后，避免预热目录。旧结果不能冒充完整规模的新基线。
- 沿用现有 runtime 创建入口、每 Session mutex 和操作 lease，保留最近使用的 3 个可回收 idle runtime。忙碌、排队、权限/认证交互、后台任务、native pending requests 和失效/删除状态均受保护；Host abort 不等于 Pi settled。
- flush 后确认 Pi 和 MCP 实际退出才清理引用。失败保留原对象与 cleanup 状态，禁止替代进程；真实工作结束可再次尝试，失败回收不会自己触发无限重试。连接级清理失败不封锁其他 Session。
- 目录读取错误不再伪装成部分成功。初次加载、磁盘变更、focus/visibility 刷新共用错误状态和重试；root 归属及 revision 拦截迟到错误。连续失败保留当前目录与 dirty editor。
- 原有 warm catalog 缓存已足够快，保留现有实现。拆编辑器包、预加载/同步加载文件树与 workspace/chat surface 等试验未获得足以支持保留的收益，均已撤回。

## Runtime 资源结果

macOS / 48GiB，Bun 1.3.14，Electron 39.2.7。每次运行使用完整 fixture，模型为本机确定性 SSE，无付费 provider。下表为三轮独立 Electron 进程，RSS 单位 MiB；Pi RSS 是子进程 RSS 相加，不是去重物理内存。

| 构建 / 轮次 | 20 会话 Pi 数 / Pi RSS | 50 会话 Pi 数 / Pi RSS | 50 会话进程树 RSS |
|---|---:|---:|---:|
| before 1 | 20 / 8547.45 | 50 / 7747.19 | 8453.06 |
| before 2 | 20 / 8008.83 | 50 / 6947.17 | 7658.89 |
| before 3 | 20 / 11580.28 | 50 / 7954.53 | 8753.73 |
| after 1 | 3 / 1733.69 | 3 / 1738.66 | 2849.64 |
| after 2 | 3 / 1735.27 | 3 / 1733.41 | 2882.80 |
| after 3 | 3 / 1737.11 | 3 / 1726.89 | 2677.27 |

50 会话阶段 Pi RSS 中位数从 7747.19 降至 1733.41 MiB，减少 **77.6%**；Pi 数均收敛到 3。部分运行与构建/测试重叠，RSS 受分页和机器负载影响明显，不能据此声称固定物理内存节省或线性泄漏。阶段在正常回复结束后等待 3 秒再采样。

原始证据（`e2e/perf/results/`，gitignored）依次为 `interaction-1788847094065-before.json`、`interaction-1788847876530-before.json`、`interaction-1788848149589-before.json`、`interaction-1788848741827-after.json`、`interaction-1788849223449-after.json`、`interaction-1788849493337-after.json`。JSON 保留构建 SHA-256、完整 PID/PPID/RSS、heap 和场景完成标识。

`footprint` 额外捕获运行中的 4 个 Pi，物理 footprint 合计 1,623,267,112 bytes（约 1.51GiB）；这是进行中快照，不能与上述 3 个 idle Pi 的 RSS 或旧版物理内存直接比较。工具没有报告 errors。另一个仅主进程的快照为约 327MiB，不能拿它代表整个应用。


同一 Electron 连续三轮（累计 150 个新会话）也已完成：

| 轮次 | 20 / 50 会话阶段 Pi 数 | 50 会话进程树 RSS MiB | renderer heap MB |
|---|---:|---:|---:|
| 1 | 3 / 3 | 2789.38 | 74.17 |
| 2 | 3 / 3 | 2729.97 | 76.73 |
| 3 | 3 / 3 | 2739.95 | 80.36 |

证据 `interaction-1788850219918-after.json`，`coveragePass=true`，模型调用 156 次（150 次初始发送 + 每轮 2 次恢复）。Pi 数未累积；Host 仍保留新增 Session 的元数据，所以 renderer heap 不是恒定值。

## 恢复成本与内容连续性

首轮 20 组配对测量：冷恢复从发送到首 delta 的 P50 / P95 为 **1545.1 / 1666.9ms**；同 Session 的干净进程重启为 **1536.2 / 1666.2ms**。P95 额外 0.7ms，通过 ≤max(250ms, 10%) 门槛。这不是 warm resume 的等待时间；旧版 warm 样本每阶段仅 1 次，未据此估计 warm P95。

最终含 native history 断言的另一组 20 对恢复：P50 / P95 为 **1959.2 / 2307.2ms**，配对干净重启为 **1931.8 / 2059.5ms**，P95 额外 **247.7ms**，仍在 250ms 门槛内但余量很小。该轮与持续驻留验收并行，不能忽略负载波动或只选首轮较好数字。证据 `interaction-1788850213772-after.json`，`nativeHistoryVerified=true`、`coveragePass=true`；92 次发送恰好对应 92 次模型调用，没有 replay。受控模型实际收到恢复前的 native assistant 内容。分支/compaction 的存储协议没有改写，复用已有恢复与 rewind 回归；此项并非对所有组合的额外 live 验证。

每次冷恢复要求恰好创建一个 Pi；干净重启仅终止本次 harness 创建的那个 Pi。协议和 lease 回归覆盖取消到 `agent_end` 再到 `agent_settled`、活动操作/发送 admission、失效并发、清理失败与重试。Pi/MCP 测试使用真实子进程，失败注入限于该子进程的 OS signal 边界。SDK 已发 SIGKILL 后仍无法确认退出时继续 fail closed；外部故障解除后重试确认原退出事件，不依赖 SDK 私有字段或重复发送业务请求。

## 目录结果与未完成项

完整同规模 baseline 为 `catalog-1788847264393.json`；最终错误恢复验收为 `catalog-1788849532579.json`。

| 口径 | before P50 / P95 | after P50 / P95 | 验收 |
|---|---:|---:|---|
| Session 点击激活 Project → 真实目录行，cold n=20 | 314.4 / 360.0ms | 335.2 / 403.0ms | **P50 未达 100ms；P95 低于 500ms** |
| 同路径 warm n=30 | 16.1 / 18.9ms | 15.4 / 23.1ms | 通过 |
| 旧 project-expansion click → catalog wall-time 中位数 | 532ms | 616ms | **仍未达原 100ms 预算** |

全部其他测试/本任务 runtime 基准结束后的独立复测 `catalog-1788850363739.json`：cold n=20，P50 / P95 **281.9 / 309.9ms**；warm n=30，**14.7 / 19.2ms**。本次启用真实预算 gate，因 cold 未达标以退出码 1 结束，JSON 同时保存 `cold.pass=false` 和 `warm.pass=true`。

仪表修正和产品提速分开报告，不能把新计时起点直接与旧 wall-time 比较。`PERF_BASELINE=1` 只允许收集失败数字，不代表预算通过。此次没有保留冷路径提速改动，也不声称 cold 提速。

真实 `fs.listFiles` 常见约 20–50ms，也观察到 100ms 以上尾部；profile 未建立足以支撑更大改动的单一主因。当前证据不足以判定冷启动及 heap 没有超过 10% 的可重复退化；需隔离机器负载后补成对数据。**#36 保持未验收，#31 不能标为全部完成。** 下一步应细分 Project 激活、Session metadata hydration 与 render commit 的等待，再确定是否值得改变关键路径。

目录 QA 已实际执行：首次无文件标签、无章节正文读取；400 章节真实可见；A/B 项目重复切换；打开章节后 chmod 0、focus 刷新报错、再次重试仍报错、恢复权限重试成功。两次错误后编辑器 DOM 身份和未保存 marker 均不变。文件 RPC、目录范围/授权、rename/delete/relink 与已有保存门回归由相关测试及全量套件覆盖；未把静态复核冒充每项 Electron 交互验证。

## 验证与复现

- `bun run typecheck:all` 通过。
- i18n parity、sorted、coverage 通过。
- 根 `bun run test` 完整执行一次，合计 **5753 pass、11 skip、0 fail**；随后定向 43 个回归通过。
- 最终 `first-text,long-stream`：首片 n=20，P50 / P95 / max = **6.8 / 8.1 / 10.0ms**；1000-message 历史、2k/10k/30k 回复下键入 P95 = **1.9 / 1.5 / 1.6ms**，30k 还验证 IME 与流重叠及历史选择/滚动保持。证据 `interaction-1788849842716-after.json`。
- 复现命令、fixture 所有权、失败预算模式及参数见 [perf runbook](../../e2e/perf/README.md#runtime-residency-and-catalog-follow-up)。真实 provider、额外外部 MCP 负载和生产发布不在此次运行范围。

## Standards

最终静态审查无新增规范或正确性发现。失败回收自旋、focus 刷新遗漏、跨 Project 错误覆盖均已修复；未保留无测量收益的试验代码。

## Spec

最终增量审查无新增代码问题。生命周期与编辑内容风险已修复；冷目录 P50 仍未达标，保持 #36 开放，不宣布 #31 完成。

两轴各 0 个未解决代码发现；Spec 仍有上述性能验收缺口。


## #36 后续：冷目录请求消除（基线 f4edcaa6e）

本轮仅优化目录首次打开的已测请求路径，未更改 runtime 常驻或执行并发。新增 RPC trace 先定位：标准 fixture 初始列表加载后发出 300 次 `sessions:getPermissionModeState`；输入框预加载又发出 280 次 `workspace:readImage`。核对 image path 后确认后者来自缺失的 Skill 图标，不是状态图标；最初的“合并相同在途图标读取”试验没有降低请求数或延迟，已撤回。

保留两处改动：

- `sessions:get` 在 Host 内复用已有权限校准函数，将模式及可选版本随列表返回。初始化不再逐会话往返；旧 Host 缺版本时沿用原 RPC。初始列表只保留本次加载期间收到的更新权限事件，不能拿上一 Host 的高版本拒绝新快照。重连校准路径未改。
- `loadSkillIcon` 复用 Host catalog 的 `iconPath` 判定，删除缺失图标的重复发现；保留已知文件、emoji、URL 与现有读取授权。`SkillAvatar` 本就使用这一目录事实源。没有新增缓存、索引、依赖或并发限额。

诊断证据：`catalog-1788851472810.json`（before trace，取 cold sample 边界前）、`catalog-1788852206492.json`（after trace）；首次权限状态 RPC **300 → 0**，缺失 Skill 图片请求 **280 → 0**。trace/profile 均不用于最终耗时验收。真实 `sessions:get` 仍返回 300 条元数据，目录仍返回 406 个节点，未删数据换速度。

最终耗时使用关闭 trace/profile 的独立 Electron 运行，完整 fixture 为 6000 Session、每 workspace 1000-message 历史、400 章节。基线为 `catalog-1788851440228.json`；最终构建为 `catalog-1788852734316.json`。

| 指标 | 本轮 before | 最终 after | 结果 |
|---|---:|---:|---|
| cold，n=20，P50 / P95 | 267.85 / 289.42ms | 192.75 / 209.98ms | P50 改善约 28%，仍高于 100ms |
| warm，n=30，P50 / P95 | 11.40 / 17.44ms | 9.80 / 18.13ms | 通过 |
| 原 project-expansion → catalog wall-time 中位数 | 502.5ms | 408.0ms | 仍高于原 100ms 预算 |
| renderer surface committed 中位数，n=20 | 269.0ms | 211.0ms | 本轮未观测到启动退化 |
| 首次目录后 GC heap | 34.07MB | 34.49MB | +1.3%，单次 heap 快照 |

前一轮优化后复测也完整保留：`catalog-1788852446493.json`，cold 174.80 / 218.50ms、warm 10.50 / 19.98ms、surface 267.5ms、heap 33.97MB；该构建尚未补最终初始权限事件竞态保护。最终数字取最终构建，不选前一轮更好的 P50。上述数据是本机顺序对照，不代表所有机器；warm P95 的微小波动不能当作可重复退化。

最终以正常预算 gate 执行，因 cold P50 未达标返回退出码 1，JSON 留存 `cold.pass=false`、`warm.pass=true`。目录重试 QA 两轮都通过：首次零文件标签、零章节读取，30 次跨 Project 往返，真实目录读取失败与重复失败，恢复权限后的重试成功，未保存正文及同一 editor DOM 均保留。

剩余等待仍包括会话激活、renderer 提交和目录 RPC；trace 同时显示 ActivityRail 为折叠 Project 发起大量 Session 列表请求。下一步应隔离验证这批后台元数据工作对前台目录的影响，保留跨 Project 置顶会话语义，不直接删除必要条目或下调执行并发。**#36 和 #31 仍未全部验收。**


本轮最终交互证据 `interaction-1788852890519-after.json`：首片 n=20，P50 / P95 / max = **6.7 / 7.2 / 10.5ms**；1000-message 历史下，2k / 10k / 30k 长回复期间键入 P95 均为 **1.4ms**。30k 场景验证 IME 与流重叠、历史选择/滚动保持以及最终持久化和显示文本。模型使用本机确定性 SSE，无付费请求。

本轮 Standards / Spec 双轴最终代码复核均无未解决发现。审查发现的初始权限事件覆盖风险已用行为测试修复；批量刷新跨 Host 代际的试验已撤回，重连原实现不变。Spec 的冷打开与 legacy 100ms 预算仍未满足，与代码审查结论分别记录。

本轮 `bun run typecheck:all` 通过；最终根 `bun run test` 完整执行一次，合计 **5759 pass、11 skip、0 fail**。新增公共边界回归覆盖缺失/后来新增 Skill 图标、列表权限快照、本次加载的新权限事件、Host 版本回退及无关 thinking 更新。代码与失效的文件头、perf runbook 已同步，未改变顶层模块边界。
