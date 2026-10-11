/**
 * nnd.34 #93 (deploy/docs/157 §六-1) — call_logs.error_raw_head:
 * 错误响应线路形态原文头（未 JSON.parse 还原，转义形保留）落库。
 * 病例：max_tokens \u003c 案 error_summary 截 60 字符 + 还原形失真误诊两天。
 * Harness 同 #91 的 call-log-tail-messages.test.ts（解撞号迁移目录 + 临时 DATA_DIR）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rawhead-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { saveCallLog } = await import("../../src/lib/usage/callLogs.ts");

test.after(() => {
  resetDbInstance();
});

test("call_logs has error_raw_head column (migration 200)", () => {
  const db = getDbInstance();
  const cols = (db.prepare("PRAGMA table_info(call_logs)").all() as { name: string }[]).map(
    (c) => c.name
  );
  assert.ok(cols.includes("error_raw_head"), "error_raw_head column present");
});

test("saveCallLog persists wire-form error head verbatim (escape forms preserved)", async () => {
  const db = getDbInstance();
  const id = `test-rawhead-${Date.now()}-1`;
  // 线路形态：ark 的 400 原始字节里 "<=" 是 JSON 转义形 "\u003c="——还原前的样子必须原样落库
  const wireForm =
    '{"error":{"message":"Invalid parameter: max_tokens. Values must be an integer above the maximum value: expected a value <= 131072, but got 178586."}}'.replace(
      /<=/g,
      "\\u003c="
    );
  assert.ok(wireForm.includes("\\u003c="), "fixture must carry the escaped wire form");

  await saveCallLog({
    id,
    method: "POST",
    path: "/v1/chat/completions",
    status: 400,
    model: "m",
    provider: "p",
    duration: 100,
    tokens: {},
    errorRawHead: wireForm.slice(0, 512),
  });

  const row = db
    .prepare("SELECT error_raw_head FROM call_logs WHERE id = ?")
    .get(id) as { error_raw_head: string | null };
  assert.ok(row.error_raw_head, "raw head persisted");
  assert.ok(
    (row.error_raw_head as string).includes("\\u003c="),
    "escape form preserved verbatim (no JSON.parse restoration)"
  );
});

test("saveCallLog truncates overlong heads to 512 and nulls out garbage", async () => {
  const db = getDbInstance();
  const longId = `test-rawhead-${Date.now()}-L`;
  const junkId = `test-rawhead-${Date.now()}-J`;
  const okId = `test-rawhead-${Date.now()}-O`;

  await saveCallLog({
    id: longId, method: "POST", path: "/x", status: 500, model: "m", provider: "p",
    duration: 1, tokens: {}, errorRawHead: "x".repeat(9_000),
  });
  await saveCallLog({
    id: junkId, method: "POST", path: "/x", status: 500, model: "m", provider: "p",
    duration: 1, tokens: {}, errorRawHead: undefined,
  });
  await saveCallLog({
    id: okId, method: "POST", path: "/x", status: 200, model: "m", provider: "p",
    duration: 1, tokens: {},
  });

  const L = db.prepare("SELECT LENGTH(error_raw_head) n FROM call_logs WHERE id=?").get(longId) as { n: number };
  const J = db.prepare("SELECT error_raw_head h FROM call_logs WHERE id=?").get(junkId) as { h: string | null };
  const O = db.prepare("SELECT error_raw_head h FROM call_logs WHERE id=?").get(okId) as { h: string | null };
  assert.equal(L.n, 512, "overlong head truncated to 512");
  assert.equal(J.h, null, "undefined head persists null");
  assert.equal(O.h, null, "success rows (no head) stay null");
});
