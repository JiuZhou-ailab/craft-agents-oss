// input: --seed/--scale/--out CLI flags; @craft-agent/shared session types + jsonl readers (validation only)
// output: A complete CRAFT_CONFIG_DIR-compatible synthetic data root at ~/.craft-agent-perf-fixture
// pos: Deterministic standard-fixture generator for all perf baselines (see CONTEXT.md "Standard fixture")

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SessionHeader, StoredMessage, SessionTokenUsage } from "@craft-agent/shared/sessions";
import { readSessionHeader, readSessionJsonl, ADJECTIVES, NOUNS } from "@craft-agent/shared/sessions";

// ============================================================
// Constants (fixed base time — NEVER Date.now(), for byte-identical output)
// ============================================================

/** 2026-06-01T00:00:00Z — all fixture timestamps derive from this. */
const BASE_TIME = 1780272000000;
const MARKER_FILE = ".perf-fixture";

// Target scale at --scale 1.0 (from CONTEXT.md "Standard fixture")
const TARGET_WORKSPACES = 20;
const TARGET_SESSIONS_PER_WS = 300;
const LONG_SESSION_MESSAGES = 1000;
const LONG_SESSION_TOOL_SHARE = 0.3;
const TARGET_NOVEL_CHAPTERS = 400;
/** Real-data distribution: lognormal around median 26 messages. */
const SESSION_COUNT_MEDIAN = 26;
const SESSION_COUNT_SIGMA = 1.1;

// ============================================================
// Seeded PRNG (mulberry32) + helpers
// ============================================================

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Standard normal via Box-Muller. */
function randNormal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function randChars(rng: Rng, alphabet: string, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

/** uuid-like id matching the real config.json format (8-4-4-4-12 hex). */
function uuidLike(rng: Rng): string {
  return [8, 4, 4, 4, 12].map((n) => randChars(rng, HEX, n)).join("-");
}

// ============================================================
// Synthetic text (lorem-like Chinese/English mix — never real user content)
// ============================================================

const ZH_FRAGMENTS = [
  "山间的雾气在清晨渐渐散开，", "河水沿着旧渠道缓慢流动，", "她把窗台上的盆栽向左挪了一寸，",
  "巷口的灯在黄昏时分先亮了起来，", "他翻开笔记本查看昨天的记录，", "远处的钟声敲了三下，",
  "石板路被雨水冲刷得发亮，", "工坊里堆着尚未完成的木料，", "老人把伞靠在门边慢慢坐下，",
  "风从谷口吹进来带着潮气，", "地图边缘的标注已经模糊不清，", "码头上的货箱排成两列，",
  "她数了数抽屉里剩下的信纸，", "屋檐下的燕子窝空了一个冬天，", "他把茶壶从炉上取下来，",
  "集市在第七日恢复了往常的喧闹，", "灯芯烧到一半忽明忽暗，", "旧书页间夹着一枚干枯的叶子，",
  "列车在隧道前减速鸣笛，", "斜坡上的草垛盖着防雨布，",
];
const ZH_ENDINGS = [
  "一切照旧。", "没有人注意到这个细节。", "答案要等到明天才揭晓。", "这让整件事有了新的转机。",
  "时间还早。", "他决定再等一等。", "记录就到这里为止。", "剩下的交给运气。",
];
const EN_FRAGMENTS = [
  "the index rebuild finished without warnings", "cache hit ratio stayed above ninety percent",
  "the draft needs one more pass", "latency dropped after the batch change",
  "results are grouped by chapter id", "the outline maps cleanly to sections",
];

/** Synthesize mixed Chinese/English prose of roughly targetLen chars. */
function synthText(rng: Rng, targetLen: number): string {
  let out = "";
  while (out.length < targetLen) {
    if (rng() < 0.15) {
      out += `（${pick(rng, EN_FRAGMENTS)}）`;
    } else {
      out += pick(rng, ZH_FRAGMENTS);
    }
    if (rng() < 0.3) out += pick(rng, ZH_ENDINGS);
    if (rng() < 0.2 && out.length < targetLen) out += "\n\n";
  }
  return out.slice(0, targetLen);
}

/** Short user-prompt-like text. */
function synthUserText(rng: Rng): string {
  const prompts = [
    "继续写下一章", "把大纲第三节展开", "检查一下人物设定是否冲突", "帮我总结当前进度",
    "换一个开头钩子", "这段节奏太慢，压缩一半", "列出未解决的伏笔", "把结尾改得更克制一些",
  ];
  const base = pick(rng, prompts);
  return rng() < 0.25 ? base + "，" + synthText(rng, randInt(rng, 30, 200)) : base;
}

// ============================================================
// Session ID generation (format: YYMMDD-adjective-noun, per slug-generator.ts)
// ============================================================

function datePrefix(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear().toString().slice(-2);
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

function generateSessionId(rng: Rng, ts: number, existing: Set<string>): string {
  const prefix = datePrefix(ts);
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = `${prefix}-${pick(rng, ADJECTIVES)}-${pick(rng, NOUNS)}`;
    if (!existing.has(base)) {
      existing.add(base);
      return base;
    }
    for (let suffix = 2; suffix <= 99; suffix++) {
      const id = `${base}-${suffix}`;
      if (!existing.has(id)) {
        existing.add(id);
        return id;
      }
    }
  }
  const fallback = `${prefix}-${pick(rng, ADJECTIVES)}-${pick(rng, NOUNS)}-${randChars(rng, HEX, 4)}`;
  existing.add(fallback);
  return fallback;
}

// ============================================================
// Message synthesis (shapes sampled from real session.jsonl data)
// ============================================================

const TOOL_POOL: Array<{ name: string; displayName: string; weight: number }> = [
  { name: "Read", displayName: "Read", weight: 35 },
  { name: "Edit", displayName: "Edit", weight: 15 },
  { name: "Write", displayName: "Write", weight: 15 },
  { name: "Bash", displayName: "Terminal", weight: 10 },
  { name: "mcp__wangwen-bigdata__query_sql", displayName: "query_sql", weight: 15 },
  { name: "WebSearch", displayName: "WebSearch", weight: 4 },
  { name: "WebFetch", displayName: "WebFetch", weight: 4 },
  { name: "Ls", displayName: "Ls", weight: 2 },
];
const TOOL_WEIGHT_TOTAL = TOOL_POOL.reduce((s, t) => s + t.weight, 0);

function pickTool(rng: Rng) {
  let r = rng() * TOOL_WEIGHT_TOTAL;
  for (const t of TOOL_POOL) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return TOOL_POOL[0]!;
}

function msgId(rng: Rng, ts: number): string {
  return `msg-${ts}-${randChars(rng, ALNUM, 6)}`;
}

function makeUserMessage(rng: Rng, ts: number): StoredMessage {
  // Real user messages carry attachments: null (observed in production data)
  return {
    id: msgId(rng, ts),
    content: synthUserText(rng),
    timestamp: ts,
    attachments: null as unknown as undefined,
    type: "user",
  };
}

function makeAssistantMessage(rng: Rng, ts: number, opts: { intermediate: boolean; turnId: string }): StoredMessage {
  const len = opts.intermediate ? randInt(rng, 20, 150) : randInt(rng, 100, 1800);
  const m: StoredMessage = {
    id: msgId(rng, ts),
    content: synthText(rng, len),
    timestamp: ts,
    type: "assistant",
  };
  if (opts.intermediate) {
    m.isIntermediate = true;
    m.turnId = opts.turnId;
  } else {
    m.canBranch = true;
  }
  return m;
}

function makeToolMessage(rng: Rng, ts: number, turnId: string, wsPortableRoot: string): StoredMessage {
  const tool = pickTool(rng);
  let toolInput: Record<string, unknown>;
  let toolResult: string;
  switch (tool.name) {
    case "Read":
      toolInput = { file_path: `${wsPortableRoot}/正文/第${String(randInt(rng, 1, 99)).padStart(2, "0")}章.md` };
      toolResult = synthText(rng, randInt(rng, 300, 3000));
      break;
    case "Edit":
      toolInput = { edits: [{ oldText: synthText(rng, randInt(rng, 50, 300)), newText: synthText(rng, randInt(rng, 50, 300)) }] };
      toolResult = "Successfully replaced 1 block(s).";
      break;
    case "Write":
      toolInput = { content: synthText(rng, randInt(rng, 500, 2500)) };
      toolResult = `Successfully wrote ${randInt(rng, 1000, 8000)} bytes.`;
      break;
    case "Bash":
      toolInput = { command: `wc -l ${wsPortableRoot}/正文/*.md | tail -1` };
      toolResult = `${randInt(rng, 100, 9999)} total`;
      break;
    case "mcp__wangwen-bigdata__query_sql":
      toolInput = { sql: "SELECT title, score FROM lg_rank ORDER BY score DESC LIMIT 20" };
      toolResult = synthText(rng, randInt(rng, 200, 1500));
      break;
    default:
      toolInput = { query: synthText(rng, randInt(rng, 10, 40)) };
      toolResult = synthText(rng, randInt(rng, 200, 1200));
  }
  return {
    id: msgId(rng, ts),
    content: `Running ${tool.displayName}...`,
    timestamp: ts,
    toolName: tool.name,
    toolUseId: `call_00_${randChars(rng, ALNUM, 20)}`,
    toolInput,
    toolStatus: "completed",
    toolIntent: synthText(rng, randInt(rng, 10, 30)),
    toolDisplayName: synthText(rng, randInt(rng, 6, 14)),
    toolDisplayMeta: { displayName: tool.displayName, category: "native" },
    turnId,
    toolResult,
    isError: false,
    type: "tool",
  };
}

// ============================================================
// Session synthesis
// ============================================================

interface SessionSpec {
  id: string;
  messageCount: number;
  toolShare: number;
  createdAt: number;
}

interface BuiltSession {
  header: SessionHeader;
  messages: StoredMessage[];
}

/**
 * Emit messages in turn structure (user → tools → final assistant) with
 * exact per-role budgets so tool share hits the requested ratio.
 */
function buildSession(rng: Rng, spec: SessionSpec, wsPortableRoot: string, model: string): BuiltSession {
  const n = spec.messageCount;
  const nTool = Math.round(n * spec.toolShare);
  const nUser = Math.max(1, Math.round(n * 0.18));
  const nAssistant = Math.max(1, n - nTool - nUser);

  const budgets = { user: nUser, tool: nTool, assistant: nAssistant };
  const messages: StoredMessage[] = [];
  let ts = spec.createdAt;
  let turn = 0;

  const tick = () => { ts += randInt(rng, 2_000, 120_000); return ts; };

  while (budgets.user + budgets.tool + budgets.assistant > 0) {
    turn++;
    const turnId = `pi-turn-${turn}`;
    if (budgets.user > 0) {
      messages.push(makeUserMessage(rng, tick()));
      budgets.user--;
    }
    // Tools per turn scale with the remaining tool budget across remaining turns
    const remainingTurns = Math.max(1, budgets.user + 1);
    const toolsThisTurn = Math.min(budgets.tool, Math.ceil(budgets.tool / remainingTurns));
    for (let i = 0; i < toolsThisTurn; i++) {
      if (budgets.assistant > 1 && rng() < 0.3) {
        messages.push(makeAssistantMessage(rng, tick(), { intermediate: true, turnId }));
        budgets.assistant--;
      }
      messages.push(makeToolMessage(rng, tick(), turnId, wsPortableRoot));
      budgets.tool--;
    }
    if (budgets.assistant > 0) {
      messages.push(makeAssistantMessage(rng, tick(), { intermediate: false, turnId }));
      budgets.assistant--;
    }
  }

  // Header pre-computed fields (mirror createSessionHeader in jsonl.ts)
  const firstUser = messages.find((m) => m.type === "user");
  const preview = firstUser?.content?.replace(/\s+/g, " ").trim().substring(0, 150) || undefined;
  const last = messages[messages.length - 1];
  const lastMessageRole = (["user", "assistant", "plan", "tool", "error"] as const).find((r) => r === last?.type);
  let lastFinalMessageId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "assistant" && !m.isIntermediate) { lastFinalMessageId = m.id; break; }
  }
  const totalChars = messages.reduce((s, m) => s + (m.content?.length ?? 0) + (m.toolResult?.length ?? 0), 0);
  const outputTokens = Math.round(totalChars / 3);
  const inputTokens = outputTokens * randInt(rng, 3, 8);
  const tokenUsage: SessionTokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contextTokens: 0,
    costUsd: 0,
    cacheReadTokens: Math.round(inputTokens * 0.8),
    cacheCreationTokens: 0,
  };

  const header: SessionHeader = {
    id: spec.id,
    workspaceRootPath: wsPortableRoot,
    sdkSessionId: uuidLike(rng),
    sdkCwd: wsPortableRoot,
    createdAt: spec.createdAt,
    lastUsedAt: ts + randInt(rng, 1_000, 60_000),
    lastMessageAt: ts,
    name: synthText(rng, randInt(rng, 6, 20)),
    isFlagged: rng() < 0.05,
    sessionStatus: pick(rng, ["todo", "todo", "todo", "in-progress", "needs-review", "done"]),
    permissionMode: pick(rng, ["safe", "ask", "allow-all"]),
    workingDirectory: wsPortableRoot,
    model,
    llmConnection: "perf-fixture-connection",
    connectionLocked: true,
    messageCount: messages.length,
    lastMessageRole,
    preview,
    tokenUsage,
    lastFinalMessageId,
  };

  return { header, messages };
}

// ============================================================
// Workspace + novel content
// ============================================================

function writeJson(path: string, value: unknown): number {
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(path, text);
  return Buffer.byteLength(text);
}

function buildNovelContent(rng: Rng, wsRoot: string, chapters: number): number {
  let bytes = 0;
  const globalDir = join(wsRoot, "全局");
  const proseDir = join(wsRoot, "正文");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(proseDir, { recursive: true });

  const globals: Array<[string, string]> = [
    ["创作要求.md", `# 创作要求\n\n${synthText(rng, 600)}\n`],
    ["简报.md", `# 简报\n\n${synthText(rng, 800)}\n`],
    ["大纲.md", `# 大纲\n\n${Array.from({ length: 40 }, (_, i) => `## 第${i + 1}卷\n\n${synthText(rng, 200)}`).join("\n\n")}\n`],
    ["人物.md", `# 人物\n\n${synthText(rng, 1200)}\n`],
  ];
  for (const [name, content] of globals) {
    writeFileSync(join(globalDir, name), content);
    bytes += Buffer.byteLength(content);
  }

  for (let i = 1; i <= chapters; i++) {
    const num = String(i).padStart(3, "0");
    const paragraphs = Array.from({ length: randInt(rng, 10, 18) }, () => synthText(rng, randInt(rng, 120, 260)));
    const content = `# 第${num}章\n\n${paragraphs.join("\n\n")}\n`;
    writeFileSync(join(proseDir, `第${num}章.md`), content);
    bytes += Buffer.byteLength(content);
  }
  return bytes;
}

const DEFAULT_STATUSES = {
  version: 1,
  statuses: [
    { id: "backlog", label: "Backlog", category: "open", isFixed: false, isDefault: true, order: 0 },
    { id: "todo", label: "Todo", category: "open", isFixed: true, isDefault: false, order: 1 },
    { id: "in-progress", label: "In Progress", category: "open", isFixed: false, isDefault: true, order: 2 },
    { id: "needs-review", label: "Needs Review", category: "open", isFixed: false, isDefault: true, order: 3 },
    { id: "done", label: "Done", category: "closed", isFixed: true, isDefault: false, order: 4 },
    { id: "cancelled", label: "Cancelled", category: "closed", isFixed: true, isDefault: false, order: 5 },
  ],
};

// ============================================================
// Main
// ============================================================

function toPortable(absolutePath: string): string {
  const home = homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(home + "/")) return "~" + absolutePath.slice(home.length);
  return absolutePath;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string", default: "42" },
      scale: { type: "string", default: "1" },
      out: { type: "string", default: join(homedir(), ".craft-agent-perf-fixture") },
    },
  });
  const seed = Number.parseInt(values.seed!, 10);
  const scale = Number.parseFloat(values.scale!);
  const outDir = expandTilde(values.out!);
  if (!Number.isFinite(seed) || !Number.isFinite(scale) || scale <= 0) {
    console.error("Invalid --seed or --scale");
    process.exit(1);
  }

  // Safety: only wipe a dir we created (marker file present) or one that is missing/empty
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (entries.length > 0 && !entries.includes(MARKER_FILE)) {
      console.error(`Refusing to delete ${outDir}: no ${MARKER_FILE} marker found (may contain real data).`);
      process.exit(1);
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const started = performance.now();
  const rng = mulberry32(seed);

  const nWorkspaces = Math.max(1, Math.round(TARGET_WORKSPACES * scale));
  const nSessionsPerWs = Math.max(2, Math.round(TARGET_SESSIONS_PER_WS * scale));
  const nChapters = Math.max(5, Math.round(TARGET_NOVEL_CHAPTERS * scale));

  let totalBytes = 0;
  let totalSessions = 0;
  let totalMessages = 0;
  let chaptersWritten = 0;

  // Marker first so a partially-generated dir is still recognized as ours
  const markerText = JSON.stringify({ generator: "scripts/perf/generate-fixture.ts", seed, scale, baseTime: BASE_TIME }, null, 2) + "\n";
  writeFileSync(join(outDir, MARKER_FILE), markerText);
  totalBytes += Buffer.byteLength(markerText);

  const workspacesDir = join(outDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });

  const configWorkspaces: Array<{
    rootPath: string;
    name: string;
    slug: string;
    id: string;
    createdAt: number;
  }> = [];
  const wsNamePool = ["长篇小说", "短篇练习", "世界观设定", "资料整理", "番外集", "修订稿", "投稿准备", "读者反馈", "灵感碎片", "连载主线"];

  const existingIds = new Set<string>();
  for (let w = 0; w < nWorkspaces; w++) {
    const isNovelWs = w === 0;
    const slug = isNovelWs ? "perf-novel" : `perf-ws-${String(w + 1).padStart(2, "0")}`;
    const wsRoot = join(workspacesDir, slug);
    const wsPortableRoot = toPortable(wsRoot);
    const wsCreatedAt = BASE_TIME - randInt(rng, 30, 180) * 86_400_000;
    const wsName = isNovelWs ? "400章长篇小说" : `${pick(rng, wsNamePool)} ${String(w + 1).padStart(2, "0")}`;
    const stateDir = join(wsRoot, ".craft-agent");
    mkdirSync(join(stateDir, "sessions"), { recursive: true });
    mkdirSync(join(stateDir, "statuses"), { recursive: true });
    mkdirSync(join(stateDir, "labels"), { recursive: true });

    configWorkspaces.push({
      rootPath: wsPortableRoot,
      name: wsName,
      slug,
      id: uuidLike(rng),
      createdAt: wsCreatedAt,
    });

    // Workspace-level config.json (format observed in real workspaces)
    totalBytes += writeJson(join(stateDir, "config.json"), {
      id: `ws_${randChars(rng, HEX, 8)}`,
      name: wsName,
      slug,
      defaults: {
        permissionMode: "safe",
        cyclablePermissionModes: ["safe", "allow-all"],
        enabledSourceSlugs: [],
        workingDirectory: wsPortableRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: wsCreatedAt,
      updatedAt: wsCreatedAt,
    });
    totalBytes += writeJson(join(stateDir, "statuses", "config.json"), DEFAULT_STATUSES);
    totalBytes += writeJson(join(stateDir, "labels", "config.json"), { version: 1, labels: [] });

    if (isNovelWs) {
      // Writing manifest (schema per packages/shared/src/writing/manifest.ts)
      totalBytes += writeJson(join(stateDir, "craft-writing.json"), {
        schemaVersion: 1,
        type: "novel",
        title: wsName,
      });
      totalBytes += buildNovelContent(rng, wsRoot, nChapters);
      chaptersWritten = nChapters;
    }

    // Sessions: 1 designated long session + (n-1) following real-data distribution
    const model = pick(rng, ["gpt-5.5", "gemini-3.5-flash", "deepseek-v4-pro"]);
    for (let s = 0; s < nSessionsPerWs; s++) {
      const isLong = s === 0;
      const createdAt = BASE_TIME - randInt(rng, 0, 150) * 86_400_000 - randInt(rng, 0, 86_400_000);
      const messageCount = isLong
        ? LONG_SESSION_MESSAGES
        : Math.min(280, Math.max(1, Math.round(Math.exp(Math.log(SESSION_COUNT_MEDIAN) + SESSION_COUNT_SIGMA * randNormal(rng)))));
      const toolShare = isLong ? LONG_SESSION_TOOL_SHARE : rng() * 0.45;
      const id = generateSessionId(rng, createdAt, existingIds);
      const built = buildSession(rng, { id, messageCount, toolShare, createdAt }, wsPortableRoot, model);

      const sessionDir = join(stateDir, "sessions", id);
      mkdirSync(sessionDir, { recursive: true });
      const lines = [JSON.stringify(built.header), ...built.messages.map((m) => JSON.stringify(m))];
      const content = lines.join("\n") + "\n";
      writeFileSync(join(sessionDir, "session.jsonl"), content);
      totalBytes += Buffer.byteLength(content);
      totalSessions++;
      totalMessages += built.messages.length;
    }
  }

  // Global config.json (workspaces array format replicated from real ~/.craft-agent/config.json;
  // setup is explicitly deferred so the offline fixture never opens onboarding)
  totalBytes += writeJson(join(outDir, "config.json"), {
    workspaces: configWorkspaces,
    activeWorkspaceId: configWorkspaces[0]!.id,
    activeSessionId: null,
    llmConnections: [],
    setupDeferred: true,
  });

  const elapsedSec = (performance.now() - started) / 1000;

  // ------------------------------------------------------------
  // Validation: re-read a sample session through the app's own readers
  // ------------------------------------------------------------
  const firstWsRoot = join(workspacesDir, configWorkspaces[0]!.slug);
  const sessionsRoot = join(firstWsRoot, ".craft-agent", "sessions");
  const sampleIds = readdirSync(sessionsRoot).sort().slice(0, 3);
  let validationPass = true;
  for (const sid of sampleIds) {
    const file = join(sessionsRoot, sid, "session.jsonl");
    const header = readSessionHeader(file);
    const session = readSessionJsonl(file);
    const ok = !!header && !!session && header.id === sid && session.messages.length === header.messageCount;
    if (!ok) validationPass = false;
    console.log(`validate ${sid}: header=${header ? "ok" : "FAIL"} messages=${session?.messages.length ?? "FAIL"}/${header?.messageCount ?? "?"} → ${ok ? "PASS" : "FAIL"}`);
  }

  // ------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------
  const fmt = (n: number) => n.toLocaleString("en-US");
  console.log("\n=== perf fixture summary ===");
  console.log(`out dir     : ${outDir}`);
  console.log(`seed / scale: ${seed} / ${scale}`);
  console.log(`workspaces  : ${fmt(nWorkspaces)}`);
  console.log(`sessions    : ${fmt(totalSessions)}`);
  console.log(`messages    : ${fmt(totalMessages)}`);
  console.log(`chapters    : ${fmt(chaptersWritten)}`);
  console.log(`total bytes : ${fmt(totalBytes)} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`elapsed     : ${elapsedSec.toFixed(2)} s`);
  console.log(`validation  : ${validationPass ? "PASS" : "FAIL"}`);
  if (!validationPass) process.exit(1);
}

main();
