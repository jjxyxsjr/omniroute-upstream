// iid 241 defusal: fork migrations renumbered 213-216 → 9213-9216 so upstream
// v3.8.53+ can occupy the old slots. This test reproduces the merge-day shape:
// a database that ran the fork's 213-216 (stale ledger rows) meets a migration
// directory where the fork files live at 9xxx and upstream's own 213-216 sit in
// the freed slots. The runner must reconcile the stale rows AND apply the
// upstream migrations — version-only tracking would have silently skipped them.
import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const serial = { concurrency: false };

async function importFresh(modulePath: string) {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  return import(`${url}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function withMockedMigrationFs(files: Record<string, string>, fn: () => void) {
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  const originalReadFileSync = fs.readFileSync;
  const isMigrationDir = (target: PathLike) =>
    String(target).replaceAll("\\", "/").endsWith("/src/lib/db/migrations") ||
    String(target).replaceAll("\\", "/").endsWith("/migrations");

  fs.existsSync = (target) => {
    const fileName = path.basename(String(target));
    if (isMigrationDir(target) || Object.hasOwn(files, fileName)) return true;
    return originalExistsSync(target);
  };
  fs.readdirSync = ((target: PathLike) => {
    if (isMigrationDir(target)) return Object.keys(files);
    return originalReaddirSync(target);
  }) as typeof fs.readdirSync;
  fs.readFileSync = ((target: PathLike, options?: { encoding?: BufferEncoding | null }) => {
    const fileName = path.basename(String(target));
    if (Object.hasOwn(files, fileName)) return files[fileName];
    return originalReadFileSync(target, options);
  }) as typeof fs.readFileSync;

  try {
    fn();
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
  }
}

const STALE_LEDGER_ROWS: Array<[string, string]> = [
  ["213", "fork_call_logs_error_raw_head"],
  ["214", "fork_radar_feed_generated_at"],
  ["215", "fork_call_logs_queue_wait_ms"],
  ["216", "fork_call_logs_latency_phases"],
];

test(
  "merge-day shape: stale fork 213-216 ledger rows free the slots for upstream's own 213-216",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      db.exec(`
        CREATE TABLE _omniroute_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- the columns our fork migrations own (probes see them as applied)
        CREATE TABLE call_logs (id TEXT PRIMARY KEY, error_raw_head TEXT);
        CREATE TABLE radar_feed_cache (id TEXT PRIMARY KEY, generated_at TEXT);
      `);
      for (const [version, name] of STALE_LEDGER_ROWS) {
        db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)").run(
          version,
          name
        );
      }

      // Merge-day directory: fork files at 9xxx, upstream's own 213/214 in the
      // freed slots. The fork SQL must NOT re-run (schema exists) and the
      // upstream SQL MUST run (fresh tables).
      withMockedMigrationFs(
        {
          "213_api_key_preferred_connections.sql":
            "CREATE TABLE api_key_preferred_connections (id TEXT PRIMARY KEY);",
          "214_call_logs_client_session_id.sql":
            "CREATE TABLE client_session_marker_214 (id TEXT PRIMARY KEY);",
          "9213_fork_call_logs_error_raw_head.sql":
            "ALTER TABLE call_logs ADD COLUMN error_raw_head TEXT;",
          "9214_fork_radar_feed_generated_at.sql":
            "ALTER TABLE radar_feed_cache ADD COLUMN generated_at TEXT;",
          "9215_fork_call_logs_queue_wait_ms.sql":
            "ALTER TABLE call_logs ADD COLUMN error_raw_head TEXT;",
          "9216_fork_call_logs_latency_phases.sql":
            "ALTER TABLE call_logs ADD COLUMN error_raw_head TEXT;",
        },
        () => runner.runMigrations(db)
      );

      const applied = db
        .prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version")
        .all() as Array<{ version: string; name: string }>;
      const byVersion = new Map(applied.map((row) => [row.version, row.name]));

      // Stale rows rewritten (or deleted-if-duplicated) — slots free for upstream.
      assert.equal(byVersion.get("213"), "api_key_preferred_connections");
      assert.equal(byVersion.get("214"), "call_logs_client_session_id");
      // Fork migrations recorded at their new home.
      assert.equal(byVersion.get("9213"), "fork_call_logs_error_raw_head");
      assert.equal(byVersion.get("9214"), "fork_radar_feed_generated_at");
      assert.equal(byVersion.get("9215"), "fork_call_logs_queue_wait_ms");
      assert.equal(byVersion.get("9216"), "fork_call_logs_latency_phases");
      // Upstream migrations physically applied — the whole point of the defusal.
      assert.ok(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("api_key_preferred_connections")
      );
      assert.ok(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("client_session_marker_214")
      );
    } finally {
      db.close();
    }
  }
);

test(
  "pre-merge shape: renamed fork files boot on the old ledger without re-running",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      db.exec(`
        CREATE TABLE _omniroute_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE call_logs (id TEXT PRIMARY KEY, error_raw_head TEXT, queue_wait_ms TEXT);
        CREATE TABLE radar_feed_cache (id TEXT PRIMARY KEY, generated_at TEXT);
      `);
      for (const [version, name] of STALE_LEDGER_ROWS) {
        db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)").run(
          version,
          name
        );
      }

      // Pre-merge directory: only the renamed fork files exist; no foreign file
      // occupies the old slots yet, so reconcile stays dormant and the probes
      // (isSchemaAlreadyApplied 9213-9216) record the new versions without
      // re-running the SQL. A canary column proves no fork file executed.
      withMockedMigrationFs(
        {
          "9213_fork_call_logs_error_raw_head.sql":
            "ALTER TABLE call_logs ADD COLUMN fork_canary_must_not_exist TEXT;",
          "9214_fork_radar_feed_generated_at.sql":
            "ALTER TABLE radar_feed_cache ADD COLUMN fork_canary_must_not_exist TEXT;",
          "9215_fork_call_logs_queue_wait_ms.sql":
            "ALTER TABLE call_logs ADD COLUMN fork_canary_must_not_exist_b TEXT;",
          "9216_fork_call_logs_latency_phases.sql":
            "ALTER TABLE call_logs ADD COLUMN fork_canary_must_not_exist_c TEXT;",
        },
        () => runner.runMigrations(db)
      );

      const applied = db
        .prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version")
        .all() as Array<{ version: string; name: string }>;
      const byVersion = new Map(applied.map((row) => [row.version, row.name]));
      assert.equal(byVersion.get("9213"), "fork_call_logs_error_raw_head");
      assert.equal(byVersion.get("9214"), "fork_radar_feed_generated_at");
      assert.equal(byVersion.get("9215"), "fork_call_logs_queue_wait_ms");
      assert.equal(byVersion.get("9216"), "fork_call_logs_latency_phases");
      assert.equal(
        db
          .prepare(
            "SELECT 1 FROM pragma_table_info('call_logs') WHERE name = 'fork_canary_must_not_exist'"
          )
          .get(),
        undefined,
        "renamed fork migrations must not re-execute on an already-migrated database"
      );
    } finally {
      db.close();
    }
  }
);
