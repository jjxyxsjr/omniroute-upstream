/**
 * Plan B (nnd.11) — prune-on-create retention for managed DB backups.
 * `db_*_<reason>.sqlite` files are created by the 6h health-check repair path
 * (~4/day at ~1x DB size). Retention keeps the newest 3 per reason and runs
 * with the backup itself, so the count can never run away regardless of cron
 * health. Cross-reason isolation is asserted (pre-migration / trial files
 * untouched).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pruneManagedDbBackups } from "../../src/lib/db/core.ts";

function touch(dir: string, name: string, ageMinutes: number) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  const t = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(p, t, t);
}

test("prune keeps newest 3 of the reason and deletes older ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbprune-"));
  try {
    for (let i = 0; i < 5; i++) {
      touch(dir, `db_2026-09-01T0${i}_00-00-000Z_health-check-repair.sqlite`, 600 - i * 10);
    }
    touch(dir, `db_2026-09-01T01_pre-migration.sqlite`, 30);
    touch(dir, `trial-nnd7.sqlite`, 30);
    const removed = pruneManagedDbBackups("health-check-repair", 3, dir);
    assert.equal(removed, 2);
    const remaining = fs.readdirSync(dir).sort();
    assert.equal(remaining.length, 5, "3 newest reason files + pre-migration + trial");
    assert.ok(remaining.every((n) => !n.startsWith("db_2026-09-01T00")), "oldest reason file gone");
    assert.ok(remaining.includes("trial-nnd7.sqlite"), "other files untouched");
    assert.ok(remaining.some((n) => n.includes("pre-migration")), "other reasons untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prune is a no-op at or below the keep count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbprune-"));
  try {
    touch(dir, "db_a_health-check-repair.sqlite", 10);
    touch(dir, "db_b_health-check-repair.sqlite", 5);
    assert.equal(pruneManagedDbBackups("health-check-repair", 3, dir), 0);
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
