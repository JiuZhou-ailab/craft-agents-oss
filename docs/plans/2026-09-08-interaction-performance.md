# Spec #29：交互性能实施与验收

对应 [Spec #29](https://github.com/JiuZhou-ailab/storyflow/issues/29)。基线为 `3fe4d3705f347f0e038a05a6fae0a9161a04928e`；优化结果来自同一 checkout 的本次变更构建。

## 已实施

| 项目 | 根因与最小改动 | 可观察结果 |
|---|---|---|
| 首片可见 | 删除词数/语言/等待时间门槛；顶层 pending assistant text 在最终分类前进入 provisional response，明确 intermediate 与子 agent 内容仍进入 activity | 已收到的短回复在 provider 暂停时也可读；保留后续 300ms 合并和结束刷新 |
| Markdown | ResponseCard 使用现有 MemoizedMarkdown，比较覆盖全部 props；context 仍由 React 传播 | 未改变展示文本时跳过 Markdown 内容渲染；新链接回调与显示属性生效 |
| 搜索直达 | Search Hit 的 source line/query/snippet 经保存门传至现有 editor 或 FileViewer；使用同一 Markdown parser 和 PM diff 验证 source→selection | 重复词定位对应命中，已有标签复用；干净文档重读、脏文档保留缓冲；变化/消失/不可见源码分别提示 |
| 发送前 I/O | flush 持久化队列后先读已有 header，明确无 plan 时返回；有 plan 或不可靠 header 进入原路径 | 30MiB 无 plan transcript 只读最多 8192 bytes，不读/解析正文、不写回 |
| 搜索取消 | 搜索专用 additive RPC；可信 client/workspace/request identity 隔离，生命周期 signal 停止两路 rg | 修改查询/关闭/换项目/断连终止旧工作；取消与 unavailable、零命中不同；旧宿主仅 CHANNEL_NOT_FOUND 降级 |

没有新增 Markdown 分块、全文索引、状态缓存或 runtime eviction。IPC 决策见 [ADR 0022](../adr/0022-workspace-search-cancellation.md)。

## 测量口径

- 同一 macOS 主机，48GiB RAM，Bun 1.3.14，Electron 39.2.7 / Chrome 142.0.7444.235。
- Standard generator：20 workspaces × 300 session files、最长 1000 messages、400 章节。旧 generator 会跨 workspace 重复生成部分 session ID，实际全局 runtime registry 不是完整 6000 个独立 session；前后使用相同 fixture，不把生成文件数量当作注册数量。新建的 50 个 Pi 会话使用真实唯一 ID。
- 真实 Electron + 既有 raw CDP。模型为本机确定性 SSE，Pi 进程和会话生命周期真实；无付费 provider、无外部 MCP 工具负载。
- 首片计时从 renderer 收到首个非空 delta 到 response DOM 出现内容，不含模型网络时间。每语言四次，共 20 次：中文、日文、短英文、混合文字、未闭合代码围栏；首片后 provider 暂停 800ms。
- 键入计时在 renderer 内采集 keydown→input+layout；另报下一 task 的 settle 时间。IME CDP 往返单独记录，不混入键入 P95。
- raw JSON 位于 `e2e/perf/results/`（既有 gitignore），包含日期、场景、commit、dirty 状态、Bun/Electron、构建 SHA-256；以下表格保留关键数据。baseline 早期报告未带构建 hash，其构建日志为 `/tmp/storyflow-spec29-build-before.log`，不能补称已记录 hash。

## 首片与长回复

基线真实构建：`interaction-1788840476031-before.json`，首片 n=20，P50 **763.8ms**、P95 **767.9ms**、max **778.1ms**。

最终真实构建报告 `interaction-1788843895069-after.json`：四个选定场景全部完成，`coveragePass=true`，退出码 0。首片 n=20，P50 **5.9ms**、P95 **6.6ms**、max **12.4ms**；P95 从基线减少约 **99.1%**。

| 1000-message 历史中的新回复 | 键入样本 | 键入 P50 / P95 / max | settle P95 | IME commit（含 CDP） |
|---|---:|---:|---:|---:|
| 2019 字符 | 34 | 1.1 / 1.4 / 2.0ms | 11.0ms | 1.8ms |
| 9771 字符 | 34 | 1.1 / 1.4 / 2.0ms | 9.6ms | 7.0ms |
| 29219 字符 | 34 | 1.1 / 1.3 / 2.3ms | 9.0ms | 2.1ms |

键入等待真实首 delta 后开始；约 120 个后续片段确保短/长内容都有持续流。30k case 额外断言 composition 前后仍在 processing 且新 delta 到达，并在滚动到历史消息后检查选择和 scrollTop 跨流更新不变。三个回复的落盘全文和可见最终尾标记均一致。长回复没有同构的旧构建 IME/选择时间基线，因此只报告本次预算达标，不声称这些数字是前后提升幅度。

构建标识：`main.cjs` SHA-256 `ca24880c30f15ed8a8cb9551d0b75eeb25a6bfe07e0f752a66e3fcfcd3c08844`；renderer `index.html`（引用内容哈希 bundle）SHA-256 `27eb7f62ab272b755f9fd990863f759db1ec606ac9f771e7a0d2fab94e9638b4`。

Markdown 浏览器 probe 的同一次挂载加 50 次相同 props 更新：原有未 memo 边界执行 51 次，memo 边界执行 1 次。真实 props 改变后累计 2 次；这是一组确定性渲染计数比较，不是旧构建的时间采样。Probe 同时检查不变 props、回调/显示属性改变、context 更新、格式结构相等、组件 streaming→terminal 刷新及完成回复批注。组件终止检查只证明展示层刷新；它不是 provider cancellation/error 事件的端到端证明。

## 搜索与持久化

- 基线导航只携带路径，源码行号没有进入 editor；本次真实 Electron 对 `.md`、`.txt`、`.log` 检查命中文字、重复词位置、可见滚动、键盘/鼠标、标签复用、同文件内容变化与删除命中。
- 保存门以真实只读文件触发写入失败，检查仍保留原编辑缓冲和标签；恢复写权限后再导航并检查磁盘内容。
- cancellation 在真实 WebSocket RPC 与受控 rg executable 边界验收：两个扫描 PID 实际退出；不同窗口/新 request 不受旧取消影响；换项目、断连清理；失败和 timeout 仍 unavailable。受控进程忽略 SIGTERM，覆盖 250ms SIGKILL fallback。
- 存储回归检查 30MiB 有界读取、队列中的 plan 与 user message、oversized header fallback，并复用 legacy data、pending-plan、idle transcript 和 send 生命周期测试。
- plan cleanup 为相同机器上的成对热缓存微测：基线等价调用 `queue.flush → loadSession`（旧实现的无 plan 分支），对照实际 `clearPendingPlanExecution`；每档预热 5 次、采样 30 次。此项不是旧 Electron 构建的 acknowledgement 测量。

| 无 plan 正文 | 原路径 P50 / P95 / max | 新路径 P50 / P95 / max |
|---|---:|---:|
| 2MiB | 0.441 / 0.858 / 0.872ms | 0.185 / 0.273 / 0.281ms |
| 10MiB | 1.747 / 2.082 / 2.192ms | 0.222 / 0.255 / 0.258ms |
| 30MiB | 4.964 / 5.747 / 5.776ms | 0.274 / 0.301 / 0.343ms |

微测时间为 2026-09-08T05:06:21Z，原始结果 `/tmp/storyflow-spec29-plan-results.json`。它验证读取成本随正文增长的差异，不承诺等量端到端发送收益。

## Runtime 驻留诊断

报告 `interaction-1788842834601-after.json`，52 次本地模型请求 = 50 个新会话 + 两次恢复。每阶段离开会话并显式释放 transcript working set，GC 后采样整个 Electron 后代进程树。

| 阶段 | 已释放 transcript | Pi 进程 | Renderer heap | 进程树 RSS | Pi 合计 RSS | 冷 transcript 读取 | 恢复到首个 delta |
|---|---:|---:|---:|---:|---:|---:|---:|
| 20 会话 | 20 | 20 | 58.8MB | 8011.2MiB | 7023.4MiB | 5.3ms | 2915.3ms |
| 50 会话 | 50 | 50 | 70.0MB | 8932.8MiB | 8194.7MiB | 6.8ms | 1424.7ms |

每阶段为一个稳定快照与一次恢复，不能当作 P95。恢复计时从实际 send 开始到首 delta，排除了导航固定等待及 provider 首片后的 800ms 暂停。它包含真实 Pi/会话准备、本机 HTTP；不是冷进程启动测量，因为现有 Pi 仍驻留。

Pi 数量继续增长，RSS 从 20 到 50 会话增加约 922MiB，单 Pi RSS 中位数反而从 309MiB 降至 122MiB。因此证据支持“transcript 释放不释放 runtime，驻留成本较高”，不支持“RSS 线性泄漏”。macOS RSS 不是去重后的物理 footprint，也不能表示 compressed memory。下一项高 ROI 工作应单独设计有界 idle-runtime 生命周期，先明确 active/tool/MCP/permission 状态不可驱逐、断开清理与恢复语义，再测物理 footprint 和新进程恢复成本。

## 既有预算与验证

基线通用 harness 报告 `2026-09-08T03-48-40-305Z.json`：启动 interactive 1107ms、writing catalog 1613ms；chapter open 470ms、全文搜索 323ms、键入 P95 1.1ms、app session switch P95 65.1ms、post-GC renderer heap 50.6MB。已有失败为 project click→catalog 459ms（100ms 预算），session switch 含 CDP 往返 P95 120.1ms（100ms 预算）。这些失败不因本次优化而视为通过。

最终通用 harness 第一轮报告 `2026-09-08T05-05-49-125Z.json`：interactive 1102ms、writing catalog 1578ms、chapter open 454ms、全文搜索 329ms、键入 P95 1.0ms、app switch P95 58ms、heap 50.2MB。仍失败：project click→catalog 419ms；switch 含 CDP P95 111ms；大型会话含 CDP P95 103ms（基线为 96ms，新增一次边界越线，不能称为已有通过）。第一轮 startup 的单次 max 3511ms 也保留，不能用中位数掩盖。

同配置第二轮报告 `2026-09-08T05-07-16-542Z.json`：interactive 1064ms、writing catalog 1567ms（max 3390ms）、project click→catalog 417ms（max 2274ms）、chapter open 481ms、搜索 357ms、键入 P95 1.09ms、app switch P95 45.5ms、含 CDP switch P95 107.1ms、大型会话含 CDP P95 97.1ms、heap 49.7MB。

两轮都保留，未放宽预算或丢弃首轮 103ms。应用内 switch 从基线 65.1ms 到 58/45.5ms；含 CDP 的大型会话在 100ms 边界两侧波动。当前证据未定位到本次实现引入的持续切换退化，但不能宣称通用基线全绿。项目目录展开的 417–419ms 中位数及约 2.3s 尾部等待仍是后续优化方向。

自动化验收：

- 完整执行主测试集合：542 files / 5482 tests，5470 pass、11 Windows/PowerShell skip、1 fail。唯一失败是新增 RPC 字符串在排序后的契约清单中放错顺序；修正后该文件 5/5 定向复验通过。按 implement 工作流不重复整套，仅复验失败面。
- 随后补完根脚本尚未执行的隔离阶段：HTTP server 34/34、19 个 isolated 文件 238/238 全通过，其中含实际双路进程退出、半路先完成及重复取消。
- 全集合合计 **5743 项已通过、11 项平台跳过**；没有遗留失败。该数字是全量遍历加修复后复验的合并结果，不表示原始 `bun run test` 命令曾以退出码 0 结束。
- 最终 `bun run typecheck:all`、i18n parity/sorted/coverage、`git diff --check` 通过。新 driver 的非法/重复/混合 runtime 场景拒绝，以及已采集首片/连续输入预算的断言均复核通过。
- 标准性能 harness 两轮退出码均为 1，失败指标如上；Spec #29 新增四场景验收与 20/50 runtime 诊断各自退出码 0。

日志保存在 `/tmp/storyflow-spec29-{full-test,ipc-final,http-final,isolated-final,type-final}.log`；i18n 共校验 1896 个英文 key 及各 locale parity。

## 复现

```bash
bun run electron:build
PERF_INTERACTIONS=first-text,long-stream,search-navigation,markdown bun run e2e/perf/search-stream-runtime.ts
PERF_INTERACTIONS=runtime bun run e2e/perf/search-stream-runtime.ts
PERF_SCENARIOS=startup,switch,memory-steady,heavy-writing,heavy-search,continuous-typing bun run perf:e2e
bun run typecheck:all
bun run test
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run lint:i18n:coverage
```

存储微测的复现方法：复用 `pending-plan-execution.test.ts` 的临时 `StoredSession`，分别保存一个 2/10/30MiB 的 assistant content；每档预热 5 次后，交替采样 30 次 `await sessionPersistenceQueue.flush(id); loadSession(root, id)` 和 `await clearPendingPlanExecution(root, id)`。按最近秩法计算 P50/P95/max，保持同一文件和热缓存；不把文件创建计入耗时。用于本次的完整脚本为 `/tmp/storyflow-plan-measure.ts`。

性能场景串行运行；不要同时启动多个 Electron benchmark 或其他 CPU 密集验收。新增 driver 对未知/重复场景和缺失结果 fail closed；`PERF_BASELINE=1` 只关闭优化后预算，不跳过数据采集。

## Standards

最终生产代码审查未留发现；QA 审查要求准确标注组件终止覆盖、证明 IME 与 delta 重叠，以及检查只读预览的真实 source offset，均已落实到 harness。

## Spec

最终生产代码审查未留发现：引用链接定位、FileViewer 同文件刷新、干净/脏 editor source 与保存失败时序均已复核。实测与未覆盖边界按以上口径披露，不把代码审查代替运行验收。

审查结论：Standards 0 项未解决，最高严重性无；Spec 0 项未解决的实现发现，最高严重性无。通用性能预算失败仍按上文保留。
