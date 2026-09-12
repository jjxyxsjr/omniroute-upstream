/**
 * tests/unit/db-migration-178-backend-analysis.test.ts
 *
 * nnd.25 (backend analysis batch): migration 178 creates the local-telemetry
 * base tables — `routing_events` (SQLite routing-event sink target) and
 * `runtime_state_snapshots` (periodic in-memory state sampler target) — and
 * adds `call_logs.error_raw_head` for raw error-head capture. Asserts the
 * schema, the indexes, and the isSchemaAlreadyApplied guard for DBs that
 * already carry the error_raw_head column.
 */
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const BetterSqlite3 = require_("better-sqlite3") as typeof import("better-sqlite3");

import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter";

const MIGRATION_178_PATH = path.resolve(
  import.meta.dirname ?? ".",
  "../../src/lib/db/migrations/178_backend_analysis.sql"
);
const MIGRATION_178_SQL = fs.readFileSync(MIGRATION_178_PATH, "utf8");

// Minimal pre-178 fixture: call_logs must predate the ALTER TABLE.
const PRE_178_FIXTURE = `
  CREATE TABLE call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT
  );
`;

function makeTempDb(): {
  raw: import("better-sqlite3").Database;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-178-test-"));
  const raw = new BetterSqlite3(path.join(dir, "test.db"));
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 2000");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS _omniroute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  raw.exec(PRE_178_FIXTURE);
  // Applied once — the bare ALTER TABLE at the tail is not re-runnable.
  raw.exec(MIGRATION_178_SQL);
  return { raw, dir };
}

function dispose(raw: import("better-sqlite3").Database, dir: string): void {
  raw.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function columnNames(raw: import("better-sqlite3").Database, table: string): string[] {
  const cols = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

function columnInfo(
  raw: import("better-sqlite3").Database,
  table: string,
  column: string
): { name: string; type: string; notnull: number; dflt_value: unknown } | undefined {
  const cols = raw.pragma(`table_info(${table})`) as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  return cols.find((c) => c.name === column);
}

function indexNames(raw: import("better-sqlite3").Database, table: string): string[] {
  const indexes = raw.pragma(`index_list(${table})`) as Array<{ name: string }>;
  return indexes.map((i) => i.name);
}

test("migration 178: routing_events table exists with the full column set", () => {
  const { raw, dir } = makeTempDb();
  try {
    const cols = columnNames(raw, "routing_events");
    assert.deepEqual(cols, [
      "id",
      "ts",
      "request_id",
      "provider",
      "model",
      "strategy",
      "outcome",
      "status",
      "latency_ms",
      "ttft_ms",
      "itl_ms",
      "input_tokens",
      "output_tokens",
      "retries",
      "fallback_used",
      "finish_reason",
      "connection_id",
    ]);
    for (const required of ["ts", "provider", "model", "strategy", "outcome"]) {
      assert.equal(columnInfo(raw, "routing_events", required)?.notnull, 1, `${required} NOT NULL`);
    }
    const fallback = columnInfo(raw, "routing_events", "fallback_used");
    assert.equal(fallback?.notnull, 1, "fallback_used NOT NULL");
    assert.equal(fallback?.dflt_value, "0", "fallback_used defaults to 0");
  } finally {
    dispose(raw, dir);
  }
});

test("migration 178: routing_events indexes on ts and (outcome, ts)", () => {
  const { raw, dir } = makeTempDb();
  try {
    const names = indexNames(raw, "routing_events");
    assert.ok(names.includes("idx_routing_events_ts"), `got: ${names.join(", ")}`);
    assert.ok(names.includes("idx_routing_events_outcome"), `got: ${names.join(", ")}`);
  } finally {
    dispose(raw, dir);
  }
});

test("migration 178: runtime_state_snapshots table exists with kind/entity/state columns", () => {
  const { raw, dir } = makeTempDb();
  try {
    assert.deepEqual(columnNames(raw, "runtime_state_snapshots"), [
      "id",
      "ts",
      "kind",
      "entity",
      "state",
    ]);
    for (const required of ["ts", "kind", "state"]) {
      assert.equal(
        columnInfo(raw, "runtime_state_snapshots", required)?.notnull,
        1,
        `${required} NOT NULL`
      );
    }
    assert.ok(
      indexNames(raw, "runtime_state_snapshots").includes("idx_runtime_state_ts"),
      "ts index present"
    );
  } finally {
    dispose(raw, dir);
  }
});

test("migration 178: call_logs gains a nullable error_raw_head column", () => {
  const { raw, dir } = makeTempDb();
  try {
    const col = columnInfo(raw, "call_logs", "error_raw_head");
    assert.ok(col, "error_raw_head column exists");
    assert.equal(col?.type, "TEXT");
    assert.equal(col?.notnull, 0, "error_raw_head is nullable");
  } finally {
    dispose(raw, dir);
  }
});

test("migration 178: a full routing_events row round-trips", () => {
  const { raw, dir } = makeTempDb();
  try {
    raw.exec(`
      INSERT INTO routing_events (
        ts, request_id, provider, model, strategy, outcome, status,
        latency_ms, ttft_ms, itl_ms, input_tokens, output_tokens,
        retries, fallback_used, finish_reason, connection_id
      ) VALUES (
        '2026-09-12T00:00:00.000Z', 'req-1', 'openai', 'gpt-4o', 'auto', 'success', 200,
        120, 40, 12, 10, 20, 1, 1, 'stop', 'conn-1'
      )
    `);
    const row = raw
      .prepare("SELECT * FROM routing_events WHERE request_id = 'req-1'")
      .get() as Record<string, unknown>;
    assert.equal(row.outcome, "success");
    assert.equal(row.ttft_ms, 40);
    assert.equal(row.latency_ms, 120);
    assert.equal(row.fallback_used, 1);
    assert.equal(row.connection_id, "conn-1");
  } finally {
    dispose(raw, dir);
  }
});

test("migration 178: isSchemaAlreadyApplied guard skips re-run when error_raw_head exists", async () => {
  // A DB that already has the full 178 schema but an empty migration ledger
  // (e.g. applied under a different number in the fork) must skip the bare
  // ALTER TABLE instead of failing with "duplicate column name".
  const { raw, dir } = makeTempDb();
  // Dedicated migrations dir with ONLY the 178 file — must be set before the
  // migrationRunner module is loaded (MIGRATIONS_DIR resolves at import time).
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-178-runner-"));
  fs.copyFileSync(MIGRATION_178_PATH, path.join(migrationsDir, "178_backend_analysis.sql"));
  process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;
  try {
    const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
    const adapter = createBetterSqliteAdapter(raw);
    const applied = runMigrations(adapter, { isNewDb: true });
    assert.equal(applied, 1, "ledger marker must be recorded");
    const ledger = raw
      .prepare("SELECT version, name FROM _omniroute_migrations WHERE version = '178'")
      .get() as { version: string; name: string } | undefined;
    assert.ok(ledger, "version 178 recorded in the ledger");
    assert.equal(ledger?.name, "backend_analysis");
    // The pre-existing schema survives untouched.
    assert.ok(columnInfo(raw, "call_logs", "error_raw_head"), "column still present");
  } finally {
    delete process.env.OMNIROUTE_MIGRATIONS_DIR;
    dispose(raw, dir);
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
});
