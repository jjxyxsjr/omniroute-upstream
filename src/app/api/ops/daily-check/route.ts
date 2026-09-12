/**
 * nnd.25 任务F — 后端体检端点 /api/ops/daily-check（157§六清单第 6 条）。
 *
 * 把 omniroute-ops skill 的"体检六项"从会话手写 SQL 变成一个 manage 鉴权的
 * GET 端点：返回结构化 JSON 报告，每节"结论一行 + 关键数"。会话/定时任务
 * 调一个端点读结论即可，不再拼 SQL。
 *
 * 口径纪律（全部来自 ops skill 踩坑沉淀，硬性）：
 * - 用户流量 = call_logs WHERE api_key_name IS NOT NULL（剔管理台连接测试），
 *   不按 path 过滤——Claude Code 用户走 /v1/messages，只查 /v1/chat/completions 会漏人；
 * - 时间比较一律 JS 算好 ISO 再参数化传入（timestamp 是 ISO 带 Z 字符串，
 *   与 SQLite datetime('now') 的 "YYYY-MM-DD HH:MM:SS" 字符串比较会得全表假窗口）；
 * - 499 必须按时长分档判性质：<10s=用户主动取消（正常噪音），≥60s=等不到输出
 *   的挂死（故障信号）；
 * - quota_snapshots 列名是 remaining_percentage；水位取 window_key='session'
 *   每连接 MAX(id)，升序，低于 30% 点名；
 * - routing_events 是并行同事在建的表——按约定 schema 查询，try/catch 兜
 *   表不存在/空窗（available:false，不报错）。
 */
import os from "os";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { getDbInstance } from "@/lib/db/core";

const WINDOW_HOURS = 1;
const ERROR_HEAD_CHARS = 40;
const ERROR_TOP_LIMIT = 10;
const QUOTA_LOW_THRESHOLD_PCT = 30;

const MB = 1024 * 1024;

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

function percentileMs(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedValues.length))
  );
  return sortedValues[idx];
}

function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

/** 北京时间 HH:MM（ops 汇报口径：+8h 后取 HH:MM，不再拼 'Z'）。 */
function beijingTime(isoMs: number): string {
  return new Date(isoMs + 8 * 3_600_000).toISOString().slice(11, 16);
}

function buildUserTrafficSection(db: ReturnType<typeof getDbInstance>, sinceIso: string) {
  const rows = db
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
    conclusion: `近${WINDOW_HOURS}h 用户流量 ${total} 笔（${statusText}；api_key_name 口径，含 /v1/messages）`,
    byStatus,
    total,
  };
}

function buildErrorsSection(db: ReturnType<typeof getDbInstance>, sinceIso: string) {
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
      ? `近${WINDOW_HOURS}h 零用户侧错误（status>=400 且 api_key_name 非空）`
      : `近${WINDOW_HOURS}h 错误聚合 top${topRows.length} 见 errors.top；499 分档：<10s×${status499.lt10s}（取消噪音）、10-60s×${status499.s10to60s}、≥60s×${status499.gte60s}（挂死信号）`;

  return {
    conclusion,
    top: topRows.map((r) => ({ status: r.status ?? 0, errorHead: r.head ?? "", count: r.cnt })),
    status499,
  };
}

function buildRoutingEventsSection(db: ReturnType<typeof getDbInstance>, sinceIso: string) {
  const empty = {
    available: false,
    conclusion: "routing_events 不可用（表未建或近1h空窗）——埋点未生效，本节跳过",
    outcomeCounts: [] as Array<{ outcome: string; count: number }>,
    providerIssues: [] as Array<{ provider: string; outcome: string; count: number }>,
    ttft: { count: 0, p50Ms: null as number | null, p90Ms: null as number | null },
  };

  try {
    const outcomeRows = db
      .prepare(`SELECT outcome, COUNT(*) AS cnt FROM routing_events WHERE ts >= ? GROUP BY outcome ORDER BY cnt DESC`)
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
      conclusion: `近${WINDOW_HOURS}h 路由事件 ${totalEvents} 笔（${outcomeText}${issueText}）；ttft p50=${p50Ms ?? "n/a"}ms p90=${p90Ms ?? "n/a"}ms`,
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

function buildQuotaLevelsSection(db: ReturnType<typeof getDbInstance>) {
  // ops skill 标准查询：session 窗每连接 MAX(id)，join provider_connections 拿名字，升序。
  const rows = db
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
    .filter((c) => typeof c.remainingPercentage === "number" && c.remainingPercentage < QUOTA_LOW_THRESHOLD_PCT)
    .map((c) => c.name);

  const conclusion =
    connections.length === 0
      ? "无 session 窗配额快照"
      : belowThreshold.length > 0
        ? `${connections.length} 个连接水位就绪，最低 ${connections[0].name} ${connections[0].remainingPercentage}%；低于 ${QUOTA_LOW_THRESHOLD_PCT}% 点名：${belowThreshold.join("、")}`
        : `${connections.length} 个连接水位就绪，最低 ${connections[0].name} ${connections[0].remainingPercentage}%（全部 ≥${QUOTA_LOW_THRESHOLD_PCT}%）`;

  return { conclusion, connections, belowThreshold };
}

function buildResourcesSection() {
  const mem = process.memoryUsage();
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const rssMb = toMb(mem.rss);
  const totalMemMb = toMb(totalMem);

  return {
    conclusion: `进程 rss ${rssMb}MB（heapUsed ${toMb(mem.heapUsed)}MB / external ${toMb(mem.external)}MB）；系统内存 ${toMb(freeMem)}/${totalMemMb}MB 可用`,
    process: {
      rssMb,
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
    },
    system: {
      freeMemMb: toMb(freeMem),
      totalMemMb,
    },
  };
}

function buildVerdictSection(
  userTraffic: ReturnType<typeof buildUserTrafficSection>,
  errors: ReturnType<typeof buildErrorsSection>,
  quota: ReturnType<typeof buildQuotaLevelsSection>
) {
  const countFor = (status: number) =>
    userTraffic.byStatus.find((r) => r.status === status)?.count ?? 0;

  const items: string[] = [];
  const c429 = countFor(429);
  const c503 = countFor(503);
  if (c429 > 0) items.push(`429×${c429}（上游限流，近${WINDOW_HOURS}h）`);
  if (c503 > 0) items.push(`503×${c503}（近${WINDOW_HOURS}h，注意 ALL_TARGETS_SKIPPED/模型锁）`);
  if (errors.status499.gte60s > 0) {
    items.push(`499 长时（≥60s）×${errors.status499.gte60s}（挂死信号，需深入）`);
  }
  if (quota.belowThreshold.length > 0) {
    const lowest = quota.connections[0];
    items.push(
      `配额水位<${QUOTA_LOW_THRESHOLD_PCT}%：${quota.belowThreshold.join("、")}（最低 ${lowest.name} ${lowest.remainingPercentage}%）`
    );
  }

  const actionRequired = items.length > 0;
  return {
    conclusion: actionRequired ? `需关注 ${items.length} 项：${items.join("；")}` : "无需动作",
    actionRequired,
    items,
  };
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const db = getDbInstance();
    const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();
    const nowMs = Date.now();

    const userTraffic = buildUserTrafficSection(db, sinceIso);
    const errors = buildErrorsSection(db, sinceIso);
    const routingEvents = buildRoutingEventsSection(db, sinceIso);
    const quotaLevels = buildQuotaLevelsSection(db);
    const resources = buildResourcesSection();
    const verdict = buildVerdictSection(userTraffic, errors, quotaLevels);

    return NextResponse.json({
      generatedAt: new Date(nowMs).toISOString(),
      generatedAtBeijing: beijingTime(nowMs),
      windowHours: WINDOW_HOURS,
      sections: {
        userTraffic,
        errors,
        routingEvents,
        quotaLevels,
        resources,
        verdict,
      },
    });
  } catch (error) {
    console.error("Error building daily-check report:", error);
    const message = error instanceof Error ? error.message : String(error);
    return createErrorResponse({ status: 500, message: message || "Failed to build daily-check report" });
  }
}
