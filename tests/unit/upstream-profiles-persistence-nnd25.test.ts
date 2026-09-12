/**
 * nnd.25 任务E — 首字画像持久化（157§六清单第 5 条）。
 *
 * 纪律：画像更新 → debounce（5 分钟内最多一次）把全量分桶 JSON 写
 * key_value(namespace='opsFeatures', key='upstreamFirstByteProfiles')；
 * 启动/首次访问时内存为空且该 key 存在 → 预热载入（重启不失忆）；
 * 带 last_persisted_at 元数据；一切 DB 操作旁路 best-effort，绝不抛进请求路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nnd25-profiles-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");

const NAMESPACE = "opsFeatures";
const KEY = "upstreamFirstByteProfiles";

interface PersistedPayload {
  version?: number;
  last_persisted_at?: string;
  buckets?: Record<string, number[]>;
}

function resetDb(): void {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function readPersistedRow(): { value: string } | undefined {
  return core
    .getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, KEY) as { value: string } | undefined;
}

function readPersistedPayload(): PersistedPayload | null {
  const row = readPersistedRow();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PersistedPayload;
  } catch {
    return null;
  }
}

function writePersistedRow(value: string): void {
  core
    .getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, KEY, value);
}

/** Fresh module instance (module-level buckets/hydration state per import). */
async function freshProfiles() {
  return await import(
    `../../open-sse/services/upstreamProfiles.ts?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
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

test("nnd.25 E: 画像更新 → key_value 出现（首笔即落盘，带 last_persisted_at 与分桶）", async () => {
  const profiles = await freshProfiles();
  const t0 = new Date("2026-09-12T06:00:00Z");
  assert.equal(readPersistedRow(), undefined); // 落盘前无 key

  profiles.recordFirstByteMs("open.bigmodel.cn", 8_000, t0);

  const payload = readPersistedPayload();
  assert.ok(payload, "key_value 行应已写入");
  assert.equal(payload?.version, 1);
  assert.equal(payload?.last_persisted_at, t0.toISOString());
  assert.deepEqual(payload?.buckets?.["open.bigmodel.cn::h6"], [8_000]);
});

test("nnd.25 E: debounce——首笔落盘后 5 分钟内的更新不重写；过窗后全量重写", async () => {
  const profiles = await freshProfiles();
  const t0 = new Date("2026-09-12T06:00:00Z");
  profiles.recordFirstByteMs("open.bigmodel.cn", 8_000, t0);

  // 同窗内的后续更新：不落盘（last_persisted_at 保持 t0，行内容不重写）
  for (const ms of [8_500, 9_000, 9_100, 9_200]) {
    profiles.recordFirstByteMs("open.bigmodel.cn", ms, new Date(t0.getTime() + 60_000));
  }
  let payload = readPersistedPayload();
  assert.equal(payload?.last_persisted_at, t0.toISOString(), "5min 内 debounce 不应重写");
  assert.deepEqual(payload?.buckets?.["open.bigmodel.cn::h6"], [8_000]);

  // 过 5 分钟窗：全量重写，带上 debounce 期间积累的样本
  const t1 = new Date(t0.getTime() + 5 * 60_000 + 1_000);
  profiles.recordFirstByteMs("open.bigmodel.cn", 12_000, t1);
  payload = readPersistedPayload();
  assert.equal(payload?.last_persisted_at, t1.toISOString());
  assert.deepEqual(payload?.buckets?.["open.bigmodel.cn::h6"], [
    8_000, 8_500, 9_000, 9_100, 9_200, 12_000,
  ]);
});

test("nnd.25 E: 空内存 + key 存在 → 预热载入（重启不失忆，p90 直接可用）", async () => {
  writePersistedRow(
    JSON.stringify({
      version: 1,
      last_persisted_at: new Date("2026-09-12T05:00:00Z").toISOString(),
      buckets: { "open.bigmodel.cn::h14": [8_000, 8_500, 9_000, 9_100, 9_200] },
    })
  );

  const profiles = await freshProfiles();
  const t14 = new Date("2026-09-12T14:05:00Z");
  const p90 = profiles.getFirstByteP90Ms("open.bigmodel.cn", t14);
  assert.equal(p90, 9_200, "载入后无需重新采样即可出 p90");
  // 其他 host 仍未知（不猜）
  assert.equal(profiles.getFirstByteP90Ms("ark.cn-beijing.volces.com", t14), null);
});

test("nnd.25 E: 重启后 record 先载入再合并（新样本并入既有桶，随后可再持久化）", async () => {
  writePersistedRow(
    JSON.stringify({
      version: 1,
      last_persisted_at: new Date("2026-09-12T05:00:00Z").toISOString(),
      buckets: { "open.bigmodel.cn::h14": [8_000, 8_500, 9_000, 9_100, 9_200] },
    })
  );

  const profiles = await freshProfiles();
  const t14 = new Date("2026-09-12T14:30:00Z");
  profiles.recordFirstByteMs("open.bigmodel.cn", 9_300, t14); // 距 last_persisted >5min → 载入+合并+再落盘
  const payload = readPersistedPayload();
  assert.deepEqual(payload?.buckets?.["open.bigmodel.cn::h14"], [
    8_000, 8_500, 9_000, 9_100, 9_200, 9_300,
  ]);
  assert.equal(payload?.last_persisted_at, t14.toISOString());
});

test("nnd.25 E: key 内容损坏 → 载入静默放弃（旁路纪律，绝不抛）", async () => {
  writePersistedRow("not-json{{{");
  const profiles = await freshProfiles();
  const t = new Date("2026-09-12T14:00:00Z");
  assert.equal(profiles.getFirstByteP90Ms("open.bigmodel.cn", t), null);
  // record 路径也不抛，且仍可正常落盘自己的数据
  profiles.recordFirstByteMs("open.bigmodel.cn", 8_000, t);
  const payload = readPersistedPayload();
  assert.deepEqual(payload?.buckets?.["open.bigmodel.cn::h14"], [8_000]);
});
