import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";

import {
  inferDeliveryHintFromSessionKey,
  normalizeDeliveryHintForSessionKey,
  extractAssistantOutputTextFromCodexJsonlEntry,
  extractTaskCompleteTextFromCodexJsonlEntry,
} from "./lib.js";

type PluginConfig = {
  /** Override delivery mode (outbound|log|file). */
  deliveryMode?: string;
  /** When deliveryMode=file, append deliveries here. */
  deliveryFile?: string;
  /** Override CODEX_HOME for the spawned Codex process. */
  codexHome?: string;
  /** Default working directory when a chat hasn't pinned one yet. */
  defaultCwd?: string;
  /** Canonical config dir used to absolutize relative `agents.*.config_file` entries. */
  sharedConfigDir?: string;
  /** Force absolute `agents.*.config_file` overrides at launch for deterministic subagent loading. */
  forceAbsoluteAgentConfig?: boolean;
  /** Override path to the codex binary. */
  codexBin?: string;
  /** If true, keep the PTY session running after sends. */
  keepPty?: boolean;
};

type ResolvedPluginConfig = {
  deliveryMode: "outbound" | "log" | "file";
  deliveryFile: string;
  codexHome: string;
  defaultCwd?: string;
  sharedConfigDir?: string;
  forceAbsoluteAgentConfig: boolean;
  codexBin?: string;
  keepPty: boolean;
};

const DEFAULT_CODEX_HOME = path.resolve(homedir(), ".cache", "askcodex-codex-home");

let pluginApi: any = null;
let pluginCfg: ResolvedPluginConfig | null = null;

let pluginLogger: any = null;
function logInfo(msg: string, meta?: Record<string, unknown>) {
  try {
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    pluginLogger?.info?.(`[askcodex] ${msg}${suffix}`);
  } catch {
    // ignore
  }
}
function logWarn(msg: string, meta?: Record<string, unknown>) {
  try {
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    pluginLogger?.warn?.(`[askcodex] ${msg}${suffix}`);
  } catch {
    // ignore
  }
}

function resolveBool(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function resolveDeliveryMode(raw: unknown): ResolvedPluginConfig["deliveryMode"] {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "log") return "log";
  if (v === "file") return "file";
  return "outbound";
}

function resolveCodexHome(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      return trimmed.startsWith("~/")
        ? path.resolve(homedir(), trimmed.slice(2))
        : path.resolve(trimmed);
    }
  }
  return DEFAULT_CODEX_HOME;
}

function resolveOptionalPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("~/")
    ? path.resolve(homedir(), trimmed.slice(2))
    : path.resolve(trimmed);
}

function resolvePluginConfig(api: any): ResolvedPluginConfig {
  const raw = (api?.pluginConfig ?? {}) as PluginConfig;

  const deliveryMode = resolveDeliveryMode(raw.deliveryMode);
  const deliveryFile =
    (typeof raw.deliveryFile === "string" && raw.deliveryFile.trim())
      ? raw.deliveryFile.trim()
      : "/tmp/askcodex-delivery.log";

  const codexHome = resolveCodexHome(raw.codexHome);
  const defaultCwd = resolveOptionalPath(raw.defaultCwd);
  const sharedConfigDir = resolveOptionalPath(raw.sharedConfigDir);
  const forceAbsoluteAgentConfig = resolveBool(raw.forceAbsoluteAgentConfig) ?? true;

  const codexBin =
    (typeof raw.codexBin === "string" && raw.codexBin.trim()) ? raw.codexBin.trim() : undefined;

  const keepPty = typeof raw.keepPty === "boolean" ? raw.keepPty : false;

  return {
    deliveryMode,
    deliveryFile,
    codexHome,
    defaultCwd,
    sharedConfigDir,
    forceAbsoluteAgentConfig,
    codexBin,
    keepPty,
  };
}

function getPluginCfg(): ResolvedPluginConfig {
  return pluginCfg ?? resolvePluginConfig({ pluginConfig: {} });
}

type AskcodexAction =
  | "help"
  | "new"
  | "send"
  | "status"
  | "stop"
  | "handoff"
  | "resume"
  | "reset";

const AskcodexToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      description: "Action: help|new|send|status|stop|handoff|resume|reset",
    },
    cwd: {
      type: "string",
      description: "Absolute path for action=new (optional).",
    },
    message: {
      type: "string",
      description: "Prompt/message to send to Codex (for action=send).",
    },
  },
};

const REMOVED_ASKCODEX_COMMANDS = new Set([
  "start",
  "slash",
  "kill",
  "list",
  "ensure",
  "info",
]);

const REMOVED_ASKCODEX_ACTIONS = new Set(["start", "slash", "kill", "list", "ensure"]);

function renderAskcodexHelpText(): string {
  return [
    "askcodex",
    "",
    "Codex CLI in a per-chat PTY session (no RPC, no tmux).",
    "",
    "Commands:",
    "- /askcodex help",
    "- /askcodex status",
    "- /askcodex new [abs path]",
    "- /askcodex <prompt>",
    "- /askcodex stop",
    "- /askcodex reset",
    "- /askcodex handoff",
    "- /askcodex resume",
    "",
    "Notes:",
    "- /askcodex new archives any previous session and starts fresh.",
    "- /askcodex reset keeps the same Codex session id when available, and restarts runtime state.",
  ].join("\n");
}

export function parseAskcodexRawCommand(rawCommand: string):
  | { action: "help" | "status" | "new" | "stop" | "handoff" | "resume" | "reset" }
  | { action: "new"; cwd: string }
  | { action: "send"; message: string }
  | { error: string } {
  const trimmed = rawCommand.trim();
  if (!trimmed) return { action: "help" };

  const firstSpace = trimmed.search(/\s/);
  const verb = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();

  if (REMOVED_ASKCODEX_COMMANDS.has(verb)) {
    return { error: `Unknown /askcodex command: ${verb}. Run /askcodex help.` };
  }

  if (verb === "help" && !rest) return { action: "help" };
  if (verb === "status" && !rest) return { action: "status" };
  if (verb === "stop" && !rest) return { action: "stop" };
  if (verb === "handoff" && !rest) return { action: "handoff" };
  if (verb === "resume" && !rest) return { action: "resume" };
  if (verb === "reset" && !rest) return { action: "reset" };
  if (verb === "new") {
    if (!rest) return { action: "new" };
    if (rest.startsWith("/")) return { action: "new", cwd: rest };
  }

  return { action: "send", message: trimmed };
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text", text }],
    ...(details !== undefined ? { details } : {}),
  };
}

function safePreview(text: string, max = 160): string {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function truncateForPromptLog(text: string, maxChars = 1800): string {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}… (truncated; ${trimmed.length} chars total)`;
}

const ASKCODEX_OPERATIONAL_GUARD_HEADER = "[askcodex operational safety]";
const ASKCODEX_OPERATIONAL_GUARD_BLOCK = [
  ASKCODEX_OPERATIONAL_GUARD_HEADER,
  "Do not stop, restart, or kill the OpenClaw gateway process/service from this session.",
  "Do not execute commands that terminate `openclaw-gateway`.",
  "If gateway cleanup is requested, inspect and report commands for the user to run externally, but do not execute them here.",
  "[/askcodex operational safety]",
  "",
].join("\n");

function applyOperationalGuardToPrompt(message: string, action: AskcodexAction): string {
  const trimmed = String(message ?? "").trim();
  if (!trimmed) return "";
  if (action !== "send") return trimmed;
  if (trimmed.includes(ASKCODEX_OPERATIONAL_GUARD_HEADER)) return trimmed;
  return `${ASKCODEX_OPERATIONAL_GUARD_BLOCK}${trimmed}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

function resolveClawdbotDistDir(): string {
  // Prefer the current working directory if it looks like a clawdbot repo/install.
  // This is important in dev mode where process.argv may only contain relative paths.
  const cwd = process.cwd();
  const cwdDist = path.join(cwd, "dist");
  if (
    existsSync(path.join(cwdDist, "entry.js")) ||
    existsSync(path.join(cwdDist, "entry.mjs"))
  ) {
    return cwdDist;
  }

  // Fallback: infer from argv.
  const argv = Array.isArray(process.argv) ? process.argv.filter((v) => typeof v === "string") : [];

  const distEntry = argv.find(
    (arg) =>
      arg.includes(`${path.sep}dist${path.sep}`) &&
      (arg.endsWith(`${path.sep}entry.js`) || arg.endsWith(`${path.sep}entry.mjs`)),
  );
  if (distEntry) return path.resolve(path.dirname(distEntry));

  // Support tsx-style relative invocation: "src/entry.ts".
  const srcEntry = argv.find(
    (arg) =>
      (arg.endsWith(`${path.sep}src${path.sep}entry.ts`) || arg.endsWith(`src${path.sep}entry.ts`)) &&
      !arg.includes(`${path.sep}node_modules${path.sep}`),
  );
  if (srcEntry) {
    // Prefer sibling dist/ next to src/
    const resolved = path.isAbsolute(srcEntry) ? srcEntry : path.resolve(cwd, srcEntry);
    const root = path.dirname(path.dirname(resolved));
    const dist = path.join(root, "dist");
    if (existsSync(dist)) return dist;
  }

  // Last resort: system install.
  return "/usr/lib/node_modules/clawdbot/dist";
}

function inferAgentIdFromSessionKey(sessionKey: string): string | null {
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m?.[1] ?? null;
}

function parseOptionalInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return undefined;
    if (!/^\d+$/.test(t)) return undefined;
    const n = Number.parseInt(t, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

async function deliverBestEffortOutboundText(params: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  text: string;
}) {
  // Dev scaffold: allow fast local iteration without hitting Discord/Telegram.
  // Modes:
  // - outbound (default): send via gateway runtime outbound sender
  // - log: only log what would be sent
  // - file: append payload to a file
  const cfg = getPluginCfg();
  const mode = cfg.deliveryMode;

  if (mode === "log") {
    logInfo("deliver (log)", {
      channel: params.channel,
      to: params.to,
      threadId: params.threadId ?? null,
      textPreview: safePreview(params.text, 500),
    });
    return;
  }

  if (mode === "file") {
    const file = cfg.deliveryFile;
    const line = JSON.stringify(
      {
        ts: new Date().toISOString(),
        channel: params.channel,
        to: params.to,
        threadId: params.threadId ?? null,
        text: params.text,
      },
      null,
      0,
    );
    await fs.appendFile(file, line + "\n", "utf8").catch(() => undefined);
    logInfo("deliver (file)", { file, bytes: params.text.length });
    return;
  }

  const runtime = pluginApi?.runtime;
  if (!runtime) {
    throw new Error("askcodex: plugin runtime not available (not registered?)");
  }

  // Keep this intentionally narrow: only the channels we currently support.
  if (params.channel === "discord") {
    await runtime.channel.discord.sendMessageDiscord(params.to, params.text, {
      accountId: params.accountId,
    });
    return;
  }

  if (params.channel === "telegram") {
    const messageThreadId = parseOptionalInt(params.threadId ?? undefined);
    await runtime.channel.telegram.sendMessageTelegram(params.to, params.text, {
      accountId: params.accountId,
      ...(typeof messageThreadId === "number" ? { messageThreadId } : {}),
    });
    return;
  }

  if (params.channel === "slack") {
    const threadTs = typeof params.threadId === "string" ? params.threadId.trim() : "";
    await runtime.channel.slack.sendMessageSlack(params.to, params.text, {
      accountId: params.accountId,
      ...(threadTs ? { threadTs } : {}),
    });
    return;
  }

  throw new Error(`askcodex: unsupported delivery channel: ${params.channel}`);
}

function resolveAgentRootDirFromAgentDir(agentDir?: string): string | null {
  const raw = typeof agentDir === "string" ? agentDir.trim() : "";
  if (!raw) return null;
  return path.dirname(raw);
}

function resolveAgentRootDirFromAgentId(agentId?: string): string | null {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return null;
  const root = path.join(homedir(), ".clawdbot", "agents", id);
  return existsSync(root) ? root : null;
}

function resolveAskcodexDir(agentRootDir: string): string {
  return path.join(agentRootDir, "askcodex");
}

function resolveAskcodexArchiveDir(agentRootDir: string): string {
  return path.join(resolveAskcodexDir(agentRootDir), "archive");
}

function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function resolveRecordPath(agentRootDir: string, sessionKey: string): string {
  return path.join(resolveAskcodexDir(agentRootDir), `${shortHash(sessionKey)}.json`);
}

async function archiveAskcodexRecord(params: {
  agentRootDir: string;
  sessionKey: string;
  record: AskcodexRecordV1;
  reason: "new";
}): Promise<string> {
  const archiveDir = resolveAskcodexArchiveDir(params.agentRootDir);
  await fs.mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(
    archiveDir,
    `${shortHash(params.sessionKey)}-${stamp}-${params.reason}.json`,
  );
  await writeJsonAtomic(archivePath, {
    archivedAt: Date.now(),
    sessionKey: params.sessionKey,
    reason: params.reason,
    record: params.record,
  });
  return archivePath;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

async function withRecordLock<T>(recordPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${recordPath}.lock`;
  const timeoutMs = 15_000;
  const staleMs = 5 * 60_000;
  const start = Date.now();

  await fs.mkdir(path.dirname(recordPath), { recursive: true });

  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx");
      try {
        await fh.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now(), recordPath }, null, 2) + "\n",
          "utf8",
        );
      } catch {
        // ignore
      }
      try {
        return await fn();
      } finally {
        await fh.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/EEXIST/i.test(message)) {
        throw err;
      }
      const st = await fs.stat(lockPath).catch(() => null);
      const age = st ? Date.now() - st.mtimeMs : 0;
      if (st && age > staleMs) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`askcodex: timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function writeJsonAtomicLocked(filePath: string, value: unknown) {
  await withRecordLock(filePath, () => writeJsonAtomic(filePath, value));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

type DeliveryHint = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  messageThreadId?: string | number;
  isForum?: boolean;
};

type AskcodexRecordV1 = {
  version: 1;
  sessionKey: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  codex: {
    cwd?: string;
    sessionId?: string;
    sessionFile?: string;
    lastJsonlOffset?: number;
  };
  pending?: {
    turnId: string;
    mode: "jsonl" | "screen";
    sentAt: number;
    jsonlOffset?: number;
    quietMs?: number;
    deliveryKey?: string;
    retryCount?: number;
    lastAttemptAt?: number;
    nextAttemptAt?: number;
  };
  lastDelivered?: {
    turnId: string;
    deliveryKey: string;
    deliveredAt: number;
  };
  delivery?: DeliveryHint;
  lastError?: string;
};

function nowMs() {
  return Date.now();
}

// ANSI/control stripping (more aggressive than Node's stripVTControlCharacters).
// We want stable, readable text for chat delivery.
const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const APC_REGEX = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI sequences can include private/intermediate bytes like '?', '>', '<' etc.
const CSI_REGEX = /\x1b\[[0-9;?<>]*[A-Za-z]/g;
const ESC_SINGLE_REGEX = /\x1b[@-_]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

function stripAnsi(text: string): string {
  let out = String(text ?? "");
  if (out.includes("\u001b")) {
    out = out.replace(OSC_REGEX, "");
    out = out.replace(APC_REGEX, "");
    out = out.replace(DCS_REGEX, "");
    out = out.replace(CSI_REGEX, "");
    out = out.replace(ESC_SINGLE_REGEX, "");
  }
  if (out.includes("\t")) out = out.replace(/\t/g, "   ");
  if (out.includes("\r")) out = out.replace(/\r/g, "");
  // stripVTControlCharacters catches some sequences, but we still remove lingering control bytes.
  out = stripVTControlCharacters(out);
  out = out.replace(CONTROL_REGEX, "");
  return out;
}

function buildTailFromText(text: string, opts: { lines: number; maxChars: number }): { tail: string; truncated: boolean } {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // drop trailing empty line
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(0, lines.length - opts.lines);
  let out = lines.slice(start).join("\n");
  let truncated = start > 0;
  if (out.length > opts.maxChars) {
    out = out.slice(-opts.maxChars);
    truncated = true;
  }
  return { tail: out, truncated };
}

const RECOVERY_INTERVAL_MS = 10_000;
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_STALL_MS = 90_000;
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 90_000;
const DELIVERY_RETRY_JITTER_RATIO = 0.2;

type AskcodexPendingTurn = NonNullable<AskcodexRecordV1["pending"]>;

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function computePendingDeliveryKey(sessionKey: string, turnId: string): string {
  return `${shortHash(normalizeSessionKey(sessionKey))}:${turnId}`;
}

function normalizePendingTurn(
  sessionKey: string,
  pending: AskcodexRecordV1["pending"],
  fallbackQuietMs: number,
): AskcodexPendingTurn | undefined {
  if (!pending) return undefined;
  const turnId = typeof pending.turnId === "string" ? pending.turnId.trim() : "";
  if (!turnId) return undefined;
  const mode = pending.mode === "screen" ? "screen" : "jsonl";
  const sentAt = toNonNegativeInt(pending.sentAt) ?? nowMs();
  const jsonlOffset = toNonNegativeInt(pending.jsonlOffset);
  const quietMs = clampInt(pending.quietMs, fallbackQuietMs, 1000, 30000);
  const retryCount = toNonNegativeInt(pending.retryCount) ?? 0;
  const lastAttemptAt = toNonNegativeInt(pending.lastAttemptAt);
  const nextAttemptAt = toNonNegativeInt(pending.nextAttemptAt);
  const deliveryKey =
    typeof pending.deliveryKey === "string" && pending.deliveryKey.trim()
      ? pending.deliveryKey.trim()
      : computePendingDeliveryKey(sessionKey, turnId);

  return {
    turnId,
    mode,
    sentAt,
    ...(jsonlOffset !== undefined ? { jsonlOffset } : {}),
    quietMs,
    deliveryKey,
    retryCount,
    ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
  };
}

function computeRetryDelayMs(retryCount: number, randomValue = Math.random()): number {
  const normalizedRetryCount = Math.max(0, Math.trunc(retryCount));
  const exp = Math.min(8, normalizedRetryCount);
  const raw = Math.min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS * Math.pow(2, exp));
  const normalizedRandom = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0;
  const jitter = Math.floor(raw * DELIVERY_RETRY_JITTER_RATIO * normalizedRandom);
  return Math.max(250, raw + jitter);
}

function schedulePendingRetry(pending: AskcodexPendingTurn, now: number): AskcodexPendingTurn {
  const currentRetryCount = Math.max(0, pending.retryCount ?? 0);
  const delayMs = computeRetryDelayMs(currentRetryCount);
  const nextRetryCount = currentRetryCount + 1;
  return {
    ...pending,
    retryCount: nextRetryCount,
    lastAttemptAt: now,
    nextAttemptAt: now + delayMs,
  };
}

function isPendingAlreadyDelivered(record: AskcodexRecordV1, pending: AskcodexPendingTurn): boolean {
  const delivered = record.lastDelivered;
  if (!delivered) return false;
  if (delivered.deliveryKey && delivered.deliveryKey === pending.deliveryKey) return true;
  return delivered.turnId === pending.turnId;
}

function computePendingAttemptDelayMs(
  pending: AskcodexPendingTurn,
  now: number,
  fallbackQuietMs: number,
): number {
  if (typeof pending.nextAttemptAt === "number" && pending.nextAttemptAt > now) {
    return Math.max(100, pending.nextAttemptAt - now);
  }
  const quietMs = clampInt(pending.quietMs, fallbackQuietMs, 1000, 30000);
  const dueAt = pending.sentAt + quietMs;
  return Math.max(100, dueAt - now);
}

function resolveAgentRootDirsFromConfig(config: any): Array<{ agentId: string; rootDir: string }> {
  const entries = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const resolved = new Map<string, string>();
  for (const entry of entries) {
    const agentId = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!agentId) continue;
    const rootDir =
      resolveAgentRootDirFromAgentDir(entry?.agentDir) ??
      resolveAgentRootDirFromAgentId(agentId);
    if (rootDir) resolved.set(agentId, rootDir);
  }
  if (!resolved.has("main")) {
    const fallback = resolveAgentRootDirFromAgentId("main");
    if (fallback) resolved.set("main", fallback);
  }
  return Array.from(resolved.entries()).map(([agentId, rootDir]) => ({ agentId, rootDir }));
}

async function listAskcodexRecordPaths(agentRootDir: string): Promise<string[]> {
  const dir = resolveAskcodexDir(agentRootDir);
  if (!existsSync(dir)) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function recoverPendingRecord(recordPath: string): Promise<boolean> {
  return await withRecordLock(recordPath, async () => {
    const record = await readJsonFile<AskcodexRecordV1>(recordPath);
    if (!record || record.version !== 1) return false;
    const pending = normalizePendingTurn(record.sessionKey, record.pending, 5000);
    if (!pending) return false;
    const now = nowMs();
    if (isPendingAlreadyDelivered(record, pending)) {
      record.pending = undefined;
      record.lastError = undefined;
      record.updatedAt = now;
      await writeJsonAtomic(recordPath, record);
      return true;
    }

    const sessionKey = normalizeSessionKey(record.sessionKey);
    const active = getActive(sessionKey);
    if (active?.pendingTurnId) return false;

    if (typeof pending.nextAttemptAt === "number" && pending.nextAttemptAt > now) {
      return false;
    }

    if (pending.sentAt && now - pending.sentAt > RECOVERY_MAX_AGE_MS) {
      const delivery =
        normalizeDeliveryHintForSessionKey(record.delivery ?? null, record.sessionKey) ??
        inferDeliveryHintFromSessionKey(record.sessionKey);
      if (delivery?.channel && delivery?.to) {
        try {
          await deliverBestEffortOutboundText({
            channel: delivery.channel,
            to: delivery.to,
            accountId: delivery.accountId,
            threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
            text:
              "Codex result could not be recovered after a gateway restart. Try /askcodex status or resend your prompt.",
          });
          record.lastDelivered = {
            turnId: pending.turnId,
            deliveryKey: pending.deliveryKey,
            deliveredAt: now,
          };
        } catch {
          const nextPending = schedulePendingRetry(pending, now);
          record.pending = nextPending;
          record.lastError = "askcodex: pending recovery expired (delivery failed; will retry)";
          record.updatedAt = now;
          await writeJsonAtomic(recordPath, record);
          return false;
        }
      }
      record.pending = undefined;
      record.lastError = "askcodex: pending recovery expired";
      record.updatedAt = now;
      await writeJsonAtomic(recordPath, record);
      return true;
    }

    const delivery =
      normalizeDeliveryHintForSessionKey(record.delivery ?? null, record.sessionKey) ??
      inferDeliveryHintFromSessionKey(record.sessionKey);
    if (!delivery?.channel || !delivery?.to) {
      const nextPending = schedulePendingRetry(pending, now);
      record.pending = nextPending;
      record.lastError = "askcodex: missing delivery hint (cannot recover)";
      record.updatedAt = now;
      await writeJsonAtomic(recordPath, record);
      return false;
    }

    let sessionFile = record.codex.sessionFile;
    if (!sessionFile && record.codex.sessionId) {
      sessionFile = await findCodexSessionFileById(record.codex.sessionId);
      if (sessionFile) {
        record.codex.sessionFile = sessionFile;
      }
    }
    if (!sessionFile || !existsSync(sessionFile)) {
      record.updatedAt = now;
      await writeJsonAtomic(recordPath, record);
      return false;
    }

    const st = await fs.stat(sessionFile).catch(() => null);
    const quietMs = clampInt(pending.quietMs, 5000, 1000, 30000);
    if (st && now - st.mtimeMs < quietMs) {
      return false;
    }

    const baseOffset = computeJsonlReadBaseOffset({
      pendingJsonlOffset: pending.jsonlOffset,
      lastJsonlOffset: record.codex.lastJsonlOffset,
      fileSize: st?.size ?? 0,
    });
    let cursor = baseOffset;
    let res = await readJsonlAssistantOutputSince({
      filePath: sessionFile,
      startOffset: cursor,
      minTimestampMs: pending.sentAt,
    });
    cursor = res.newOffset;

    for (let attempt = 0; !res.text.trim() && attempt < 3; attempt++) {
      const next = await readJsonlAssistantOutputSince({
        filePath: sessionFile,
        startOffset: cursor,
        minTimestampMs: pending.sentAt,
      });
      cursor = next.newOffset;
      res = next;
      if (next.text.trim()) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    record.codex.lastJsonlOffset = res.newOffset;
    record.updatedAt = now;

    if (res.text.trim()) {
      if (!res.sawFinalAnswer) {
        logWarn("recovery delivering non-final assistant output", {
          sessionKey: normalizeSessionKey(record.sessionKey),
          turnId: pending.turnId,
          sawTaskComplete: res.sawTaskComplete,
        });
      }
      const finalText = res.text.length > 8000 ? `${res.text.slice(0, 7997)}...` : res.text;
      try {
        await deliverBestEffortOutboundText({
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
          text: finalText,
        });
        record.pending = undefined;
        record.lastDelivered = {
          turnId: pending.turnId,
          deliveryKey: pending.deliveryKey,
          deliveredAt: now,
        };
        record.lastError = undefined;
        await writeJsonAtomic(recordPath, record);
        return true;
      } catch (err) {
        const nextPending = schedulePendingRetry(pending, now);
        record.pending = nextPending;
        record.lastError = `askcodex: recovery delivery failed: ${String(err)}`;
        await writeJsonAtomic(recordPath, record);
        return false;
      }
    }

    const stalledMs = pending.sentAt ? now - pending.sentAt : 0;
    if (stalledMs > RECOVERY_STALL_MS) {
      const message =
        pending.mode === "screen"
          ? "Codex output could not be recovered after a gateway restart. Try `/askcodex status` or resend your prompt."
          : "Codex output could not be recovered after a gateway restart. Please resend your prompt.";
      try {
        await deliverBestEffortOutboundText({
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
          text: message,
        });
        record.pending = undefined;
        record.lastDelivered = {
          turnId: pending.turnId,
          deliveryKey: pending.deliveryKey,
          deliveredAt: now,
        };
        record.lastError = "askcodex: recovery stalled (no assistant output)";
        record.updatedAt = now;
        await writeJsonAtomic(recordPath, record);
        return true;
      } catch (err) {
        const nextPending = schedulePendingRetry(pending, now);
        record.pending = nextPending;
        record.lastError = `askcodex: recovery stalled (delivery failed): ${String(err)}`;
        await writeJsonAtomic(recordPath, record);
        return false;
      }
    }

    await writeJsonAtomic(recordPath, record);
    return false;
  });
}

async function recoverPendingDeliveries(config: any): Promise<void> {
  const roots = resolveAgentRootDirsFromConfig(config);
  for (const entry of roots) {
    const recordPaths = await listAskcodexRecordPaths(entry.rootDir);
    for (const recordPath of recordPaths) {
      let record: AskcodexRecordV1 | null = null;
      try {
        record = await readJsonFile<AskcodexRecordV1>(recordPath);
      } catch {
        record = null;
      }
      if (!record?.pending?.turnId) continue;
      try {
        await recoverPendingRecord(recordPath);
      } catch (err) {
        logWarn("recovery failed", { recordPath, error: String(err) });
      }
    }
  }
}

let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryInFlight = false;

async function runRecoveryTick(config: any): Promise<void> {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  try {
    await recoverPendingDeliveries(config);
  } finally {
    recoveryInFlight = false;
  }
}

function startRecoveryPoller(config: any) {
  if (recoveryTimer) return;
  void runRecoveryTick(config);
  recoveryTimer = setInterval(() => {
    void runRecoveryTick(config);
  }, RECOVERY_INTERVAL_MS);
}

function stopRecoveryPoller() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

// --- Codex JSONL reading (for session id persistence + clean assistant output) ---
function resolveEffectiveCodexHome(): string {
  // Must match the home used by the spawned Codex process.
  return getPluginCfg().codexHome;
}

function resolveCodexHomeOverride(): string {
  return getPluginCfg().codexHome;
}

function buildCodexEnv(): Record<string, string | undefined> {
  const codexHomeOverride = resolveCodexHomeOverride();
  return {
    ...process.env,
    TERM: process.env.TERM ?? "xterm-256color",
    CODEX_HOME: codexHomeOverride,
  };
}

function resolveAskcodexDefaultCwd(): string {
  const configured = getPluginCfg().defaultCwd?.trim();
  if (configured) return configured;
  return path.resolve(homedir());
}

async function resolveAskcodexWorkingDir(raw?: string): Promise<string> {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const candidate = trimmed || resolveAskcodexDefaultCwd();

  // Always ensure the default directory exists for Codex_HOME and first-run reliability.
  if (candidate === resolveAskcodexDefaultCwd()) {
    await ensureDir(candidate);
    return await fs.realpath(candidate).catch(() => candidate);
  }

  if (!path.isAbsolute(candidate)) {
    throw new Error(`askcodex: cwd must be an absolute path: ${candidate}`);
  }

  const st = await fs.stat(candidate).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`askcodex: cwd must be an existing absolute directory: ${candidate}`);
  }
  return await fs.realpath(candidate);
}

async function resolveSessionWorkdir(params: {
  record: AskcodexRecordV1;
  explicitCwd?: string;
}): Promise<string> {
  const explicit = params.explicitCwd?.trim();
  const defaultCwd = resolveAskcodexDefaultCwd();

  const primary = explicit || recordToPath(params.record) || defaultCwd;
  try {
    return await resolveAskcodexWorkingDir(primary);
  } catch (error) {
    if (primary !== defaultCwd) {
      try {
        return await resolveAskcodexWorkingDir(defaultCwd);
      } catch (_fallbackErr) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function recordToPath(record: AskcodexRecordV1): string {
  return typeof record.codex.cwd === "string" ? record.codex.cwd.trim() : "";
}

function resolveCodexSessionsRoot(): string {
  return path.join(resolveEffectiveCodexHome(), "sessions");
}

function resolveCodexBin(): string {
  const cfg = getPluginCfg();
  if (cfg.codexBin?.trim()) return cfg.codexBin.trim();

  // Prefer npm-installed codex over mise shims.
  const npmBin = path.join(homedir(), ".local", "npm", "bin", "codex");
  if (existsSync(npmBin)) return npmBin;

  return "codex";
}

function parseAgentConfigFileEntries(raw: string): Map<string, string> {
  const entries = new Map<string, string>();
  let activeAgentType: string | null = null;
  const lines = String(raw ?? "").split(/\r?\n/);
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[agents\.([A-Za-z0-9_-]+)\]\s*$/);
    if (sectionMatch) {
      activeAgentType = sectionMatch[1];
      continue;
    }
    if (!activeAgentType) continue;
    if (/^\s*\[/.test(line)) {
      activeAgentType = null;
      continue;
    }

    const configFileMatch =
      line.match(/^\s*config_file\s*=\s*"([^"]+)"\s*(?:#.*)?$/) ??
      line.match(/^\s*config_file\s*=\s*'([^']+)'\s*(?:#.*)?$/);
    if (!configFileMatch) continue;
    const configFile = configFileMatch[1]?.trim();
    if (!configFile) continue;
    entries.set(activeAgentType, configFile);
  }
  return entries;
}

async function buildAgentConfigOverrideArgs(): Promise<string[]> {
  const cfg = getPluginCfg();
  if (!cfg.forceAbsoluteAgentConfig) return [];

  const codexHomeConfigPath = path.join(resolveEffectiveCodexHome(), "config.toml");
  const realConfigPath = await fs.realpath(codexHomeConfigPath).catch(() => codexHomeConfigPath);
  const baseDir = cfg.sharedConfigDir ?? path.dirname(realConfigPath);
  const raw = await fs.readFile(codexHomeConfigPath, "utf8").catch(() => "");
  const configuredAgentFiles = parseAgentConfigFileEntries(raw);

  if (configuredAgentFiles.size === 0) return [];

  const args: string[] = [];
  for (const [agentType, configFile] of configuredAgentFiles.entries()) {
    const absolutePath = path.isAbsolute(configFile) ? configFile : path.resolve(baseDir, configFile);
    const st = await fs.stat(absolutePath).catch(() => null);
    if (!st?.isFile()) {
      logWarn("agent config file missing; skipping absolute override", {
        agentType,
        configFile,
        resolvedPath: absolutePath,
        codexHomeConfigPath,
        baseDir,
      });
      continue;
    }
    args.push("-c", `agents.${agentType}.config_file=${JSON.stringify(absolutePath)}`);
  }

  return args;
}

async function findCodexSessionFileById(sessionId: string): Promise<string | null> {
  const root = resolveCodexSessionsRoot();
  if (!existsSync(root)) return null;

  let best: { file: string; mtimeMs: number } | null = null;

  const walk = async (dir: string): Promise<void> => {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl")) continue;
      if (!e.name.includes(sessionId)) continue;
      const st = await fs.stat(p).catch(() => null);
      const mtimeMs = st ? st.mtimeMs : 0;
      if (!best || mtimeMs > best.mtimeMs) best = { file: p, mtimeMs };
    }
  };

  await walk(root);
  return best?.file ?? null;
}

const JSONL_READ_MAX_BYTES = 512 * 1024;

function computeJsonlReadBaseOffset(params: {
  pendingJsonlOffset?: number;
  lastJsonlOffset?: number;
  fileSize: number;
  lookbackBytes?: number;
}): number {
  const fileSize = Math.max(0, Math.trunc(params.fileSize));
  const lookback = Math.max(1024, Math.trunc(params.lookbackBytes ?? JSONL_READ_MAX_BYTES));
  const tailBase = Math.max(0, fileSize - lookback);

  const pendingOffset = toNonNegativeInt(params.pendingJsonlOffset);
  const lastOffset = toNonNegativeInt(params.lastJsonlOffset);
  const candidates: number[] = [];
  if (pendingOffset !== undefined && pendingOffset <= fileSize) candidates.push(pendingOffset);
  if (lastOffset !== undefined && lastOffset <= fileSize) candidates.push(lastOffset);
  if (candidates.length > 0) return Math.max(tailBase, ...candidates);
  return tailBase;
}

function shouldInitializeJsonlOffsetOnSessionDiscovery(params: {
  existingOffset?: number;
  hasPendingTurn: boolean;
}): boolean {
  // If a turn is already pending, initializing to EOF can skip that turn's final output.
  return params.existingOffset === undefined && !params.hasPendingTurn;
}

function shouldContinueWaitingForJsonl(params: {
  sessionExited: boolean;
  elapsedMs: number;
  silenceMs: number;
  softWaitMs: number;
  hardWaitMs: number;
}): boolean {
  if (params.sessionExited) {
    // Once PTY exits, keep the existing short grace period for JSONL flush.
    return params.elapsedMs < params.softWaitMs;
  }
  // Before hard timeout we always wait.
  if (params.elapsedMs < params.hardWaitMs) return true;
  // After hard timeout, continue waiting as long as fresh PTY output is still arriving.
  return params.silenceMs < params.hardWaitMs;
}

function computeJsonlPollDelayMs(params: {
  elapsedMs: number;
  silenceMs: number;
  softWaitMs: number;
}): number {
  return params.elapsedMs < params.softWaitMs || params.silenceMs < params.softWaitMs ? 1000 : 5000;
}

async function readJsonlAssistantOutputSince(params: {
  filePath: string;
  startOffset: number;
  minTimestampMs?: number;
}): Promise<{ text: string; newOffset: number; sawAny: boolean; sawTaskComplete: boolean; sawFinalAnswer: boolean }> {
  const fh = await fs.open(params.filePath, "r");
  try {
    const st = await fh.stat();
    const size = st.size;
    if (size <= params.startOffset) {
      return { text: "", newOffset: params.startOffset, sawAny: false, sawTaskComplete: false, sawFinalAnswer: false };
    }

    const toRead = Math.min(size - params.startOffset, JSONL_READ_MAX_BYTES);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, params.startOffset);
    const slice = buf.subarray(0, bytesRead);

    const lastNl = slice.lastIndexOf(0x0a); // \n
    if (lastNl < 0) {
      // No complete lines yet.
      return { text: "", newOffset: params.startOffset, sawAny: false, sawTaskComplete: false, sawFinalAnswer: false };
    }

    const complete = slice.subarray(0, lastNl + 1);
    const newOffset = params.startOffset + lastNl + 1;

    const lines = complete.toString("utf8").split("\n").filter(Boolean);
    const parsedObjects: any[] = [];

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      parsedObjects.push(obj);
    }

    const picked = pickAssistantDeliveryTextFromJsonlObjects(parsedObjects, params.minTimestampMs);

    return {
      text: picked.text,
      newOffset,
      sawAny: picked.sawAny,
      sawTaskComplete: picked.sawTaskComplete,
      sawFinalAnswer: picked.sawFinalAnswer,
    };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function pickAssistantDeliveryTextFromJsonlObjects(
  objects: any[],
  minTimestampMs?: number,
): { text: string; sawAny: boolean; sawTaskComplete: boolean; sawFinalAnswer: boolean } {
  let sawAny = false;
  let sawTaskComplete = false;
  let sawFinalAnswer = false;
  let latestGeneric = "";
  let latestFinalAnswer = "";

  for (const obj of objects) {
    if (typeof minTimestampMs === "number") {
      const tsRaw = typeof obj?.timestamp === "string" ? obj.timestamp : "";
      if (tsRaw) {
        const tsMs = Date.parse(tsRaw);
        if (Number.isFinite(tsMs) && tsMs + 250 < minTimestampMs) {
          continue;
        }
      }
    }

    if (obj?.type === "event_msg" && obj?.payload?.type === "task_complete") {
      sawTaskComplete = true;
      const taskCompleteText = extractTaskCompleteTextFromCodexJsonlEntry(obj);
      if (taskCompleteText) {
        sawAny = true;
        // Fallback for turns where Codex emits completion metadata but no parseable assistant message item.
        if (!latestFinalAnswer) {
          latestFinalAnswer = taskCompleteText;
        }
        sawFinalAnswer = true;
      }
      continue;
    }

    const parts = extractAssistantOutputTextFromCodexJsonlEntry(obj);
    if (parts.length === 0) continue;

    const text = parts.join("\n").trim();
    if (!text) continue;

    sawAny = true;
    const phase = typeof obj?.payload?.phase === "string" ? obj.payload.phase.trim().toLowerCase() : "";
    if (phase === "final_answer") {
      sawFinalAnswer = true;
      latestFinalAnswer = text;
      continue;
    }
    latestGeneric = text;
  }

  // Delivery policy:
  // - Always prefer explicit final answers.
  // - Otherwise, wait for task completion before emitting generic assistant text.
  const text = latestFinalAnswer || (sawTaskComplete ? latestGeneric : "");
  return { text, sawAny, sawTaskComplete, sawFinalAnswer };
}

// --- PTY management ---

type PtyExitEvent = { exitCode: number; signal?: number };

type PtyHandle = {
  pid: number;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (evt: PtyExitEvent) => void) => void;
  write: (data: string) => void;
  resize?: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
) => PtyHandle;

function loadPtySpawn(): PtySpawn {
  // Prefer plugin-local node-pty when packaged independently.
  try {
    const localReq = createRequire(import.meta.url);
    const localMod = localReq("@lydell/node-pty") as any;
    const localSpawn = localMod?.spawn ?? localMod?.default?.spawn;
    if (typeof localSpawn === "function") {
      return localSpawn as PtySpawn;
    }
  } catch {
    // fall through to gateway lookup
  }

  const allowGatewayFallback =
    process.env.ASKCODEX_PTY_GATEWAY_FALLBACK?.trim().toLowerCase() === "1" ||
    process.env.ASKCODEX_PTY_GATEWAY_FALLBACK?.trim().toLowerCase() === "true";

  if (!allowGatewayFallback) {
    throw new Error(
      "askcodex: PTY support unavailable (plugin-local @lydell/node-pty not found). " +
        "Set ASKCODEX_PTY_GATEWAY_FALLBACK=1 to use the gateway's dependency.",
    );
  }

  logWarn("using gateway @lydell/node-pty (set ASKCODEX_PTY_GATEWAY_FALLBACK=0 to disable)", {
    source: "gateway",
  });

  // Resolve node-pty from the running clawdbot install.
  // (The plugin is out-of-tree so it can't rely on its own node_modules.)
  const distDir = resolveClawdbotDistDir();
  const req = createRequire(path.join(distDir, "entry.js"));
  const mod = req("@lydell/node-pty") as any;
  const spawn = mod?.spawn ?? mod?.default?.spawn;
  if (typeof spawn !== "function") {
    throw new Error("askcodex: PTY support unavailable (@lydell/node-pty spawn not found)");
  }
  return spawn as PtySpawn;
}

const DSR_PATTERN = /\x1b\[\??6n/g;
const DA_PATTERN = /\x1b\[c/g;
const OSC10_QUERY_PATTERN = /\x1b\]10;\?\x1b\\/g;
const OSC11_QUERY_PATTERN = /\x1b\]11;\?\x1b\\/g;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

function handleTerminalQueries(session: ActiveSession, data: string): string {
  let out = data;

  // DSR handling: reply to cursor position query.
  if (out.includes("\x1b[")) {
    const count = countMatches(out, DSR_PATTERN);
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        try {
          // Conservative but non-(1,1) cursor; avoids some TUIs getting confused.
          session.pty.write("\x1b[20;1R");
        } catch {
          // ignore
        }
      }
      out = out.replace(DSR_PATTERN, "");
    }

    // Device Attributes query (CSI c) – respond like xterm.
    const daCount = countMatches(out, DA_PATTERN);
    if (daCount > 0) {
      for (let i = 0; i < daCount; i++) {
        try {
          session.pty.write("\x1b[?1;2c");
        } catch {
          // ignore
        }
      }
      out = out.replace(DA_PATTERN, "");
    }
  }

  // OSC color queries (fg/bg).
  if (out.includes("\x1b]")) {
    const fgCount = countMatches(out, OSC10_QUERY_PATTERN);
    if (fgCount > 0) {
      for (let i = 0; i < fgCount; i++) {
        try {
          session.pty.write("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
        } catch {
          // ignore
        }
      }
      out = out.replace(OSC10_QUERY_PATTERN, "");
    }

    const bgCount = countMatches(out, OSC11_QUERY_PATTERN);
    if (bgCount > 0) {
      for (let i = 0; i < bgCount; i++) {
        try {
          session.pty.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
        } catch {
          // ignore
        }
      }
      out = out.replace(OSC11_QUERY_PATTERN, "");
    }
  }

  return out;
}

type ActiveSession = {
  sessionKey: string;
  agentId: string;
  recordPath: string;
  record: AskcodexRecordV1;

  cwd: string;

  pty: PtyHandle;
  startedAt: number;
  lastDataAt: number;
  exited: boolean;
  exitCode?: number;
  signal?: number;

  rawOutput: string;
  drainPos: number;

  // Quiet-turn tracking
  pendingTurnId?: string;
  pendingSentAt?: number;
  pendingMode?: "jsonl" | "screen";
  pendingJsonlOffset?: number;
  quietTimer?: NodeJS.Timeout;
  quietMs: number;

  // Delivery memo
  delivery?: DeliveryHint;

  // Boot / probing
  statusProbeTimers: Array<NodeJS.Timeout>;
};

const sessions = new Map<string, ActiveSession>();

function normalizeSessionKey(sessionKey: string): string {
  // Discord native slash commands can produce ephemeral routing keys. We want a stable per-chat key.
  // Heuristic: strip trailing ":slash:<id>".
  return sessionKey.replace(/:slash:\d+$/i, "");
}

function getActive(sessionKey: string): ActiveSession | null {
  return sessions.get(normalizeSessionKey(sessionKey)) ?? null;
}

function truncateRawBuffer(s: string, max = 1024 * 1024): string {
  if (s.length <= max) return s;
  return s.slice(-Math.floor(max / 2));
}

function isNoSavedSessionFoundError(text: string): boolean {
  const t = String(text ?? "");
  return /No saved session found with ID/i.test(t);
}

function tailForDiagnostics(session: ActiveSession): string {
  const { tail } = buildTailFromText(stripAnsi(session.rawOutput), { lines: 30, maxChars: 4000 });
  return tail;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function parseCodexSessionIdFromText(text: string): string | null {
  const clean = stripAnsi(text);
  const m = /\bSession:\s*([0-9a-fA-F-]{16,})\b/.exec(clean);
  return m?.[1] ? m[1] : null;
}

async function loadOrInitRecord(params: { agentId: string; agentRootDir: string; sessionKey: string }): Promise<{ record: AskcodexRecordV1; recordPath: string }> {
  const normalizedSessionKey = normalizeSessionKey(params.sessionKey);
  const recordPath = resolveRecordPath(params.agentRootDir, normalizedSessionKey);
  await ensureDir(resolveAskcodexDir(params.agentRootDir));
  return await withRecordLock(recordPath, async () => {
    const defaultCwd = await resolveAskcodexWorkingDir();
    const existing = await readJsonFile<AskcodexRecordV1>(recordPath);
    if (existing && existing.version === 1 && existing.sessionKey === normalizedSessionKey) {
      if (!existing.codex) existing.codex = {};
      if (!existing.codex.cwd) {
        existing.codex.cwd = defaultCwd;
        await writeJsonAtomic(recordPath, existing);
      }
      return { record: existing, recordPath };
    }

    const now = nowMs();
    const record: AskcodexRecordV1 = {
      version: 1,
      sessionKey: normalizedSessionKey,
      agentId: params.agentId,
      createdAt: now,
      updatedAt: now,
      codex: {
        cwd: defaultCwd,
      },
    };
    await writeJsonAtomic(recordPath, record);
    return { record, recordPath };
  });
}

async function persistRecord(session: ActiveSession): Promise<void> {
  session.record.updatedAt = nowMs();
  await writeJsonAtomicLocked(session.recordPath, session.record);
}

function clearTimers(session: ActiveSession) {
  if (session.quietTimer) {
    clearTimeout(session.quietTimer);
    session.quietTimer = undefined;
  }
  for (const t of session.statusProbeTimers) {
    clearTimeout(t);
  }
  session.statusProbeTimers = [];
}

async function ensureSessionFile(session: ActiveSession): Promise<void> {
  if (session.record.codex.sessionFile && existsSync(session.record.codex.sessionFile)) return;
  const id = session.record.codex.sessionId;
  if (!id) return;
  const file = await findCodexSessionFileById(id);
  if (file) {
    session.record.codex.sessionFile = file;
    await persistRecord(session);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function resolveCodexDayDir(d: Date): string {
  const root = resolveCodexSessionsRoot();
  const year = String(d.getFullYear());
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return path.join(root, year, month, day);
}

async function readFirstJsonlLine(filePath: string): Promise<string> {
  // session_meta lines can be very large (embedded instructions), so we must read until newline.
  const fh = await fs.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const chunkSize = 16 * 1024;
    const maxBytes = 512 * 1024;
    let offset = 0;
    let total = 0;

    while (total < maxBytes) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl));
        total += nl;
        break;
      }
      chunks.push(slice);
      total += bytesRead;
      offset += bytesRead;
    }

    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function probeCodexSessionIdFromFilesystem(session: ActiveSession): Promise<void> {
  if (session.record.codex.sessionId && session.record.codex.sessionFile) return;

  const root = resolveCodexSessionsRoot();
  if (!existsSync(root)) return;

  const now = Date.now();
  // Only consider session files created very close to this PTY start.
  // Using a wide window can accidentally latch onto a different Codex session started moments earlier.
  const sinceMs = Math.max(0, session.startedAt - 750);

  const dirs = [resolveCodexDayDir(new Date(now)), resolveCodexDayDir(new Date(now - 24 * 60 * 60 * 1000))];

  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl")) continue;
      const p = path.join(dir, e.name);
      const st = await fs.stat(p).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < sinceMs) continue;
      candidates.push({ file: p, mtimeMs: st.mtimeMs });
    }
  }

  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Try the most recent few files; prefer one whose session_meta cwd matches our PTY cwd.
  for (const cand of candidates.slice(0, 10)) {
    try {
      const firstLine = await readFirstJsonlLine(cand.file);
      let obj: any;
      try {
        obj = JSON.parse(firstLine);
      } catch {
        continue;
      }
      if (obj?.type !== "session_meta") continue;
      const id = typeof obj?.payload?.id === "string" ? obj.payload.id.trim() : "";
      const metaCwd = typeof obj?.payload?.cwd === "string" ? obj.payload.cwd.trim() : "";
      if (!id) continue;
      if (metaCwd && metaCwd !== session.cwd) {
        // Not our session; keep searching.
        continue;
      }

      session.record.codex.sessionId = id;
      session.record.codex.sessionFile = cand.file;

      // Initialize baseline offset if unset (so we don't try to parse the entire session history).
      const st = await fs.stat(cand.file).catch(() => null);
      const hasPendingTurn = Boolean(session.pendingTurnId || session.record.pending?.turnId);
      if (st && shouldInitializeJsonlOffsetOnSessionDiscovery({
        existingOffset: session.record.codex.lastJsonlOffset,
        hasPendingTurn,
      })) {
        session.record.codex.lastJsonlOffset = st.size;
      }

      await persistRecord(session);

      logInfo("discovered codex session", {
        sessionKey: normalizeSessionKey(session.sessionKey),
        codexSessionId: id,
        sessionFile: cand.file,
        cwd: metaCwd || undefined,
      });
      return;
    } catch {
      continue;
    }
  }
}

async function ensureCodexJsonlReady(session: ActiveSession): Promise<void> {
  // Best-effort: wait briefly for CODEX_HOME/sessions to appear for this PTY.
  for (let i = 0; i < 8; i++) {
    if (session.record.codex.sessionFile && existsSync(session.record.codex.sessionFile)) return;
    await probeCodexSessionIdFromFilesystem(session);
    await ensureSessionFile(session);
    if (session.record.codex.sessionFile && existsSync(session.record.codex.sessionFile)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function refreshJsonlOffsetAtSend(session: ActiveSession): Promise<void> {
  const file = session.record.codex.sessionFile;
  if (!file) return;
  const st = await fs.stat(file).catch(() => null);
  if (!st) return;
  session.pendingJsonlOffset = st.size;
}

function clearPendingTurnRuntime(session: ActiveSession): void {
  session.pendingTurnId = undefined;
  session.pendingSentAt = undefined;
  session.pendingMode = undefined;
  session.pendingJsonlOffset = undefined;
  if (session.quietTimer) {
    clearTimeout(session.quietTimer);
    session.quietTimer = undefined;
  }
}

async function deliverTurnResultIfPossible(session: ActiveSession, turnId: string): Promise<void> {
  if (session.pendingTurnId !== turnId) return;

  const pending = normalizePendingTurn(session.sessionKey, session.record.pending, session.quietMs);
  if (!pending || pending.turnId !== turnId) return;

  session.record.pending = pending;
  session.pendingTurnId = pending.turnId;
  session.pendingSentAt = pending.sentAt;
  session.pendingMode = pending.mode;
  session.pendingJsonlOffset = pending.jsonlOffset;

  if (isPendingAlreadyDelivered(session.record, pending)) {
    session.record.pending = undefined;
    session.record.lastError = undefined;
    await persistRecord(session);
    clearPendingTurnRuntime(session);
    return;
  }

  const now = nowMs();
  if (typeof pending.nextAttemptAt === "number" && pending.nextAttemptAt > now) {
    scheduleQuietTimer(session, turnId, pending.nextAttemptAt - now);
    return;
  }

  const markRetryAndReschedule = async (errorText: string): Promise<void> => {
    const retryNow = nowMs();
    const nextPending = schedulePendingRetry(pending, retryNow);
    session.record.pending = nextPending;
    session.record.lastError = errorText;
    await persistRecord(session);
    if (session.pendingTurnId === turnId) {
      const delayMs = computePendingAttemptDelayMs(nextPending, retryNow, session.quietMs);
      scheduleQuietTimer(session, turnId, delayMs);
    }
  };

  const markDelivered = async (): Promise<void> => {
    const deliveredAt = nowMs();
    session.record.pending = undefined;
    session.record.lastDelivered = {
      turnId: pending.turnId,
      deliveryKey: pending.deliveryKey,
      deliveredAt,
    };
    session.record.lastError = undefined;
    await persistRecord(session);
    clearPendingTurnRuntime(session);
  };

  const delivery =
    normalizeDeliveryHintForSessionKey(session.record.delivery ?? null, session.sessionKey) ??
    inferDeliveryHintFromSessionKey(session.sessionKey);

  if (!delivery?.channel || !delivery?.to) {
    await markRetryAndReschedule("askcodex: missing delivery hint (cannot deliver)");
    return;
  }

  const sentAt = pending.sentAt ?? session.startedAt;
  const elapsedMs = Math.max(0, nowMs() - sentAt);

  if (pending.mode === "screen") {
    const { tail } = buildTailFromText(stripAnsi(session.rawOutput), { lines: 80, maxChars: 8000 });
    const text = tail.trim() ? tail : "(No output captured)";
    try {
      await deliverBestEffortOutboundText({
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
        text,
      });
      await markDelivered();
    } catch (err) {
      await markRetryAndReschedule(`askcodex: delivery failed: ${String(err)}`);
    }
    return;
  }

  let text: string | null = null;
  let textFromFinalAnswer = false;
  try {
    await ensureCodexJsonlReady(session);
    const file = session.record.codex.sessionFile;
    if (file) {
      const st = await fs.stat(file).catch(() => null);
      const baseOffset = computeJsonlReadBaseOffset({
        pendingJsonlOffset: pending.jsonlOffset,
        lastJsonlOffset: session.record.codex.lastJsonlOffset,
        fileSize: st?.size ?? 0,
      });
      let cursor = baseOffset;
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await readJsonlAssistantOutputSince({
          filePath: file,
          startOffset: cursor,
          minTimestampMs: pending.sentAt,
        });
        cursor = res.newOffset;
        session.record.codex.lastJsonlOffset = res.newOffset;
        if (res.text) {
          text = res.text;
          textFromFinalAnswer = res.sawFinalAnswer;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      await persistRecord(session);
    }
  } catch (err) {
    await markRetryAndReschedule(`askcodex: jsonl read failed: ${String(err)}`);
    return;
  }

  if (!text) {
    const softWaitMs = 90_000;
    const hardWaitMs = 300_000;
    const now = nowMs();
    const silenceMs = Math.max(0, now - Math.max(sentAt, session.lastDataAt));

    if (
      shouldContinueWaitingForJsonl({
        sessionExited: session.exited,
        elapsedMs,
        silenceMs,
        softWaitMs,
        hardWaitMs,
      })
    ) {
      logInfo(session.exited ? "awaiting codex jsonl output after pty exit" : "awaiting codex jsonl output", {
        sessionKey: normalizeSessionKey(session.sessionKey),
        elapsedMs,
        silenceMs,
        hasSessionId: Boolean(session.record.codex.sessionId),
        hasSessionFile: Boolean(session.record.codex.sessionFile),
        softWaitMs,
        hardWaitMs,
      });
      scheduleQuietTimer(
        session,
        turnId,
        computeJsonlPollDelayMs({
          elapsedMs,
          silenceMs,
          softWaitMs,
        }),
      );
      return;
    }

    // Avoid leaking noisy PTY screens (spinner/progress/commentary/tool traces)
    // when Codex failed to emit a final assistant message into JSONL.
    const { tail } = buildTailFromText(stripAnsi(session.rawOutput), { lines: 30, maxChars: 1200 });
    logWarn("no final assistant output in jsonl; delivering concise fallback", {
      sessionKey: normalizeSessionKey(session.sessionKey),
      turnId: pending.turnId,
      elapsedMs,
      sessionExited: session.exited,
      tailPreview: tail ? safePreview(tail, 300) : undefined,
    });
    text =
      "Codex didn’t produce a final answer for that turn (likely interrupted/compaction error). " +
      "Please resend the prompt. If it repeats, run /askcodex status.";
    textFromFinalAnswer = true;
  }

  if (!textFromFinalAnswer) {
    logWarn("delivering non-final assistant output", {
      sessionKey: normalizeSessionKey(session.sessionKey),
      turnId: pending.turnId,
    });
  }

  const finalText = text.length > 8000 ? `${text.slice(0, 7997)}...` : text;
  try {
    await deliverBestEffortOutboundText({
      channel: delivery.channel,
      to: delivery.to,
      accountId: delivery.accountId,
      threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
      text: finalText,
    });
    await markDelivered();
  } catch (err) {
    await markRetryAndReschedule(`askcodex: delivery failed: ${String(err)}`);
  }
}

function scheduleQuietTimer(session: ActiveSession, turnId: string, delayMs = session.quietMs) {
  if (session.quietTimer) clearTimeout(session.quietTimer);
  const waitMs = Math.max(100, Math.trunc(delayMs));
  session.quietTimer = setTimeout(() => {
    void deliverTurnResultIfPossible(session, turnId);
  }, waitMs);
}

function attachPtyHandlers(session: ActiveSession) {
  session.pty.onData((data) => {
    data = handleTerminalQueries(session, data);

    session.lastDataAt = nowMs();
    session.rawOutput = truncateRawBuffer(session.rawOutput + data);

    // Session id discovery via output parsing.
    if (!session.record.codex.sessionId) {
      const candidate = parseCodexSessionIdFromText(session.rawOutput.slice(-20000));
      if (candidate) {
        session.record.codex.sessionId = candidate;
        void persistRecord(session).then(() => void ensureSessionFile(session));
      }
    }

    // If we are waiting for quiet after send, reset quiet timer.
    if (session.pendingTurnId) {
      scheduleQuietTimer(session, session.pendingTurnId);
    }
  });

  session.pty.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.signal = signal;

    const { tail } = buildTailFromText(stripAnsi(session.rawOutput), { lines: 20, maxChars: 2000 });
    logWarn("pty exited", {
      sessionKey: normalizeSessionKey(session.sessionKey),
      pid: session.pty.pid,
      exitCode,
      signal,
      tail: tail ? safePreview(tail, 400) : undefined,
    });

    // If we were in the middle of a turn, don't leave the user hanging.
    if (session.pendingTurnId) {
      const pendingTurnId = session.pendingTurnId;
      const pending =
        normalizePendingTurn(session.sessionKey, session.record.pending, session.quietMs) ??
        {
          turnId: pendingTurnId,
          mode: session.pendingMode === "screen" ? "screen" : "jsonl",
          sentAt: session.pendingSentAt ?? nowMs(),
          ...(typeof session.pendingJsonlOffset === "number" ? { jsonlOffset: session.pendingJsonlOffset } : {}),
          quietMs: session.quietMs,
          deliveryKey: computePendingDeliveryKey(session.sessionKey, pendingTurnId),
          retryCount: 0,
        };
      session.record.pending = schedulePendingRetry(pending, nowMs());
      session.record.lastError = `askcodex: pty exited mid-turn (exitCode=${exitCode}${signal ? ` signal=${signal}` : ""}); awaiting recovery`;
      void persistRecord(session);
      clearPendingTurnRuntime(session);

      logWarn("pty exited mid-turn", {
        sessionKey: normalizeSessionKey(session.sessionKey),
        turnId: pendingTurnId,
        exitCode,
        signal,
      });
    }

    clearTimers(session);
    // keep record for resume; drop in-memory session.
    // Important: if we spawned a newer PTY for the same chat, do not delete the new one.
    const key = normalizeSessionKey(session.sessionKey);
    const current = sessions.get(key);
    if (current?.pty?.pid === session.pty.pid) {
      sessions.delete(key);
    }
  });
}

async function startNewCodexPty(params: {
  sessionKey: string;
  agentId: string;
  agentRootDir: string;
  cwd: string;
  quietMs: number;
  mode: "new" | "resume";
  resumeSessionId?: string;
  /** If set, Codex will immediately send this prompt on startup (no key injection needed). */
  initialPrompt?: string;
}): Promise<ActiveSession> {
  const { record, recordPath } = await loadOrInitRecord({
    agentId: params.agentId,
    agentRootDir: params.agentRootDir,
    sessionKey: params.sessionKey,
  });

  const spawn = loadPtySpawn();

  const codexBin = resolveCodexBin();
  const initialPrompt = typeof params.initialPrompt === "string" && params.initialPrompt.trim() ? params.initialPrompt : undefined;
  const cwd = params.cwd;
  const codexConfigOverrideArgs = await buildAgentConfigOverrideArgs();
  await ensureDir(resolveEffectiveCodexHome());

  // IMPORTANT: We always run Codex in YOLO mode (no approvals, no sandbox restrictions).
  // This is intentionally dangerous and should only be used on trusted machines.
  const args =
    params.mode === "resume" && params.resumeSessionId
      ? [
          "--cd",
          cwd,
          ...codexConfigOverrideArgs,
          "resume",
          "--yolo",
          "--no-alt-screen",
          params.resumeSessionId,
          ...(initialPrompt ? [initialPrompt] : []),
        ]
      : [
          "--cd",
          cwd,
          ...codexConfigOverrideArgs,
          "--yolo",
          "--no-alt-screen",
          ...(initialPrompt ? [initialPrompt] : []),
        ];

  const startedAt = nowMs();

  const pty = spawn(codexBin, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 35,
    cwd: params.cwd,
    env: buildCodexEnv(),
  });

  const session: ActiveSession = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    recordPath,
    record,

    cwd: params.cwd,

    pty,
    startedAt,
    lastDataAt: startedAt,
    exited: false,
    rawOutput: "",
    drainPos: 0,
    quietMs: params.quietMs,
    statusProbeTimers: [],
  };

  // Store (best-effort) delivery hint each time.
  const inferred = inferDeliveryHintFromSessionKey(params.sessionKey);
  if (inferred) {
    session.record.delivery = inferred as any;
    await persistRecord(session);
  }

  logInfo("pty started", {
    sessionKey: normalizeSessionKey(params.sessionKey),
    pid: pty.pid,
    mode: params.mode,
    resumeSessionId: params.resumeSessionId,
    codexBin,
  });

  attachPtyHandlers(session);

  // If this session has a persisted pending turn (after a restart), restore it and continue
  // using the same quiet-only completion logic.
  const restoredPending = normalizePendingTurn(session.sessionKey, session.record.pending, session.quietMs);
  if (restoredPending) {
    const shouldPersistNormalizedPending =
      !session.record.pending?.deliveryKey ||
      session.record.pending?.retryCount === undefined ||
      session.record.pending?.quietMs === undefined;
    session.record.pending = restoredPending;
    session.pendingTurnId = restoredPending.turnId;
    session.pendingSentAt = restoredPending.sentAt;
    session.pendingMode = restoredPending.mode;
    session.pendingJsonlOffset = restoredPending.jsonlOffset;
    if (shouldPersistNormalizedPending) {
      await persistRecord(session);
    }
    const delayMs = computePendingAttemptDelayMs(restoredPending, nowMs(), session.quietMs);
    scheduleQuietTimer(session, restoredPending.turnId, delayMs);
  }

  // Prime session id discovery by scanning CODEX_HOME/sessions for a newly created session.
  // (Codex '/status' does not reliably render under PTY automation.)
  session.statusProbeTimers.push(
    setTimeout(() => {
      void probeCodexSessionIdFromFilesystem(session);
    }, 1500),
  );
  session.statusProbeTimers.push(
    setTimeout(() => {
      void probeCodexSessionIdFromFilesystem(session);
    }, 4000),
  );
  session.statusProbeTimers.push(
    setTimeout(() => {
      void probeCodexSessionIdFromFilesystem(session);
    }, 9000),
  );

  sessions.set(normalizeSessionKey(params.sessionKey), session);
  return session;
}

async function ensureActivePty(params: {
  sessionKey: string;
  agentId: string;
  agentRootDir: string;
  cwd?: string;
  quietMs: number;
}): Promise<ActiveSession> {
  const existing = getActive(params.sessionKey);
  if (existing && !existing.exited) return existing;

  // If we have a persisted codex session id, try to resume it.
  const { record, recordPath } = await loadOrInitRecord({
    agentId: params.agentId,
    agentRootDir: params.agentRootDir,
    sessionKey: params.sessionKey,
  });

  const cwd = await resolveSessionWorkdir({
    record,
    explicitCwd: params.cwd,
  });
  if (record.codex.cwd !== cwd) {
    record.codex.cwd = cwd;
    await writeJsonAtomic(recordPath, record);
  }

  if (record.codex.sessionId) {
    const existingFile = record.codex.sessionFile && existsSync(record.codex.sessionFile)
      ? record.codex.sessionFile
      : await findCodexSessionFileById(record.codex.sessionId);

    if (existingFile && record.codex.sessionFile !== existingFile) {
      record.codex.sessionFile = existingFile;
      await writeJsonAtomicLocked(recordPath, record);
    }

    const resumed = await startNewCodexPty({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      agentRootDir: params.agentRootDir,
      cwd,
      quietMs: params.quietMs,
      mode: "resume",
      resumeSessionId: record.codex.sessionId,
    });

    // Defensive: Codex can exit immediately (e.g. stale/unknown session id).
    // If that happens, clear the stored session id and start a new session.
    await sleep(250);
    if (resumed.exited && resumed.exitCode && resumed.exitCode !== 0) {
      const tail = tailForDiagnostics(resumed);
      if (isNoSavedSessionFoundError(tail)) {
        logWarn("resume failed (no saved session); starting new session", {
          sessionKey: normalizeSessionKey(params.sessionKey),
          codexSessionId: record.codex.sessionId,
          tail: safePreview(tail, 300),
        });
        record.codex.sessionId = undefined;
        record.codex.sessionFile = undefined;
        record.codex.lastJsonlOffset = undefined;
        record.lastError = "askcodex: stored session id not found; started a new session";
        await writeJsonAtomicLocked(recordPath, record);

        return await startNewCodexPty({
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          agentRootDir: params.agentRootDir,
          cwd,
          quietMs: params.quietMs,
          mode: "new",
        });
      }
    }

    return resumed;
  }

  return await startNewCodexPty({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    agentRootDir: params.agentRootDir,
    cwd,
    quietMs: params.quietMs,
    mode: "new",
  });
}

async function ensureCodexSessionIdAvailable(params: {
  sessionKey: string;
  agentId: string;
  agentRootDir: string;
  cwd: string;
  quietMs: number;
}): Promise<{ sessionId: string; sessionFile?: string }> {
  const { record } = await loadOrInitRecord({
    agentId: params.agentId,
    agentRootDir: params.agentRootDir,
    sessionKey: params.sessionKey,
  });

  if (record.codex.sessionId) {
    // Validate the session id actually exists in the current CODEX_HOME.
    const existingFile = record.codex.sessionFile && existsSync(record.codex.sessionFile)
      ? record.codex.sessionFile
      : await findCodexSessionFileById(record.codex.sessionId);

    if (existingFile) {
      if (!record.codex.sessionFile) {
        record.codex.sessionFile = existingFile;
        await writeJsonAtomicLocked(resolveRecordPath(params.agentRootDir, normalizeSessionKey(params.sessionKey)), {
          ...record,
          updatedAt: nowMs(),
        });
      }
      return { sessionId: record.codex.sessionId, sessionFile: existingFile };
    }

    // Stale session id (e.g. CODEX_HOME changed or sessions were cleared). Start a new one.
    record.codex.sessionId = undefined;
    record.codex.sessionFile = undefined;
    record.codex.lastJsonlOffset = undefined;
    await writeJsonAtomicLocked(resolveRecordPath(params.agentRootDir, normalizeSessionKey(params.sessionKey)), {
      ...record,
      updatedAt: nowMs(),
    });
  }

  // Create a fresh interactive session just long enough to discover the session id (no tokens spent).
  const session = await ensureActivePty({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    agentRootDir: params.agentRootDir,
    cwd: params.cwd,
    quietMs: params.quietMs,
  });

  await ensureCodexJsonlReady(session);
  await probeCodexSessionIdFromFilesystem(session);

  const id = session.record.codex.sessionId;
  if (!id) throw new Error("Failed to discover Codex session id. Try /askcodex start, then /askcodex status.");

  // Unless explicitly requested, don't keep the interactive TUI running.
  const keep = getPluginCfg().keepPty;
  if (!keep) {
    try {
      session.pty.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  return { sessionId: id, sessionFile: session.record.codex.sessionFile };
}


async function actionStatus(params: {
  sessionKey: string;
  agentId: string;
  agentRootDir: string;
  outputLines: number;
  outputMaxChars: number;
  drain: boolean;
}): Promise<any> {
  const session = getActive(params.sessionKey);
  const { record } = await loadOrInitRecord({
    agentId: params.agentId,
    agentRootDir: params.agentRootDir,
    sessionKey: params.sessionKey,
  });

  // If PTY is alive but we haven't discovered the codex session id yet, try to discover it.
  if (session && !record.codex.sessionId) {
    await probeCodexSessionIdFromFilesystem(session);
  }

  const status = session
    ? session.exited
      ? "exited"
      : session.pendingTurnId
        ? "running"
        : "idle"
    : record.codex.sessionId
      ? "not-running (resumable)"
      : "not-running";

  let output = "";
  let truncated = false;

  if (session) {
    if (params.drain) {
      const raw = session.rawOutput.slice(session.drainPos);
      session.drainPos = session.rawOutput.length;
      const clean = stripAnsi(raw);
      output = clean.length > params.outputMaxChars ? clean.slice(-params.outputMaxChars) : clean;
      truncated = clean.length > params.outputMaxChars;
    } else {
      const clean = stripAnsi(session.rawOutput);
      const tail = buildTailFromText(clean, { lines: params.outputLines, maxChars: params.outputMaxChars });
      output = tail.tail;
      truncated = tail.truncated;
    }
  }

  const pendingFromSession = normalizePendingTurn(
    params.sessionKey,
    session?.record.pending ?? undefined,
    session?.quietMs ?? 5000,
  );
  const pendingFromRecord = normalizePendingTurn(params.sessionKey, record.pending, session?.quietMs ?? 5000);
  const pending = pendingFromSession ?? pendingFromRecord;
  const now = nowMs();
  const pendingNextAttemptInMs =
    pending?.nextAttemptAt && pending.nextAttemptAt > now ? pending.nextAttemptAt - now : null;

  return {
    ok: true,
    action: "status",
    status,
    codexSessionId: record.codex.sessionId ?? session?.record.codex.sessionId ?? null,
    pid: session?.pty.pid ?? null,
    runtimeMs: session ? nowMs() - session.startedAt : null,
    output,
    truncated,
    lastError: record.lastError ?? null,
    pendingTurnId: pending?.turnId ?? null,
    pendingMode: pending?.mode ?? null,
    pendingAgeMs: pending ? Math.max(0, now - pending.sentAt) : null,
    pendingRetryCount: pending?.retryCount ?? null,
    pendingNextAttemptInMs,
  };
}

export const __internals = {
  computePendingDeliveryKey,
  normalizePendingTurn,
  computeRetryDelayMs,
  schedulePendingRetry,
  isPendingAlreadyDelivered,
  computePendingAttemptDelayMs,
  computeJsonlReadBaseOffset,
  shouldInitializeJsonlOffsetOnSessionDiscovery,
  shouldContinueWaitingForJsonl,
  computeJsonlPollDelayMs,
  pickAssistantDeliveryTextFromJsonlObjects,
  applyOperationalGuardToPrompt,
};

export default {
  id: "askcodex",
  name: "askcodex",
  description: "Run Codex per chat: discover a Codex session id via PTY, then submit prompts by spawning `codex resume --no-alt-screen <id> \"<prompt>\"` and deliver the final assistant message back to chat.",

  register: (api: any) => {
    pluginApi = api;
    pluginCfg = resolvePluginConfig(api);
    pluginLogger = api?.logger ?? null;
    api.registerService({
      id: "askcodex-recovery",
      start: ({ config }: { config: any }) => {
        startRecoveryPoller(config);
      },
      stop: () => {
        stopRecoveryPoller();
      },
    });
    api.registerTool((ctx: any) => {
      return {
        name: "askcodex",
        label: "askcodex",
        description:
          "Manage a per-chat Codex PTY session. Commands: help, status, new, send, stop, reset, handoff, resume.",
        parameters: AskcodexToolSchema,

        execute: async (_toolCallId: string, args: any) => {
          const params = (args ?? {}) as Record<string, unknown>;

          const rawCommand = typeof params.command === "string" ? params.command.trim() : "";
          const invokedViaCommandDispatch =
            typeof params.commandName === "string" || typeof params.skillName === "string";
          if (invokedViaCommandDispatch && !rawCommand && params.action === undefined) {
            params.action = "help";
          }
          if (rawCommand.length > 0 && params.action === undefined) {
            const parsed = parseAskcodexRawCommand(rawCommand);
            if ("error" in parsed) {
              return textResult(parsed.error, { ok: false, error: "unknown_command" });
            }
            params.action = parsed.action;
            if ("cwd" in parsed) params.cwd = parsed.cwd;
            if ("message" in parsed) params.message = parsed.message;
          }

          const action = String((params as any)?.action ?? "").trim().toLowerCase() as AskcodexAction;
          const quietMs = 5000;

          if (REMOVED_ASKCODEX_ACTIONS.has(action)) {
            return textResult(`Unknown /askcodex command: ${action}. Run /askcodex help.`, {
              ok: false,
              error: "unknown_command",
            });
          }
          if (action === "help") {
            return textResult(renderAskcodexHelpText(), { ok: true, action: "help" });
          }

          const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
          if (!sessionKey) return jsonResult({ ok: false, error: "askcodex requires a chat sessionKey" });
          const normalizedSessionKey = normalizeSessionKey(sessionKey);

          const agentId = (typeof ctx.agentId === "string" && ctx.agentId.trim())
            ? ctx.agentId.trim()
            : inferAgentIdFromSessionKey(sessionKey);
          if (!agentId) {
            return jsonResult({ ok: false, error: `Unable to infer agentId from sessionKey=${normalizedSessionKey}` });
          }

          const agentRootDir =
            resolveAgentRootDirFromAgentDir(ctx.agentDir) ??
            resolveAgentRootDirFromAgentId(agentId);

          if (!agentRootDir) {
            return jsonResult({ ok: false, error: `Unable to resolve agent root dir for agentId=${agentId}` });
          }

          logInfo("tool call", {
            action,
            sessionKey: normalizedSessionKey,
            rawSessionKey: sessionKey !== normalizedSessionKey ? sessionKey : undefined,
            agentId,
          });

          // Ensure base dir exists.
          await ensureDir(resolveAskcodexDir(agentRootDir));
          const explicitCwd =
            typeof args?.cwd === "string" && args.cwd.trim()
              ? args.cwd.trim()
              : "";

          if (action === "list") {
            const active = Array.from(sessions.values()).map((s) => ({
              sessionKey: s.sessionKey,
              pid: s.pty.pid,
              startedAt: s.startedAt,
              runtimeMs: nowMs() - s.startedAt,
              exited: s.exited,
              codexSessionId: s.record.codex.sessionId ?? null,
            }));
            return jsonResult({ ok: true, action: "list", active });
          }

          if (action === "start") {
            const { record, recordPath } = await loadOrInitRecord({
              agentId,
              agentRootDir,
              sessionKey: normalizedSessionKey,
            });
            const resolvedCwd = await resolveSessionWorkdir({
              record,
              explicitCwd,
            });
            if (record.codex.cwd !== resolvedCwd) {
              record.codex.cwd = resolvedCwd;
              await writeJsonAtomic(recordPath, record);
            }

            const session = await ensureActivePty({
              sessionKey: normalizedSessionKey,
              agentId,
              agentRootDir,
              cwd: resolvedCwd,
              quietMs,
            });

            // Best-effort: try to discover the session id quickly, but don't fail the command if it takes longer.
            try {
              await ensureCodexJsonlReady(session);
              await probeCodexSessionIdFromFilesystem(session);
            } catch {
              // ignore
            }

            const hint = session.record.codex.sessionId
              ? `\nSession: ${session.record.codex.sessionId}`
              : "\nSession: (discovering… run /askcodex status in a few seconds)";

            return textResult(
              `Started Codex session. PTY PID=${session.pty.pid}${hint}`,
              { ok: true, action: "start", pid: session.pty.pid, codexSessionId: session.record.codex.sessionId ?? null },
            );
          }

          if (action === "new") {
            const requestCwd = explicitCwd;
            let resolvedCwd: string;
            try {
              resolvedCwd = await resolveAskcodexWorkingDir(requestCwd || undefined);
            } catch (error) {
              return textResult(
                `Invalid /askcodex new cwd: ${String(error)}`,
                { ok: false, action: "new", error: "invalid_cwd" },
              );
            }

            const recordPathBefore = resolveRecordPath(agentRootDir, normalizedSessionKey);
            const existingBefore = await readJsonFile<AskcodexRecordV1>(recordPathBefore);
            const { record, recordPath } = await loadOrInitRecord({
              agentId,
              agentRootDir,
              sessionKey: normalizedSessionKey,
            });
            const previousRecordSnapshot: AskcodexRecordV1 | null = existingBefore
              ? (JSON.parse(JSON.stringify(record)) as AskcodexRecordV1)
              : null;

            const existing = getActive(normalizedSessionKey);
            let replacedPid: number | null = null;
            if (existing) {
              replacedPid = existing.pty.pid;
              clearPendingTurnRuntime(existing);
              existing.record.pending = undefined;
              existing.record.lastError = undefined;
              try {
                existing.pty.kill("SIGTERM");
              } catch {
                // ignore
              }
              clearTimers(existing);
              sessions.delete(normalizedSessionKey);
            }

            const archivePath = previousRecordSnapshot
              ? await archiveAskcodexRecord({
                agentRootDir,
                sessionKey: normalizedSessionKey,
                record: previousRecordSnapshot,
                reason: "new",
              })
              : null;

            // Force a brand-new Codex session for this chat, disregarding any previous session id.
            record.codex.cwd = resolvedCwd;
            record.codex.sessionId = undefined;
            record.codex.sessionFile = undefined;
            record.codex.lastJsonlOffset = undefined;
            record.pending = undefined;
            record.lastError = undefined;
            record.updatedAt = nowMs();
            await writeJsonAtomicLocked(recordPath, record);

            const session = await startNewCodexPty({
              sessionKey: normalizedSessionKey,
              agentId,
              agentRootDir,
              cwd: resolvedCwd,
              quietMs,
              mode: "new",
            });

            // Best-effort: try to discover the new session id quickly.
            try {
              await ensureCodexJsonlReady(session);
              await probeCodexSessionIdFromFilesystem(session);
            } catch {
              // ignore
            }

            const hint = session.record.codex.sessionId
              ? `\nSession: ${session.record.codex.sessionId}`
              : "\nSession: (discovering… run /askcodex status in a few seconds)";
            const replacedHint = replacedPid != null ? `\nReplaced previous PTY PID=${replacedPid}.` : "";

            return textResult(
              `Started NEW Codex session. PTY PID=${session.pty.pid}${hint}${replacedHint}`,
              {
                ok: true,
                action: "new",
                pid: session.pty.pid,
                replacedPid,
                codexSessionId: session.record.codex.sessionId ?? null,
                archivedPrevious: Boolean(previousRecordSnapshot),
                archivePath,
              },
            );
          }

          if (action === "handoff") {
            const { record } = await loadOrInitRecord({ agentId, agentRootDir, sessionKey: normalizedSessionKey });
            if (!record.codex.sessionId) {
              return textResult("No stored Codex session id for this chat. Start one with /askcodex new [abs path].", {
                ok: false,
                action: "handoff",
                error: "missing_session_id",
              });
            }

            const codexHomeOverride = resolveCodexHomeOverride();
            const prefix = codexHomeOverride ? `CODEX_HOME=${codexHomeOverride} ` : "";
            return textResult(
              `To hand off this session interactively on this machine (YOLO mode):\n\n${prefix}codex resume --yolo ${record.codex.sessionId}`,
              { ok: true, action: "handoff", codexSessionId: record.codex.sessionId, codexHome: codexHomeOverride || null },
            );
          }

          if (action === "resume") {
            const { record, recordPath } = await loadOrInitRecord({
              agentId,
              agentRootDir,
              sessionKey: normalizedSessionKey,
            });
            const resolvedCwd = await resolveSessionWorkdir({ record, explicitCwd: "" });

            const existing = getActive(normalizedSessionKey);
            if (existing && !existing.exited) {
              if (existing.cwd === resolvedCwd) {
                return textResult(
                  `Codex session is already active in ${existing.cwd}. PTY PID=${existing.pty.pid}`,
                  { ok: true, action: "resume", pid: existing.pty.pid, codexSessionId: existing.record.codex.sessionId ?? null },
                );
              }
            }

            if (existing) {
              existing.pty.kill("SIGTERM");
              clearTimers(existing);
              sessions.delete(normalizeSessionKey(sessionKey));
            }

            record.pending = undefined;
            record.lastError = undefined;
            record.updatedAt = nowMs();
            await writeJsonAtomicLocked(recordPath, record);

            const session = await ensureActivePty({
              sessionKey: normalizedSessionKey,
              agentId,
              agentRootDir,
              cwd: resolvedCwd,
              quietMs,
            });

            return textResult(
              `Resumed Codex automation. PTY PID=${session.pty.pid} in ${resolvedCwd}`,
              { ok: true, action: "resume", pid: session.pty.pid, codexSessionId: session.record.codex.sessionId ?? null },
            );
          }

          if (action === "reset") {
            const { record, recordPath } = await loadOrInitRecord({
              agentId,
              agentRootDir,
              sessionKey: normalizedSessionKey,
            });
            const resolvedCwd = await resolveSessionWorkdir({ record, explicitCwd: "" });

            const existing = getActive(normalizedSessionKey);
            if (existing) {
              try {
                existing.pty.kill("SIGTERM");
              } catch {
                // ignore
              }
              clearTimers(existing);
              sessions.delete(normalizedSessionKey);
            }

            record.pending = undefined;
            record.lastError = undefined;
            record.updatedAt = nowMs();
            await writeJsonAtomicLocked(recordPath, record);

            const session = await ensureActivePty({
              sessionKey: normalizedSessionKey,
              agentId,
              agentRootDir,
              cwd: resolvedCwd,
              quietMs,
            });

            try {
              await ensureCodexJsonlReady(session);
              await probeCodexSessionIdFromFilesystem(session);
            } catch {
              // ignore
            }

            return textResult(
              `Reset Codex runtime. PTY PID=${session.pty.pid}${session.record.codex.sessionId ? `\nSession: ${session.record.codex.sessionId}` : ""}`,
              {
                ok: true,
                action: "reset",
                pid: session.pty.pid,
                codexSessionId: session.record.codex.sessionId ?? null,
              },
            );
          }

          if (action === "stop") {
            const key = normalizeSessionKey(sessionKey);
            const session = getActive(sessionKey);
            if (!session) {
              return textResult("No active Codex PTY for this chat.", { ok: true, action: "stop", existed: false });
            }
            try {
              session.pty.kill("SIGTERM");
            } catch {
              // ignore
            }
            clearTimers(session);
            sessions.delete(key);
            return textResult("Stopped active Codex PTY session.", { ok: true, action: "stop", existed: true });
          }

          if (action === "status") {
            const res = await actionStatus({
              sessionKey: normalizedSessionKey,
              agentId,
              agentRootDir,
              outputLines: 20,
              outputMaxChars: 5000,
              drain: false,
            });
            const text =
              res.output && String(res.output).trim()
                ? `Status: ${res.status}${res.codexSessionId ? `\nSession: ${res.codexSessionId}` : ""}\n\n${res.output}`
                : `Status: ${res.status}${res.codexSessionId ? `\nSession: ${res.codexSessionId}` : ""}`;
            return textResult(text, res);
          }

          if (action === "send") {
            let message = String(args?.message ?? "").trim();
            if (!message) {
              return textResult("Missing message. Example: /askcodex <prompt>", {
                ok: false,
                error: "missing_message",
              });
            }

            // Persist delivery hint so delivery can always route back.
            const { record, recordPath } = await loadOrInitRecord({ agentId, agentRootDir, sessionKey: normalizedSessionKey });
            const delivery =
              normalizeDeliveryHintForSessionKey(record.delivery ?? null, sessionKey) ??
              inferDeliveryHintFromSessionKey(sessionKey);
            if (delivery) {
              record.delivery = delivery as any;
            }

            // Discord UX: keep a durable in-channel prompt history, so the prompt doesn't get lost
            // when Discord clears/deletes ephemeral interaction responses.
            if (
              delivery?.channel === "discord" &&
              typeof delivery.to === "string" &&
              /^channel:\d+$/.test(delivery.to)
            ) {
              void (async () => {
                try {
                  await deliverBestEffortOutboundText({
                    channel: delivery.channel,
                    to: delivery.to,
                    accountId: delivery.accountId,
                    threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
                    text: `🧾 /askcodex prompt:\n=========\n${truncateForPromptLog(message)}\n=========`,
                  });
                } catch {
                  // Best-effort only.
                }
              })();
            }

            // Ensure we have a running PTY session for this chat.
            const session = await ensureActivePty({
              sessionKey: normalizedSessionKey,
              agentId,
              agentRootDir,
              cwd: await resolveSessionWorkdir({ record, explicitCwd }),
              quietMs,
            });

            // If Codex is currently running a turn, we don't (yet) support queueing.
            if (session.pendingTurnId || session.record.pending?.turnId) {
              return textResult(
                "Codex is busy with a previous request. Wait for it to finish, then retry.",
                { ok: false, action: "send", error: "busy" },
              );
            }

            // Discover session id + session file (filesystem scan). This should now work reliably
            // because we also answer additional terminal queries (DA/OSC) that Codex expects.
            await ensureCodexJsonlReady(session);
            await probeCodexSessionIdFromFilesystem(session);

            // Snapshot JSONL offset so we only read the assistant message for this turn.
            await ensureCodexJsonlReady(session);
            await refreshJsonlOffsetAtSend(session);

            // Persist record updates (delivery + session info).
            record.codex.sessionId = session.record.codex.sessionId;
            record.codex.sessionFile = session.record.codex.sessionFile;
            record.updatedAt = nowMs();

            const turnId = crypto.randomUUID();
            const sentAt = nowMs();
            const pendingMode = "jsonl";
            const pendingSnapshot = normalizePendingTurn(
              normalizedSessionKey,
              {
                turnId,
                mode: pendingMode,
                sentAt,
                jsonlOffset: session.pendingJsonlOffset,
                quietMs: session.quietMs,
                deliveryKey: computePendingDeliveryKey(normalizedSessionKey, turnId),
                retryCount: 0,
              },
              session.quietMs,
            )!;
            session.pendingTurnId = turnId;
            session.pendingSentAt = pendingSnapshot.sentAt;
            session.pendingMode = pendingSnapshot.mode;
            session.pendingJsonlOffset = pendingSnapshot.jsonlOffset;
            session.record.pending = pendingSnapshot;
            record.pending = pendingSnapshot;
            record.updatedAt = nowMs();
            await writeJsonAtomicLocked(recordPath, record);
            scheduleQuietTimer(session, turnId);

            // Submit the prompt interactively.
            // Codex enables bracketed paste mode; using it makes input more reliable.
            const promptToSend = applyOperationalGuardToPrompt(message, action);
            try {
              session.pty.write("\x1b[200~");
              session.pty.write(promptToSend);
              session.pty.write("\x1b[201~");
              session.pty.write("\r");
            } catch (err) {
              clearPendingTurnRuntime(session);
              session.record.pending = undefined;
              record.pending = undefined;
              record.lastError = `askcodex: PTY write failed: ${String(err)}`;
              record.updatedAt = nowMs();
              await writeJsonAtomicLocked(recordPath, record);
              return textResult(`Failed to send input to Codex PTY: ${String(err)}`, { ok: false, error: "write_failed" });
            }

            return textResult(
              `Sent to Codex. I’ll post the result when it goes quiet.\n${session.record.codex.sessionId ? `Session: ${session.record.codex.sessionId}` : ""}`.trim(),
              {
                ok: true,
                action: "send",
                mode: "pty-interactive",
                pid: session.pty.pid,
                codexSessionId: session.record.codex.sessionId ?? null,
                turnId,
                messagePreview: safePreview(message),
              },
            );
          }

          return jsonResult({ ok: false, error: `Unknown action: ${action}` });
        },
      };
    });
  },
};
