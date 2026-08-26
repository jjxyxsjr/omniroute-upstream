/**
 * arkQuotaFetcher.ts — Volcengine Ark Coding/Agent Plan quota fetcher (012).
 *
 * Implements QuotaFetcher for Ark subscription connections (custom
 * anthropic-compatible nodes pointing at ark.cn-beijing.volces.com/api/coding
 * or /api/plan). Upstream has no built-in Ark subscription provider — the only
 * volcengine/doubao registry entries target the pay-as-you-go /api/v3 endpoint
 * — so the fork carries this fetcher (deploy docs/135 §6, spec validated live
 * 2026-08-26).
 *
 * Control plane: POST https://open.volcengineapi.com/?Action=…&Version=2024-01-01
 * with Volcengine Signature V4 (AWS SigV4 variant — see buildVolcSignatureHeaders
 * for the four deliberate differences). Bearer API keys are rejected at the
 * header-format layer, so the IAM AK/SK pair is required; it lives in the
 * connection's providerSpecificData (arkAccessKeyId / arkSecretAccessKey,
 * optionally enc:v1-encrypted at rest with STORAGE_ENCRYPTION_KEY) or in the
 * VOLC_ARK_ACCESS_KEY_ID / VOLC_ARK_SECRET_ACCESS_KEY env fallback.
 *
 * Two APIs, probed by the connection's baseUrl:
 *   - /api/coding → GetCodingPlanUsage first (session/weekly/monthly Percent,
 *     ResetTimestamp in SECONDS — live shape 2026-08-26)
 *   - /api/plan   → GetAFPUsage first (AFPFiveHour/AFPWeekly/AFPMonthly with
 *     absolute Quota/Used and ResetTime in MS; AFPDaily is a hidden default and
 *     is ignored; Quota<=0 windows mean "not subscribed" and are skipped)
 *
 * The returned QuotaInfo mirrors bailianQuotaFetcher's triple-window shape:
 * top-level window5h / windowWeekly / windowMonthly (what
 * scoreResetAwareQuota reads) PLUS the windows map (dashboard window names).
 * percentUsed is the worst window, as a 0-1 fraction. A 60s in-memory cache
 * keeps the control plane out of the hot path; failures return null so
 * reset-aware falls back to the OMNIROUTE_RESET_AWARE_NO_QUOTA_FLOOR dial.
 */

import { createHmac, createHash, createDecipheriv, scryptSync } from "crypto";
import {
  registerQuotaFetcher,
  registerQuotaWindows,
  type QuotaInfo,
} from "./quotaPreflight.ts";

const VOLC_OPENAPI_HOST = "open.volcengineapi.com";
const VOLC_API_VERSION = "2024-01-01";
const VOLC_DEFAULT_REGION = "cn-beijing";
const VOLC_SERVICE = "ark";
const VOLC_CONTENT_TYPE = "application/json; charset=utf-8";
const VOLC_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";
const CACHE_TTL_MS = 60_000;

export const ARK_WINDOW_5H = "window_5h";
export const ARK_WINDOW_WEEKLY = "window_weekly";
export const ARK_WINDOW_MONTHLY = "window_monthly";

/** Our production Ark node — the fork's default registration target. */
const DEFAULT_ARK_QUOTA_PROVIDERS = [
  "anthropic-compatible-d70a9997-f802-49b6-92fc-92a60a018fc2",
];

interface WindowSnapshot {
  percentUsed: number;
  resetAt: string | null;
}

interface ArkPlanQuota extends QuotaInfo {
  windows: Record<string, WindowSnapshot>;
  window5h: WindowSnapshot;
  windowWeekly: WindowSnapshot;
  windowMonthly: WindowSnapshot;
}

// ─── Volcengine Signature V4 (pure, testable) ────────────────────────────────

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: string): string => createHash("sha256").update(data).digest("hex");

/** RFC3986-unreserved-only percent encoding for canonical query values. */
function volcUriEncode(input: string): string {
  let out = "";
  for (const byte of Buffer.from(input, "utf8")) {
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e // - _ . ~
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function buildVolcSignatureHeaders({
  accessKeyId,
  secretAccessKey,
  action,
  region = VOLC_DEFAULT_REGION,
  now = new Date(),
}: {
  accessKeyId: string;
  secretAccessKey: string;
  action: string;
  region?: string;
  now?: Date;
}): { authorization: string; xDate: string; query: string; contentSha256: string } {
  // Alphabetical by key (Action < Region < Version); the same string signs and ships.
  const query = `Action=${volcUriEncode(action)}&Region=${volcUriEncode(region)}&Version=${volcUriEncode(VOLC_API_VERSION)}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const xDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const shortDate = xDate.slice(0, 8);
  const contentSha256 = sha256Hex("");

  // Volcengine quirk #1: canonical headers use a FIXED order (not alphabetical).
  const canonicalHeaders =
    `host:${VOLC_OPENAPI_HOST}\nx-date:${xDate}\nx-content-sha256:${contentSha256}\ncontent-type:${VOLC_CONTENT_TYPE}\n`;
  const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${VOLC_SIGNED_HEADERS}\n${contentSha256}`;

  // Quirks #2-#4: algorithm without AWS4 prefix, scope terminator `request`,
  // kDate = HMAC(SK, date) with NO "AWS4" prefix on the secret.
  const scope = `${shortDate}/${region}/${VOLC_SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const kDate = hmac(secretAccessKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, VOLC_SERVICE);
  const kSigning = hmac(kService, "request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    authorization:
      `HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${VOLC_SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    query,
    contentSha256,
  };
}

// ─── Response parsing (pure, fixtures = live captures 2026-08-26) ────────────

const toFraction = (percent: unknown): number | null => {
  const n = typeof percent === "number" && Number.isFinite(percent) ? percent : Number(percent);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
};

const secondsToIso = (value: unknown): string | null => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};

function worstWindow(windows: Array<WindowSnapshot | null>): { percent: number; resetAt: string | null } {
  let percent = 0;
  let resetAt: string | null = null;
  for (const w of windows) {
    if (w && w.percentUsed > percent) {
      percent = w.percentUsed;
      resetAt = w.resetAt;
    }
  }
  return { percent, resetAt };
}

function assemble(window5h: WindowSnapshot, weekly: WindowSnapshot, monthly: WindowSnapshot): ArkPlanQuota {
  const worst = worstWindow([window5h, weekly, monthly]);
  return {
    used: Math.round(worst.percent * 100),
    total: 100,
    percentUsed: worst.percent,
    resetAt: worst.resetAt,
    windows: {
      [ARK_WINDOW_5H]: window5h,
      [ARK_WINDOW_WEEKLY]: weekly,
      [ARK_WINDOW_MONTHLY]: monthly,
    },
    window5h,
    windowWeekly: weekly,
    windowMonthly: monthly,
  };
}

/**
 * GetCodingPlanUsage → ArkPlanQuota. Live shape (2026-08-26):
 * Result.Status="Running", QuotaUsage=[{Level:"session"|"weekly"|"monthly",
 * Percent:<0-100>, ResetTimestamp:<SECONDS>}, …]. Returns null when the plan
 * is not running or reports no usable windows (caller falls through to the
 * GetAFPUsage probe).
 */
export function parseCodingPlanUsage(body: unknown): ArkPlanQuota | null {
  if (!body || typeof body !== "object") return null;
  const result = (body as { Result?: unknown }).Result;
  if (!result || typeof result !== "object") return null;
  const { Status, QuotaUsage } = result as { Status?: unknown; QuotaUsage?: unknown };
  if (Status !== "Running" || !Array.isArray(QuotaUsage) || QuotaUsage.length === 0) return null;

  const pct = (fallback: number) => ({ percentUsed: fallback, resetAt: null });
  let five = pct(0);
  let weekly = pct(0);
  let monthly = pct(0);
  let seen = 0;
  for (const item of QuotaUsage) {
    if (!item || typeof item !== "object") continue;
    const level = String((item as { Level?: unknown }).Level ?? "").toLowerCase();
    const percent = toFraction((item as { Percent?: unknown }).Percent);
    if (percent === null) continue;
    const resetAt = secondsToIso((item as { ResetTimestamp?: unknown }).ResetTimestamp);
    const snap = { percentUsed: percent, resetAt };
    if (level === "session" || level === "5h" || level === "five_hour") {
      five = snap;
      seen++;
    } else if (level === "weekly" || level === "week" || level === "7d") {
      weekly = snap;
      seen++;
    } else if (level === "monthly" || level === "month") {
      monthly = snap;
      seen++;
    }
  }
  if (seen === 0) return null;
  return assemble(five, weekly, monthly);
}

/**
 * GetAFPUsage → ArkPlanQuota. Live shape (2026-08-26):
 * Result.{AFPFiveHour,AFPWeekly,AFPMonthly} = {Quota, Used, ResetTime<MS>}.
 * AFPDaily is hidden in the official console (historical default above the
 * weekly cap) and ignored here; Quota<=0 means the window is not subscribed.
 */
export function parseAfpUsage(body: unknown): ArkPlanQuota | null {
  if (!body || typeof body !== "object") return null;
  const result = (body as { Result?: unknown }).Result;
  if (!result || typeof result !== "object") return null;
  const rec = result as Record<string, unknown>;

  const window = (key: string): WindowSnapshot | null => {
    const w = rec[key];
    if (!w || typeof w !== "object") return null;
    const quota = Number((w as { Quota?: unknown }).Quota);
    const used = Number((w as { Used?: unknown }).Used);
    if (!Number.isFinite(quota) || quota <= 0) return null;
    const fraction = Number.isFinite(used) ? Math.min(1, Math.max(0, used / quota)) : 0;
    const resetMs = Number((w as { ResetTime?: unknown }).ResetTime);
    return {
      percentUsed: fraction,
      resetAt: Number.isFinite(resetMs) && resetMs > 0 ? new Date(resetMs).toISOString() : null,
    };
  };

  const five = window("AFPFiveHour");
  const weekly = window("AFPWeekly");
  const monthly = window("AFPMonthly");
  if (!five && !weekly && !monthly) return null;
  return assemble(five ?? { percentUsed: 0, resetAt: null }, weekly ?? { percentUsed: 0, resetAt: null }, monthly ?? { percentUsed: 0, resetAt: null });
}

// ─── Credentials (providerSpecificData first, env fallback) ──────────────────

/**
 * Raw credential lookup — returns the stored values verbatim (plain OR
 * enc:v1-prefixed). Decryption happens in decryptArkCredential so the pure
 * parser tests stay free of the encryption key dependency.
 */
export function resolveArkPlanCredentials(
  connection: Record<string, unknown> | null | undefined
): { accessKeyId: string; secretAccessKey: string } | null {
  const psd = connection?.providerSpecificData;
  const rec =
    typeof psd === "string"
      ? (() => {
          try {
            return JSON.parse(psd);
          } catch {
            return null;
          }
        })()
      : psd;
  if (!rec || typeof rec !== "object") return null;
  const id = (rec as Record<string, unknown>).arkAccessKeyId;
  const secret = (rec as Record<string, unknown>).arkSecretAccessKey;
  const accessKeyId =
    typeof id === "string" && id.trim() ? id.trim() : process.env.VOLC_ARK_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey =
    typeof secret === "string" && secret.trim()
      ? secret.trim()
      : process.env.VOLC_ARK_SECRET_ACCESS_KEY?.trim() || "";
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
}

/** Decrypt enc:v1 field-encryption blobs (hex segments, static salt). */
function decryptArkCredential(value: string): string | null {
  if (!value.startsWith("enc:v1:")) return value;
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret) return null;
  try {
    const [, , ivHex, ctHex, tagHex] = value.split(":");
    const key = scryptSync(secret, "omniroute-field-encryption-v1", 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

// ─── Fetcher + registration ───────────────────────────────────────────────────

const quotaCache = new Map<string, { fetchedAt: number; quota: ArkPlanQuota }>();

async function callArkControlPlane(
  action: string,
  creds: { accessKeyId: string; secretAccessKey: string }
): Promise<{ ok: boolean; body: unknown }> {
  const sig = buildVolcSignatureHeaders({ ...creds, action });
  try {
    const resp = await fetch(`https://${VOLC_OPENAPI_HOST}/?${sig.query}`, {
      method: "POST",
      headers: {
        "X-Date": sig.xDate,
        "X-Content-Sha256": sig.contentSha256,
        "Content-Type": VOLC_CONTENT_TYPE,
        Authorization: sig.authorization,
      },
      body: "",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!resp.ok) return { ok: false, body };
    const err = (body as { ResponseMetadata?: { Error?: { Code?: string } } } | null)?.ResponseMetadata
      ?.Error;
    if (err) return { ok: false, body };
    return { ok: true, body };
  } catch {
    return { ok: false, body: null };
  }
}

export async function fetchArkPlanQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<QuotaInfo | null> {
  const cached = quotaCache.get(connectionId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.quota;

  const rawCreds = resolveArkPlanCredentials(connection);
  if (!rawCreds) return null;
  const accessKeyId = decryptArkCredential(rawCreds.accessKeyId);
  const secretAccessKey = decryptArkCredential(rawCreds.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) return null;

  const baseUrl = String(
    (connection?.providerSpecificData as Record<string, unknown> | undefined)?.baseUrl ?? ""
  );
  // /api/plan connections burn the Agent Plan (AFP) pool; /api/coding burns the
  // Coding Plan — probe the matching API first, the other as fallback.
  const actions = baseUrl.includes("/api/plan")
    ? (["GetAFPUsage", "GetCodingPlanUsage"] as const)
    : (["GetCodingPlanUsage", "GetAFPUsage"] as const);

  for (const action of actions) {
    const { ok, body } = await callArkControlPlane(action, { accessKeyId, secretAccessKey });
    if (!ok) continue;
    const parsed = action === "GetAFPUsage" ? parseAfpUsage(body) : parseCodingPlanUsage(body);
    if (parsed) {
      quotaCache.set(connectionId, { fetchedAt: Date.now(), quota: parsed });
      return parsed;
    }
  }
  return null;
}

/**
 * Register the Ark plan fetcher. Default target list: the fork's production Ark
 * node; override with OMNIROUTE_ARK_QUOTA_PROVIDERS (comma-separated provider
 * ids) for other custom Ark nodes.
 */
export function registerArkPlanQuotaFetcher(providerIds?: string[]): void {
  const ids =
    providerIds ??
    (process.env.OMNIROUTE_ARK_QUOTA_PROVIDERS?.split(",").map((s) => s.trim()).filter(Boolean)
      ?.length
      ? process.env.OMNIROUTE_ARK_QUOTA_PROVIDERS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ARK_QUOTA_PROVIDERS);
  for (const provider of ids) {
    registerQuotaFetcher(provider, fetchArkPlanQuota);
    registerQuotaWindows(provider, [ARK_WINDOW_5H, ARK_WINDOW_WEEKLY, ARK_WINDOW_MONTHLY]);
  }
}
