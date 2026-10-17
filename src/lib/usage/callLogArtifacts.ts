import fs from "node:fs";
import path from "node:path";
import type { RequestPipelinePayloads } from "@omniroute/open-sse/utils/requestLogger.ts";
import { resolveDataDir } from "../dataPaths";
import { getCallLogPipelineMaxSizeBytes, isChatDebugFileEnabled } from "../logEnv";
import {
  CALL_LOG_SIZE_LIMIT_REASON as SIZE_LIMIT_EXCEEDED_REASON,
  CALL_LOG_BODY_OMITTED_FOR_SIZE_LIMIT as OMITTED_FOR_SIZE_LIMIT,
  CALL_LOG_STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT as STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT,
  isSizeLimitOmissionMarker,
} from "@/shared/constants/callLogSizeLimitMarkers";

const isCloud = typeof globalThis.caches === "object" && globalThis.caches !== null;
const isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" || process.env.OMNIROUTE_BUILDING === "1";
const DATA_DIR = resolveDataDir({ isCloud });

export const CALL_LOGS_DIR = isCloud ? null : path.join(DATA_DIR, "call_logs");
// #91: the cap used to be a hardcoded 512KB with no override. Claude-Code-style
// clients resend the whole session every turn, so the heaviest requests sail
// past it every time and the size-limit fallback replaced BOTH bodies with a
// single OMITTED marker — the rows where triage most needs the exchange
// (long agentic sessions are also where the exotic failures live) were left
// with zero diagnostic material. Default stays 512KB for upstream parity;
// OMNIROUTE_CALL_LOG_ARTIFACT_MAX_KB raises it without a rebuild (capped at
// 16MB so a typo cannot silently turn call_logs into a disk-eater), and the
// messages-tail stage below keeps the newest turns even when the cap trips.
function getMaxCallLogArtifactBytes(): number {
  const kb = Number.parseInt(process.env.OMNIROUTE_CALL_LOG_ARTIFACT_MAX_KB ?? "", 10);
  return Number.isFinite(kb) && kb > 0
    ? Math.min(kb, 16 * 1024) * 1024
    : MAX_CALL_LOG_ARTIFACT_BYTES;
}
export const MAX_CALL_LOG_ARTIFACT_BYTES = 512 * 1024;

// Re-exported for backward compatibility: consumers (completedRequestDetails.ts)
// import this marker check from here. Definition now lives in the shared
// constants module so the client-side detail view can use the exact same check
// without importing this fs/path-dependent, server-only module (see #13894).
export { isSizeLimitOmissionMarker };

// The error is the only field that says *why* a request failed, and it is
// typically ~90 bytes next to the multi-hundred-KB bodies that trip the cap.
// Dropping it made a size-limited row undiagnosable: a provider outage, a local
// timeout and an upstream 400 all rendered as the same omission marker. It is
// kept at every fallback stage instead, truncated rather than discarded.
const MAX_PRESERVED_ERROR_BYTES = 4 * 1024;
const ERROR_TRUNCATED_FOR_SIZE_LIMIT = "[truncated: call log artifact size limit exceeded]";

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  // Cut back off a partial multi-byte sequence so the tail is not a U+FFFD.
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Keep the error through a size-limit fallback, truncating it if it is itself
 * large. Returns the value unchanged when it already fits, so a normal-sized
 * error is byte-identical to what a non-truncated artifact would carry.
 */
function preserveErrorForSizeLimit(error: unknown): unknown {
  if (error === null || error === undefined) return null;
  let serialized: string;
  try {
    serialized = typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    // A circular or unserializable error must not take the whole artifact down.
    serialized = String(error);
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PRESERVED_ERROR_BYTES) return error;
  return `${truncateUtf8(serialized, MAX_PRESERVED_ERROR_BYTES)} ${ERROR_TRUNCATED_FOR_SIZE_LIMIT}`;
}

export type CallLogDetailState = "none" | "ready" | "missing" | "corrupt" | "legacy-inline";

export type CallLogArtifact = {
  schemaVersion: 5;
  summary: {
    id: string;
    timestamp: string;
    method: string;
    path: string;
    status: number;
    model: string;
    requestedModel: string | null;
    provider: string;
    account: string;
    connectionId: string | null;
    duration: number;
    tokens: {
      in: number;
      out: number;
      cacheRead: number | null;
      cacheWrite: number | null;
      reasoning: number | null;
      compressed: number | null;
    };
    requestType: string | null;
    sourceFormat: string | null;
    targetFormat: string | null;
    apiKeyId: string | null;
    apiKeyName: string | null;
    comboName: string | null;
    comboStepId: string | null;
    comboExecutionKey: string | null;
  };
  requestBody: unknown;
  responseBody: unknown;
  error: unknown;
  pipeline?: RequestPipelinePayloads;
};

export type CallLogArtifactWriteResult = {
  relPath: string;
  sizeBytes: number;
  sha256: string;
};

export type PurgeCallLogArtifactDirectoryResult = {
  deletedArtifacts: number;
  errors: number;
};

export function buildArtifactRelativePath(timestamp: string, id: string) {
  const parsed = new Date(timestamp);
  const safeTimestamp = (
    Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
  ).replace(/[:]/g, "-");
  const dateFolder = safeTimestamp.slice(0, 10);
  return path.posix.join(dateFolder, `${safeTimestamp}_${id}.json`);
}

function computeArtifactChecksum(serialized: string): string {
  const bytes = Buffer.from(serialized);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function truncateArtifactForStorage(artifact: CallLogArtifact): CallLogArtifact {
  const pipeline = artifact.pipeline;
  if (!pipeline?.streamChunks) return artifact;

  return {
    ...artifact,
    pipeline: {
      ...pipeline,
      streamChunks: {
        provider: pipeline.streamChunks.provider?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : undefined,
        openai: pipeline.streamChunks.openai?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : undefined,
        client: pipeline.streamChunks.client?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : undefined,
      },
    },
  };
}

function omitOversizedPipeline(artifact: CallLogArtifact): CallLogArtifact {
  if (!artifact.pipeline) return artifact;

  return {
    ...artifact,
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason: SIZE_LIMIT_EXCEEDED_REASON,
      },
    },
  };
}

// Test-only export: the real byte budget for an artifact, so budget
// assertions measure against the same cap the ladder enforces instead of a
// hardcoded byte count.
export function getArtifactMaxBytesForTest(artifact: CallLogArtifact): number {
  return getArtifactMaxBytes(artifact);
}

function getArtifactMaxBytes(artifact: CallLogArtifact): number {
  return artifact.pipeline ? getCallLogPipelineMaxSizeBytes() : getMaxCallLogArtifactBytes();
}

// #91: messages-tail retention for oversized chat bodies. Claude-Code-style
// clients resend the full session every turn, so a >512KB body means "a long
// conversation", not "a pathological prompt". The omission stages would drop
// the entire exchange; instead keep the newest N messages (each individually
// shrunk to a byte budget) so the last turns of the exchange — the part a
// triaging engineer needs — survive. Head items are replaced by a marker
// object on messages[0] — the same convention truncateForLog uses for arrays.
// #92: a fixed 20-message window misses the newest human turn in real agentic
// traffic — measured on production, 42% of >400KB sessions carry their last
// human input >60 messages from the end (agent tool-call trains run long).
// The window now extends backwards from the tail until the newest
// non-tool-result user message is included (capped), and tool-result turns
// inside the window get a much smaller byte budget than human-authored text
// (measured p50 0.7KB / p90 6.8KB vs 1KB/24KB) so the extension stays inside
// the same 512KB artifact cap.
const TAIL_MESSAGES_MAX = 20;
const TAIL_MESSAGES_HUNT_LIMIT = 150;
const TAIL_MESSAGE_TEXT_BYTES = 8 * 1024;
const TAIL_TOOL_RESULT_TEXT_BYTES = 256;

function shrinkStringTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n[truncated: call log size limit]";
  const budget = maxBytes - Buffer.byteLength(marker, "utf8");
  // Byte-slice from the tail, then trim a possibly split multi-byte sequence.
  const sliced = Buffer.from(text, "utf8").subarray(-budget).toString("utf8");
  const cleanStart = sliced.indexOf(sliced.trimStart()[0] ?? "");
  return `${sliced.slice(cleanStart >= 0 ? cleanStart : 0)}${marker}`;
}

// A user-role message that only carries machine-generated context — not a
// human turn. Two shapes: native tool_result parts, and the gateway-translated
// form where the pipeline has already flattened tool_result parts into plain
// text parts (what lands in call_logs is the translated intermediate, not the
// client's original). A >2KB user turn is bulk context by the measured
// distribution (human inputs: p50 1KB / p90 24KB, and the p90 tail is mostly
// pasted documents, not typing) — treat it as machine context for budgeting.
const MACHINE_CONTEXT_TURN_BYTES = 2 * 1024;

function isToolResultOnlyUserMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  if (content === undefined) return false;
  const s = JSON.stringify(content);
  // nnd.35 #101: match markers that actually EXIST in the pipeline — the #92
  // spelling (<toolcall_result>/<toolcall_status>) has zero producers in this
  // repo (deep-hunt T1-F4), so sub-2KB translated tool turns fell through to
  // the human-input branch. Real markers: <tool_result> (kimiToolCallNarration
  // / cursor narration), the "Tool result (" line form, and tool_use_id for
  // flattened native shapes.
  if (
    s.includes('"tool_result"') ||
    s.includes('"tool_use_id"') ||
    s.includes("<tool_result>") ||
    s.includes("Tool result (")
  ) {
    return true;
  }
  {
    // Translated form: text-only parts whose payload dwarfs human typing.
    const parts = Array.isArray(content) ? content : [content];
    const textOnly = parts.every(
      (p) => !p || typeof p !== "object" || (p as { type?: string }).type === "text"
    );
    if (textOnly && Buffer.byteLength(s, "utf8") > MACHINE_CONTEXT_TURN_BYTES) return true;
  }
  return false;
}

// The newest human-authored user message index, searched from the tail.
function findLastHumanInputIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string } | null;
    if (!m || m.role !== "user") continue;
    if (isToolResultOnlyUserMessage(m)) continue;
    return i;
  }
  return -1;
}

function shrinkMessageContentPart(part: unknown, textBudget: number): unknown {
  if (!part || typeof part !== "object") return part;
  const record = part as { text?: unknown; content?: unknown };
  // tool_result parts carry their payload in `content` (string or parts[]),
  // text parts in `text` — shrink whichever is a big string.
  if (typeof record.text === "string") {
    return { ...record, text: shrinkStringTail(record.text, textBudget) };
  }
  if (typeof record.content === "string") {
    return { ...record, content: shrinkStringTail(record.content, textBudget) };
  }
  if (Array.isArray(record.content)) {
    return {
      ...record,
      content: record.content.map((p) => shrinkMessageContentPart(p, textBudget)),
    };
  }
  return part;
}

function shrinkMessage(message: unknown, textBudget = TAIL_MESSAGE_TEXT_BYTES): unknown {
  if (!message || typeof message !== "object") return message;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return { ...(message as object), content: shrinkStringTail(content, textBudget) };
  }
  if (Array.isArray(content)) {
    return {
      ...(message as object),
      content: content.map((p) => shrinkMessageContentPart(p, textBudget)),
    };
  }
  return message;
}

function buildMessagesTailArtifactForSizeLimit(artifact: CallLogArtifact) {
  const body = artifact.requestBody;
  const messages =
    body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)
      ? (body as { messages: unknown[] }).messages
      : null;
  if (!messages?.length) return null;

  // #92: window = last TAIL_MESSAGES_MAX turns, extended backwards until the
  // newest human input is inside it (or the hunt limit is hit). Tool-result
  // turns inside the window get the small budget — they are bulk, machine-
  // generated context; human turns keep the full-text budget.
  const lastHumanIdx = findLastHumanInputIndex(messages);
  let start = Math.max(0, messages.length - TAIL_MESSAGES_MAX);
  if (lastHumanIdx >= 0) {
    start = Math.min(start, Math.max(0, lastHumanIdx - 2));
    start = Math.max(start, messages.length - TAIL_MESSAGES_HUNT_LIMIT);
  }
  const tail = messages
    .slice(start)
    .map((m) =>
      shrinkMessage(
        m,
        isToolResultOnlyUserMessage(m) ? TAIL_TOOL_RESULT_TEXT_BYTES : TAIL_MESSAGE_TEXT_BYTES
      )
    );
  const requestBody: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
    messages: tail,
  };
  if (start > 0) {
    // Length-only marker object on the first retained slot, matching the
    // `_omniroute_truncated_array` convention readers already look for.
    requestBody.messages = [
      { _omniroute_truncated_array: true, originalLength: messages.length },
      ...tail,
    ];
  }

  return {
    ...omitOversizedPipeline(artifact),
    requestBody,
    // The response of a long-session turn is small next to the request; give it
    // the same tail treatment only if it is itself a string that trips the cap.
    responseBody:
      typeof artifact.responseBody === "string"
        ? shrinkStringTail(artifact.responseBody, TAIL_MESSAGE_TEXT_BYTES * 2)
        : artifact.responseBody,
    error: preserveErrorForSizeLimit(artifact.error),
  };
}

/**
 * Fallback ladder for an artifact that does not fit its byte budget, ordered
 * from "keeps the most" to "keeps the least": the first stage that fits wins.
 *
 * Ordering rule: drop the payload that most plausibly tripped the cap, and
 * drop a payload that is *duplicated elsewhere in the artifact* before one
 * that is unique. `pipeline` carries both sides of the exchange already
 * translated (`clientRawRequest`/`providerRequest`/`providerResponse`/
 * `clientResponse`), so evicting it to keep `requestBody` traded the whole
 * upstream exchange -- including the only record of what the provider
 * actually answered -- for a raw client prompt the pipeline already holds a
 * translated copy of. The request body goes first on its own now (it is the
 * usual cap-tripper and the least diagnostic side), then both bodies, and
 * `pipeline` survives one stage longer; the previous order is still reached
 * when dropping the request body alone is not enough.
 *
 * Two consumers depend on that ordering, not just human diagnosis:
 * `resolvePreviousResponseState` (db/responsesContinuationStore.ts) rebuilds
 * `previous_response_id` history from `pipeline.clientRawRequest` /
 * `pipeline.clientResponse` and returns null -- forcing the client to resend
 * full history -- for any artifact whose pipeline was omitted; and
 * `maybeEnrichCompletedDetail` (usage/completedRequestDetails.ts) reads
 * `pipeline.providerResponse` in preference to `responseBody`.
 */
function buildMinimalArtifactForSizeLimit(artifact: CallLogArtifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    summary: artifact.summary,
    requestBody: OMITTED_FOR_SIZE_LIMIT,
    responseBody: OMITTED_FOR_SIZE_LIMIT,
    // Never drop the error: it is the only field that says WHY the request
    // failed (e.g. "Fetch timeout after 110000ms on https://..."). Diagnosing
    // provider outages from a log row that shows only an omission marker is
    // impossible; the error string is tiny next to the request/response bodies.
    error: preserveErrorForSizeLimit(artifact.error),
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason: SIZE_LIMIT_EXCEEDED_REASON,
      },
    },
  };
}

function buildSizeLimitStages(artifact: CallLogArtifact): Array<() => unknown> {
  // One parametrized helper for both body-omission stages: request-only keeps
  // the response verbatim, both-bodies drops it too. Single spread + single
  // error-preservation call, so the two stages cannot drift apart.
  const omitBodies = <T extends object>(value: T, keepResponse = false) => ({
    ...value,
    requestBody: OMITTED_FOR_SIZE_LIMIT,
    responseBody: keepResponse
      ? (value as { responseBody: unknown }).responseBody
      : OMITTED_FOR_SIZE_LIMIT,
    error: preserveErrorForSizeLimit(artifact.error),
  });

  return [
    () => truncateArtifactForStorage(artifact),
    // Request body alone: the usual cap-tripper (multi-hundred-KB client
    // prompts) and the least diagnostic once the pipeline holds a translated
    // copy of it. Worth a stage only when there is a pipeline to keep in
    // exchange -- without one it produces the same bytes as a later stage, so
    // it is left out rather than costing a redundant stringify.
    ...(artifact.pipeline ? [() => omitBodies(artifact, true)] : []),
    // Bodies alone: worth a stage only when there is a pipeline to keep in
    // exchange. Without one it produces the same bytes as the stage two lines
    // below, so it is left out rather than costing a redundant stringify.
    ...(artifact.pipeline ? [() => omitBodies(artifact)] : []),
    () => omitOversizedPipeline(artifact),
    // #91: before giving up on the bodies entirely, try keeping the newest
    // messages of a chat body. Long Claude-Code sessions were the shape that
    // made the omission stages lose whole conversations.
    () => buildMessagesTailArtifactForSizeLimit(artifact) ?? omitOversizedPipeline(artifact),
    () => omitBodies(omitOversizedPipeline(artifact)),
    // The summary alone exceeded the cap (pathological). Keep the error so the
    // row stays diagnosable, drop everything else including the summary body.
    () => buildMinimalArtifactForSizeLimit(artifact),
  ];
}

function serializeArtifactForStorage(artifact: CallLogArtifact): string {
  // Debug mode: write full untruncated payload
  if (isChatDebugFileEnabled()) {
    return JSON.stringify(artifact, null, 2);
  }

  const maxBytes = getArtifactMaxBytes(artifact);
  // Single-pass, non-pretty serialization on the hot path. Artifacts are machine-read via
  // JSON.parse (readCallArtifact), so pretty-printing only doubled the bytes and CPU of
  // serializing large request/response bodies on every request — a contributor to the
  // CPU-runaway. The debug path above keeps pretty output for human inspection.
  const serialized = JSON.stringify(artifact);
  if (Buffer.byteLength(serialized) <= maxBytes) {
    return serialized;
  }

  for (const buildStage of buildSizeLimitStages(artifact)) {
    const candidate = JSON.stringify(buildStage());
    if (Buffer.byteLength(candidate) <= maxBytes) {
      return candidate;
    }
  }

  // Last resort: not even the summary fit. The error still rides along --
  // without it this row says only "something was too big", which is the state
  // the size-limit fallbacks exist to remove.
  return JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    _omniroute_truncated: true,
    reason: SIZE_LIMIT_EXCEEDED_REASON,
    error: preserveErrorForSizeLimit(artifact.error),
  });
}

export function writeCallArtifact(
  artifact: CallLogArtifact,
  relativePath = buildArtifactRelativePath(artifact.summary.timestamp, artifact.summary.id)
): CallLogArtifactWriteResult | null {
  if (!CALL_LOGS_DIR || isBuildPhase) return null;

  const absPath = path.join(CALL_LOGS_DIR, relativePath);
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    const serialized = serializeArtifactForStorage(artifact);
    const sizeBytes = Buffer.byteLength(serialized);
    // Keep the legacy field name for storage compatibility, but use a non-cryptographic checksum
    // so artifact bookkeeping is not treated as password hashing by static analysis.
    const fileChecksum = computeArtifactChecksum(serialized);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(tmpPath, serialized);
    fs.renameSync(tmpPath, absPath);

    return {
      relPath: relativePath,
      sizeBytes,
      sha256: fileChecksum,
    };
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    console.error("[callLogs] Failed to write request artifact:", (error as Error).message);
    return null;
  }
}

export function readCallArtifact(relativePath: string | null): {
  artifact: CallLogArtifact | null;
  state: "ready" | "missing" | "corrupt";
} {
  if (!CALL_LOGS_DIR || !relativePath) {
    return { artifact: null, state: "missing" };
  }

  try {
    const absPath = path.join(CALL_LOGS_DIR, relativePath);
    if (!fs.existsSync(absPath)) {
      return { artifact: null, state: "missing" };
    }
    return {
      artifact: JSON.parse(fs.readFileSync(absPath, "utf8")) as CallLogArtifact,
      state: "ready",
    };
  } catch (error) {
    console.error("[callLogs] Failed to read request artifact:", (error as Error).message);
    return { artifact: null, state: "corrupt" };
  }
}

export function deleteCallArtifact(relativePath: string | null, baseDir = CALL_LOGS_DIR): boolean {
  if (!baseDir || !relativePath) return false;

  try {
    const resolvedBaseDir = path.resolve(baseDir);
    const absPath = path.join(resolvedBaseDir, relativePath);
    if (!fs.existsSync(absPath)) return false;
    fs.rmSync(absPath, { force: true });
    const parentDir = path.dirname(absPath);
    if (parentDir !== resolvedBaseDir) {
      try {
        fs.rmdirSync(parentDir);
      } catch {
        // Directory is non-empty or already gone.
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function cleanupEmptyCallLogDirs(baseDir = CALL_LOGS_DIR) {
  if (!baseDir || !fs.existsSync(baseDir)) return;

  try {
    for (const entry of fs.readdirSync(baseDir)) {
      const entryPath = path.join(baseDir, entry);
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;
      if (fs.readdirSync(entryPath).length === 0) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Best effort only.
  }
}

export function listCallLogArtifactFiles(baseDir = CALL_LOGS_DIR) {
  if (!baseDir || !fs.existsSync(baseDir)) return [];

  return fs
    .readdirSync(baseDir)
    .flatMap((entry) => {
      const entryPath = path.join(baseDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) return [];

        return fs
          .readdirSync(entryPath)
          .filter((file) => file.endsWith(".json"))
          .map((file) => {
            const absPath = path.join(entryPath, file);
            const fileStat = fs.statSync(absPath);
            return {
              relativePath: path.posix.join(entry, file),
              absPath,
              mtimeMs: fileStat.mtimeMs,
            };
          });
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function purgeCallLogArtifactDirectory(
  baseDir = CALL_LOGS_DIR
): PurgeCallLogArtifactDirectoryResult {
  const result = { deletedArtifacts: 0, errors: 0 };
  if (!baseDir || !fs.existsSync(baseDir)) return result;

  try {
    result.deletedArtifacts = listCallLogArtifactFiles(baseDir).length;
  } catch {
    result.deletedArtifacts = 0;
  }

  try {
    fs.rmSync(baseDir, { recursive: true, force: true });
  } catch (error) {
    console.error("[callLogArtifacts] Failed to purge call log artifacts:", error);
    result.deletedArtifacts = 0;
    result.errors++;
  }

  return result;
}
