/**
 * nnd.25 任务F — /api/ops/daily-check 后端体检端点（157§六清单第 6 条）。
 *
 * 六节结构化报告：用户流量近1h（api_key_name 口径，含 /v1/messages）、
 * 错误明细（status×error_summary 前 40 字符 top10 + 499 时长分档）、
 * 路由事件面（routing_events，表缺失/空窗 → available:false 不报错）、
 * 配额水位（session 窗每连接 MAX(id)，升序）、资源（内存）、判定（零429零503零499长时=无需动作）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nnd25-dailycheck-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const backendAnalysis = await import("../../src/lib/db/backendAnalysis.ts");
const dailyCheckRoute = await import("../../src/app/api/ops/daily-check/route.ts");

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function resetDb(): void {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function db() {
  return core.getDbInstance();
}

function seedCallLog(row: {
  minutesAgo: number;
  status: number;
  apiKeyName?: string | null;
  errorSummary?: string | null;
  durationMs?: number;
  path?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO call_logs (id, timestamp, path, status, api_key_name, error_summary, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      iso(row.minutesAgo),
      row.path ?? "/v1/chat/completions",
      row.status,
      row.apiKeyName ?? null,
      row.errorSummary ?? null,
      row.durationMs ?? 0
    );
}

function seedRoutingEvent(row: {
  minutesAgo: number;
  provider: string;
  outcome: string;
  ttftMs?: number | null;
}): void {
  // 并行同事的 migration 178 + DAO：用项目自己的写入器种子化（NOT NULL 约束由它兜）。
  backendAnalysis.insertRoutingEventRows([
    {
      ts: iso(row.minutesAgo),
      requestId: null,
      provider: row.provider,
      model: "glm-5.3",
      strategy: "direct",
      outcome: row.outcome,
      status: null,
      latencyMs: 0,
      ttftMs: row.ttftMs ?? null,
      itlMs: null,
      inputTokens: null,
      outputTokens: null,
      retries: 0,
      fallbackUsed: false,
      finishReason: null,
      connectionId: null,
    },
  ]);
}

function seedConnection(id: string, name: string): void {
  db()
    .prepare(
      `INSERT INTO provider_connections (id, provider, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, "glm", name, iso(60), iso(60));
}

function seedQuotaSnapshot(row: {
  connectionId: string;
  windowKey: string;
  remainingPct: number;
}): void {
  db()
    .prepare(
      `INSERT INTO quota_snapshots (provider, connection_id, window_key, remaining_percentage, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("glm", row.connectionId, row.windowKey, row.remainingPct, iso(5));
}

interface DailyCheckReport {
  sections: {
    userTraffic: { total: number; byStatus: Array<{ status: number; count: number }> };
    errors: { top: Array<{ status: number; errorHead: string; count: number }> };
    routingEvents: {
      available: boolean;
      outcomeCounts: Array<{ outcome: string; count: number }>;
      providerIssues: Array<{ provider: string; outcome: string; count: number }>;
      ttft: { count: number; p50Ms: number | null; p90Ms: number | null };
    };
    quotaLevels: {
      connections: Array<{ name: string; remainingPercentage: number | null }>;
      belowThreshold: string[];
    };
    resources: { process: { rssMb: number }; system: { totalMemMb: number } };
    verdict: { actionRequired: boolean; conclusion: string; items: string[] };
  };
}

async function runGet(): Promise<{ status: number; body: DailyCheckReport }> {
  const response = await dailyCheckRoute.GET(new Request("http://localhost/api/ops/daily-check"));
  return { status: response.status, body: (await response.json()) as DailyCheckReport };
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* noop */
  }
});

test("nnd.25 F: 空库 → 200 + 六节齐全 + routing_events 不可用不报错 + 判定无需动作", async () => {
  const { status, body } = await runGet();
  assert.equal(status, 200);
  const sections = body.sections;
  assert.ok(sections, "响应应含 sections");
  for (const name of [
    "userTraffic",
    "errors",
    "routingEvents",
    "quotaLevels",
    "resources",
    "verdict",
  ]) {
    assert.ok(sections[name], `缺第 ${name} 节`);
    assert.ok(typeof sections[name].conclusion === "string" && sections[name].conclusion.length > 0);
  }
  assert.equal(sections.routingEvents.available, false, "routing_events 缺表 → available:false");
  assert.equal(sections.userTraffic.total, 0);
  assert.deepEqual(sections.userTraffic.byStatus, []);
  assert.equal(sections.verdict.actionRequired, false);
  assert.match(sections.verdict.conclusion, /无需动作/);
  // 资源节带关键数
  assert.ok(sections.resources.process.rssMb > 0);
  assert.ok(sections.resources.system.totalMemMb > 0);
});

test("nnd.25 F: 用户流量口径——api_key_name IS NOT NULL 且含 /v1/messages；错误明细 top10 + 499 分档", async () => {
  seedCallLog({ minutesAgo: 5, status: 200, apiKeyName: "alice" });
  seedCallLog({ minutesAgo: 6, status: 200, apiKeyName: "bob", path: "/v1/messages" }); // Claude Code 用户
  seedCallLog({ minutesAgo: 70, status: 200, apiKeyName: "alice" }); // 窗外不计
  seedCallLog({ minutesAgo: 3, status: 200, apiKeyName: null }); // 管理台连接测试，剔除
  seedCallLog({
    minutesAgo: 4,
    status: 499,
    apiKeyName: "alice",
    durationMs: 4_000,
    errorSummary: "client cancelled",
  });
  seedCallLog({
    minutesAgo: 2,
    status: 499,
    apiKeyName: "bob",
    durationMs: 75_000,
    errorSummary: "client cancelled slow",
  });
  seedCallLog({
    minutesAgo: 1,
    status: 429,
    apiKeyName: "alice",
    errorSummary: "上游 429 quota exceeded for this key",
  });
  seedCallLog({
    minutesAgo: 8,
    status: 503,
    apiKeyName: "carol",
    errorSummary: "ALL_TARGETS_SKIPPED attempted=0",
  });

  const { status, body } = await runGet();
  assert.equal(status, 200);
  const { userTraffic, errors, verdict } = body.sections;

  assert.equal(userTraffic.total, 6); // 2×200 + 2×499 + 429 + 503
  const byStatus = Object.fromEntries(userTraffic.byStatus.map((r) => [r.status, r.count] as [number, number]));
  assert.equal(byStatus[200], 2, "/v1/messages 用户必须计入");
  assert.equal(byStatus[499], 2);
  assert.equal(byStatus[429], 1);
  assert.equal(byStatus[503], 1);

  assert.ok(errors.top.length <= 10);
  const top = errors.top as Array<{ status: number; errorHead: string; count: number }>;
  assert.ok(top.every((r) => r.errorHead.length <= 40), "errorHead 截前 40 字符");
  const row429 = top.find((r) => r.status === 429);
  assert.ok(row429, "429 应进错误明细 top");
  assert.equal(row429?.errorHead, "上游 429 quota exceeded for this key".slice(0, 40));

  assert.equal(errors.status499.lt10s, 1);
  assert.equal(errors.status499.s10to60s, 0);
  assert.equal(errors.status499.gte60s, 1);

  assert.equal(verdict.actionRequired, true);
  const items = verdict.items.join(";");
  assert.match(items, /429/);
  assert.match(items, /503/);
  assert.match(items, /499/);
  assert.match(items, /60s/);
});

test("nnd.25 F: 零 429/503/499长时 → 判定无需动作", async () => {
  seedCallLog({ minutesAgo: 5, status: 200, apiKeyName: "alice" });
  seedCallLog({
    minutesAgo: 3,
    status: 499,
    apiKeyName: "alice",
    durationMs: 2_000,
    errorSummary: "client cancelled",
  });
  const { body } = await runGet();
  assert.equal(body.sections.verdict.actionRequired, false);
  assert.match(body.sections.verdict.conclusion, /无需动作/);
});

test("nnd.25 F: routing_events 有事件 → outcome 计数 + provider timeout/rate_limited + ttft p50/p90", async () => {
  for (const provider of ["glm-a", "glm-a", "glm-a"]) {
    seedRoutingEvent({ minutesAgo: 5, provider, outcome: "success", ttftMs: 100 });
  }
  seedRoutingEvent({ minutesAgo: 4, provider: "glm-a", outcome: "timeout", ttftMs: null });
  seedRoutingEvent({ minutesAgo: 4, provider: "glm-a", outcome: "timeout", ttftMs: null });
  seedRoutingEvent({ minutesAgo: 3, provider: "ark", outcome: "rate_limited", ttftMs: null });
  seedRoutingEvent({ minutesAgo: 90, provider: "ark", outcome: "rate_limited", ttftMs: null }); // 窗外
  seedRoutingEvent({ minutesAgo: 2, provider: "glm-b", outcome: "success", ttftMs: 1_000 });

  const { body } = await runGet();
  const routing = body.sections.routingEvents;
  assert.equal(routing.available, true);
  const outcomes = Object.fromEntries(routing.outcomeCounts.map((r) => [r.outcome, r.count] as [string, number]));
  assert.equal(outcomes.success, 4);
  assert.equal(outcomes.timeout, 2);
  assert.equal(outcomes.rate_limited, 1, "窗外事件不计");
  const issues = routing.providerIssues as Array<{ provider: string; outcome: string; count: number }>;
  assert.deepEqual(
    issues.find((r) => r.provider === "glm-a" && r.outcome === "timeout"),
    { provider: "glm-a", outcome: "timeout", count: 2 }
  );
  assert.deepEqual(
    issues.find((r) => r.provider === "ark" && r.outcome === "rate_limited"),
    { provider: "ark", outcome: "rate_limited", count: 1 }
  );
  // ttft 样本 [100,100,100,1000]:p50=100(排序 idx2),p90=1000(idx3)
  assert.equal(routing.ttft.count, 4);
  assert.equal(routing.ttft.p50Ms, 100);
  assert.equal(routing.ttft.p90Ms, 1000);
});

test("nnd.25 F: routing_events 空窗 → available:false 不报错", async () => {
  // migration 178 自动建表；不插数据 → 近1h零事件
  const { status, body } = await runGet();
  assert.equal(status, 200);
  assert.equal(body.sections.routingEvents.available, false);
});

test("nnd.25 F: routing_events 表不存在（升级中途库）→ try/catch 兜底 available:false，端点不 500", async () => {
  db().exec("DROP TABLE routing_events");
  const { status, body } = await runGet();
  assert.equal(status, 200);
  assert.equal(body.sections.routingEvents.available, false);
});

test("nnd.25 F: 配额水位——session 窗每连接取 MAX(id)，升序，低于 30% 点名", async () => {
  seedConnection("conn-1", "glm-main");
  seedConnection("conn-2", "glm-backup");
  seedConnection("conn-3", "glm-fresh");
  seedQuotaSnapshot({ connectionId: "conn-1", windowKey: "session", remainingPct: 42 });
  seedQuotaSnapshot({ connectionId: "conn-1", windowKey: "session", remainingPct: 5 }); // 最新一条才算
  seedQuotaSnapshot({ connectionId: "conn-2", windowKey: "session", remainingPct: 77 });
  seedQuotaSnapshot({ connectionId: "conn-3", windowKey: "daily", remainingPct: 1 }); // 非 session 窗剔除

  const { body } = await runGet();
  const quota = body.sections.quotaLevels;
  const conns = quota.connections as Array<{
    name: string;
    remainingPercentage: number;
  }>;
  assert.equal(conns.length, 2, "daily 窗剔除、每连接只留最新");
  assert.deepEqual(
    conns.map((c) => c.name),
    ["glm-main", "glm-backup"],
    "按剩余%升序"
  );
  assert.equal(conns[0].remainingPercentage, 5);
  assert.deepEqual(quota.belowThreshold, ["glm-main"]);
  assert.match(quota.conclusion, /glm-main/);
  // 水位过低进判定关注项
  assert.equal(body.sections.verdict.actionRequired, true);
  assert.match(body.sections.verdict.items.join(";"), /glm-main/);
});
