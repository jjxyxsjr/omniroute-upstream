/**
 * nnd.25 任务F — 后端体检端点 /api/ops/daily-check（157§六清单第 6 条）。
 *
 * 把 omniroute-ops skill 的"体检六项"从会话手写 SQL 变成一个 manage 鉴权的
 * GET 端点：返回结构化 JSON 报告，每节"结论一行 + 关键数"。会话/定时任务
 * 调一个端点读结论即可，不再拼 SQL。
 *
 * Hard Rule #5（check-db-rules 门）：本文件零 SQL——四个 DB 节的查询与口径
 * 纪律全部下沉 src/lib/usage/opsCheckQueries.ts，route 只做鉴权+编排+响应。
 */
import os from "os";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  getErrorsSection,
  getQuotaLevelsSection,
  getRoutingEventsSection,
  getUserTrafficSection,
  QUOTA_LOW_THRESHOLD_PCT,
  type ErrorsSection,
  type QuotaLevelsSection,
  type UserTrafficSection,
} from "@/lib/usage/opsCheckQueries";

const WINDOW_HOURS = 1;

const MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

/** 北京时间 HH:MM（ops 汇报口径：+8h 后取 HH:MM，不再拼 'Z'）。 */
function beijingTime(isoMs: number): string {
  return new Date(isoMs + 8 * 3_600_000).toISOString().slice(11, 16);
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
  userTraffic: UserTrafficSection,
  errors: ErrorsSection,
  quota: QuotaLevelsSection
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
    const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();
    const nowMs = Date.now();

    const userTraffic = getUserTrafficSection(sinceIso, WINDOW_HOURS);
    const errors = getErrorsSection(sinceIso, WINDOW_HOURS);
    const routingEvents = getRoutingEventsSection(sinceIso, WINDOW_HOURS);
    const quotaLevels = getQuotaLevelsSection();
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
