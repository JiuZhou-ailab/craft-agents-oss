# perf e2e harness

Local-only Electron performance measurement (ADR-0001). Launches the built app against a fixture data dir and fail-closed checks writing-project startup, session-switch / memory diagnostics, heavy interaction, continuous typing, and document open/close leak scenarios. Never runs in CI.

Uses **raw CDP** (bun native WebSocket via `cdp.ts`), not Playwright — Playwright cannot complete a CDP handshake with Electron 39 / Chrome 142.

- `cdp.ts` — flat-session CDP client
- `launch.ts` — launch/teardown + heap GC + perf-log capture
- `navigation.ts` — ActivityRail project discovery + deterministic fixture selection
- `navigation.test.tsx` — rendered ActivityRail ↔ perf navigation contract
- `contract.ts` — strict scenario/config parsing and fail-closed baseline decision
- `contract.test.ts` — regression coverage for invalid or incomplete runs
- `run.ts` — scenario driver + pass/fail report
- `search-stream-runtime.ts` — Spec #29 的真实 Electron 首片/长回复/搜索定位及离线 Pi 20/50 会话诊断
- `markdown-probe.tsx` — 浏览器内 Markdown memo、回调与语义等价检查
- `results/` — timestamped JSON reports (gitignored)

CI interaction proxies: `apps/electron/src/renderer/__tests__/interaction-perf-contracts.test.ts`
(included by root `bun test` via `*.test.ts` discovery).

## Run

```bash
# from repo root
bun run perf:fixture
cd apps/electron && bun run build   # once, if dist/ is stale
bun run perf:e2e                    # all scenarios

# diagnostics
PERF_SCENARIOS=continuous-typing,memory-leak-docs bun run perf:e2e
PERF_SCENARIOS=heavy-writing,heavy-search bun run perf:e2e
PERF_SCENARIOS=startup,switch,memory-steady,memory-leak bun run perf:e2e
```

Env knobs:

| Env | Default | Meaning |
|---|---|---|
| `PERF_FIXTURE` | `~/.craft-agent-perf-fixture` | Data root |
| `PERF_SCENARIOS` | all | csv of scenarios |
| `PERF_STARTUP_RUNS` | 3 | Startup samples |
| `PERF_SWITCHES` | 40 | Session switch samples |
| `PERF_LEAK_LOOPS` | 100 | Session-switch leak loops |
| `PERF_DOC_LOOPS` | 40 | Document open/close leak loops |
| `PERF_DOC_CHAPTERS` | 60 | Distinct chapters per pass (needs `2 ×` that many chapters in the fixture) |

Scenarios: `startup`, `switch`, `memory-steady`, `memory-leak`, `memory-leak-docs`, `heavy-writing`, `heavy-search`, `continuous-typing`.

`memory-leak-docs` runs two passes over **disjoint** chapter ranges (warm `[1, N]`, measured `[N+1, 2N]`). The warm pass still excludes one-time bounded-cache setup, but because the measured pass only visits chapters never opened before, per-chapter retention that appears on first touch can still fail the baseline. Two identical passes could not.

`continuous-typing` types with real CDP `Input.dispatchKeyEvent` and samples the window from capture-phase `keydown` to the end of the bubble-phase `input` handler (plus a forced layout read). For a contenteditable composer the text is inserted at `beforeinput`/`input`, so a window that closes at the end of `keydown` misses React's synchronous commit entirely and reports ~0ms. The composer restores persisted drafts, so the scenario focuses it with a real mouse click (a bare `.focus()` gets handed back to a toolbar button) and clears it before sampling. It fails closed if any keystroke is dropped, if the composer is not empty at the start, or if the resulting text does not match what was typed. A `settleP95` diagnostic additionally samples one macrotask later for commit follow-on work; it is reported, not judged.

`switch` alternates large and small transcripts (`buildSwitchRing`) and reports large-session wall-clock as its own metric. The fixture holds one 1000-message session per workspace against a ~28-message median, so an arbitrary id ring reports a size-blind P95.

Percentiles are linearly interpolated. Nearest-rank makes P95 identical to `max()` for any n ≤ 20, which turned one scheduling hiccup into a failed baseline (the same build measured 84ms and 169ms). Notes also carry `max=` so a genuine tail outlier stays visible instead of silently deciding the verdict.

`heavy-search` awaits the debounced ripgrep-backed workspace content pass via `[data-global-search-state]`, not just the first rendered row — the first row is only the in-memory catalog/session-meta filter. It fails if the search engine ends `unavailable`/`error` or returns zero rows.

The generated fixture marks setup as deferred, and the harness sets `CRAFT_CLIENT_AUTH_REQUIRED=false`, so offline baselines are not blocked by onboarding or the desktop login gate.

An explicit `PERF_SCENARIOS` value is diagnostic mode (selected baselines only).

## Navigation contracts

- **Startup**: ActivityRail → 400-chapter writing fixture → metadata-only catalog, with zero file tabs and zero content reads
- **Heavy-writing / memory-leak-docs**: metadata-only writing catalog → explicitly selected chapter → Tiptap
- **Switch / memory / continuous-typing**: ActivityRail → non-writing fixture → sessions + chat input
- **Heavy-search**: writing fixture → activity-search → results

## Spec #29 interactions and runtime residency

After rebuilding Electron, run `bun run e2e/perf/search-stream-runtime.ts`.
`PERF_INTERACTIONS` accepts a comma-separated subset of `first-text,long-stream,search-navigation,markdown,runtime` and rejects unknown/duplicate names. Run `runtime` alone so its residency stages are exactly 20/50 sessions.
The default runs the first four; `PERF_RUNTIME=1` runs only the bounded 20/50 real Pi session diagnostic. The model is a local deterministic SSE server; no paid provider is used. Runtime diagnostics report the complete descendant process tree, not only renderer heap, and explicitly release idle transcript caches before measuring resume.

`PERF_BASELINE=1` records pre-change behavior without enforcing optimized targets. Build the intended revision before each measurement. JSON evidence is written to `results/interaction-*.json`, including failed runs; only complete, corresponding scenario sets are comparable. First-text samples start at renderer receipt of a nonblank delta and end at DOM body visibility; model network time is excluded. Long-stream input waits for a real delta; the 30k case verifies that IME overlaps incoming deltas, preserves historical selection/scroll, and checks final persisted and displayed text. Search navigation also exercises a real read-only-file save failure and retry. The Markdown probe runs after measurements via Vite in the same Electron renderer, with a fixture-owned dependency cache. [Measured results](../../docs/plans/2026-09-08-interaction-performance.md).
