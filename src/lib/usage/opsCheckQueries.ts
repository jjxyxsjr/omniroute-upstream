/**
 * usage/opsCheckQueries.ts — daily-check 体检六节的 DB 查询层。
 *
 * Hard Rule #5（check-db-rules 门）：API 路由永不写裸 SQL——/api/ops/daily-check
 * 的全部查询下沉到此，route 只做鉴权+编排+响应。语义与六节结构零变化
 * （nnd.25 任务F，自 route.ts 原样抽出）。
 *
 * 口径纪律（全部来自 omniroute-ops skill 踩坑沉淀，硬性）：
 * - 用户流量 = call_logs WHERE api_key_name IS NOT NULL（剔管理台连接测试），
 *   不按 path 过滤——Claude Code 用户走 /v1/messages，只查 /v1/chat/completions 会漏人；
 * - 时间比较一律由调用方 JS 算好 ISO 再参数化传入（timestamp 是 ISO 带 Z 字符串，
 *   与 SQLite datetime('now') 的 "YYYY-MM-DD HH:MM:SS" 字符串比较会得全表假窗口）；
 * - 499 必须按时长分档判性质：<10s=用户主动取消（正常噪音），≥60s=等不到输出
 *   的挂死（故障信号）；
 * - quota_snapshots 列名是 remaining_percentage；水位取 window_key='session'
 *   每连接 MAX(id)，升序，低于 30% 点名（ops skill 标准查询原样）；
 * - routing_events（migration 178）按约定 schema 查询，try/catch 兜表不存在/
 *   空窗（available:false，绝不把体检端点打成 500）。
 */

import { getDbInstance } from "../db/core";

export const ERROR_HEAD_CHARS = 40;
export const ERROR_TOP_LIMIT = 10;
export const QUOTA_LOW_THRESHOLD_PCT = 30;

interface StatusCountRow {
  status: number | null;
  cnt: number;
}

interface ErrorHeadRow {
  status: number | null;
  head: string | null;
  cnt: number;
}

interface QuotaRow {
  name: string | null;
  remaining_percentage: number | null;
  next_reset_at: string | null;
}

interface RoutingOutcomeRow {
  outcome: string | null;
  cnt: number;
}

interface RoutingProviderIssueRow {
  provider: string | null;
  outcome: string | null;
  cnt: number;
}

export interface UserTrafficSection {
  conclusion: string;
  byStatus: Array<{ status: number; count: number }>;
  total: number;
}

export interface ErrorsSection {
  conclusion: string;
  top: Array<{ status: number; errorHead: string; count: number }>;
  status499: { total: number; lt10s: number; s10to60s: number; gte60s: number };
}

export interface RoutingEventsSection {
  available: boolean;
  conclusion: string;
  outcomeCounts: Array<{ outcome: string; count: number }>;
  providerIssues: Array<{ provider: string; outcome: string; count: number }>;
  ttft: { count: number; p50Ms: number | null; p90Ms: number | null };
}

export interface QuotaLevelsSection {
  conclusion: string;
  connections: Array<{ name: string; remainingPercentage: number | null; nextResetAt: string | null }>;
  belowThreshold: string[];
}

function percentileMs(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedValues.length))
  );
  return sortedValues[idx];
}

export function getUserTrafficSection(sinceIso: string, windowHours: number): UserTrafficSection {
  const rows = getDbInstance()
    .prepare(
      `SELECT status, COUNT(*) AS cnt FROM call_logs
       WHERE timestamp >= ? AND api_key_name IS NOT NULL
       GROUP BY status ORDER BY status`
    )
    .all(sinceIso) as StatusCountRow[];

  const byStatus = rows
    .filter((r) => r.status !== null)
    .map((r) => ({ status: r.status as number, count: r.cnt }));
  const total = byStatus.reduce((sum, r) => sum + r.count, 0);
  const statusText = byStatus.length > 0 ? byStatus.map((r) => `${r.status}×${r.count}`).join("、") : "无流量";

  return {
    conclusion: `近${windowHours}h 用户流量 ${total} 笔（${statusText}；api_key_name 口径，含 /v1/messages）`,
    byStatus,
    total,
  };
}

export function getErrorsSection(sinceIso: string, windowHours: number): ErrorsSection {
  const db = getDbInstance();
  const topRows = db
    .prepare(
      `SELECT status, SUBSTR(COALESCE(error_summary, ''), 1, ${ERROR_HEAD_CHARS}) AS head, COUNT(*) AS cnt
       FROM call_logs
       WHERE timestamp >= ? AND status >= 400 AND api_key_name IS NOT NULL
       GROUP BY status, head
       ORDER BY cnt DESC, status
       LIMIT ${ERROR_TOP_LIMIT}`
    )
    .all(sinceIso) as ErrorHeadRow[];

  const durations = (
    db
      .prepare(
        `SELECT duration FROM call_logs
         WHERE timestamp >= ? AND status = 499 AND api_key_name IS NOT NULL`
      )
      .all(sinceIso) as Array<{ duration: number | null }>
  )
    .map((r) => Number(r.duration))
    .filter((d) => Number.isFinite(d));

  const status499 = {
    total: durations.length,
    lt10s: durations.filter((d) => d < 10_000).length,
    s10to60s: durations.filter((d) => d >= 10_000 && d < 60_000).length,
    gte60s: durations.filter((d) => d >= 60_000).length,
  };

  const errorTotal = topRows.reduce((sum, r) => sum + r.cnt, 0);
  const conclusion =
    errorTotal === 0
      ? `近${windowHours}h 零用户侧错误（status>=400 且 api_key_name 非空）`
      : `近${windowHours}h 错误聚合 top${topRows.length} 见 errors.top；499 分档：<10s×${status499.lt10s}（取消噪音）、10-60s×${status499.s10to60s}、≥60s×${status499.gte60s}（挂死信号）`;

  return {
    conclusion,
    top: topRows.map((r) => ({ status: r.status ?? 0, errorHead: r.head ?? "", count: r.cnt })),
    status499,
  };
}

export function getRoutingEventsSection(sinceIso: string, windowHours: number): RoutingEventsSection {
  const empty: RoutingEventsSection = {
    available: false,
    conclusion: "routing_events 不可用（表未建或近1h空窗）——埋点未生效，本节跳过",
    outcomeCounts: [],
    providerIssues: [],
    ttft: { count: 0, p50Ms: null, p90Ms: null },
  };

  try {
    const db = getDbInstance();
    const outcomeRows = db
      .prepare(
        `SELECT outcome, COUNT(*) AS cnt FROM routing_events WHERE ts >= ? GROUP BY outcome ORDER BY cnt DESC`
      )
      .all(sinceIso) as RoutingOutcomeRow[];

    const totalEvents = outcomeRows.reduce((sum, r) => sum + r.cnt, 0);
    if (totalEvents === 0) {
      return { ...empty, conclusion: "routing_events 近1h零事件（表在、无埋点流量）——本节跳过" };
    }

    const issueRows = db
      .prepare(
        `SELECT provider, outcome, COUNT(*) AS cnt FROM routing_events
         WHERE ts >= ? AND LOWER(COALESCE(outcome,'')) IN ('timeout','rate_limited')
         GROUP BY provider, outcome ORDER BY cnt DESC`
      )
      .all(sinceIso) as RoutingProviderIssueRow[];

    const ttftValues = (
      db
        .prepare(`SELECT ttft_ms FROM routing_events WHERE ts >= ? AND ttft_ms IS NOT NULL`)
        .all(sinceIso) as Array<{ ttft_ms: number | null }>
    )
      .map((r) => Number(r.ttft_ms))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    const p50Ms = percentileMs(ttftValues, 50);
    const p90Ms = percentileMs(ttftValues, 90);
    const outcomeText = outcomeRows.map((r) => `${r.outcome ?? "?"}×${r.cnt}`).join("、");
    const issueText =
      issueRows.length > 0
        ? `；需关注：${issueRows.map((r) => `${r.provider ?? "?"}/${r.outcome}×${r.cnt}`).join("、")}`
        : "；无 timeout/rate_limited";

    return {
      available: true,
      conclusion: `近${windowHours}h 路由事件 ${totalEvents} 笔（${outcomeText}${issueText}）；ttft p50=${p50Ms ?? "n/a"}ms p90=${p90Ms ?? "n/a"}ms`,
      outcomeCounts: outcomeRows.map((r) => ({ outcome: r.outcome ?? "?", count: r.cnt })),
      providerIssues: issueRows.map((r) => ({
        provider: r.provider ?? "?",
        outcome: r.outcome ?? "?",
        count: r.cnt,
      })),
      ttft: {
        count: ttftValues.length,
        p50Ms,
        p90Ms,
      },
    };
  } catch {
    // 表不存在（并行同事在建）或查询失败：available:false，绝不让体检端点 500。
    return empty;
  }
}

export function getQuotaLevelsSection(): QuotaLevelsSection {
  // ops skill 标准查询：session 窗每连接 MAX(id)，join provider_connections 拿名字，升序。
  const rows = getDbInstance()
    .prepare(
      `SELECT pc.name, qs.remaining_percentage, qs.next_reset_at
       FROM quota_snapshots qs JOIN provider_connections pc ON pc.id = qs.connection_id
       WHERE qs.window_key='session'
         AND qs.id IN (SELECT MAX(id) FROM quota_snapshots WHERE window_key='session' GROUP BY connection_id)
       ORDER BY qs.remaining_percentage`
    )
    .all() as QuotaRow[];

  const connections = rows.map((r) => ({
    name: (r.name ?? "").trim() || "unknown",
    remainingPercentage: r.remaining_percentage,
    nextResetAt: r.next_reset_at,
  }));
  const belowThreshold = connections
    .filter(
      (c) => typeof c.remainingPercentage === "number" && c.remainingPercentage < QUOTA_LOW_THRESHOLD_PCT
    )
    .map((c) => c.name);

  const conclusion =
    connections.length === 0
      ? "无 session 窗配额快照"
      : belowThreshold.length > 0
        ? `${connections.length} 个连接水位就绪，最低 ${connections[0].name} ${connections[0].remainingPercentage}%；低于 ${QUOTA_LOW_THRESHOLD_PCT}% 点名：${belowThreshold.join("、")}`
        : `${connections.length} 个连接水位就绪，最低 ${connections[0].name} ${connections[0].remainingPercentage}%（全部 ≥${QUOTA_LOW_THRESHOLD_PCT}%）`;

  return { conclusion, connections, belowThreshold };
}
