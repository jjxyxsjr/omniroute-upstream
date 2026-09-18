/**
 * #88 (nnd.29) — volume-aware direct-path first-byte probe window.
 *
 * A flat 45s response-start probe cannot distinguish "dead pooled socket"
 * from "live upstream still prefilling a huge context": 600k-token sessions
 * measured 40-75s to first byte on glm (bare-fetch path, survived) while the
 * same sessions on the proxyFetch direct path died at exactly 45s
 * (2026-09-18 向海涛 2×504, 1821-message transcripts on ark-code-latest).
 *
 * These tests cover the pure resolution logic: tier scaling, cap, kill
 * switch, and conservative body-size measurement (unknown shapes never widen).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveVolumeAwareDirectHeadersTimeoutMs,
  isVolumeAdaptiveDirectHeadersEnabled,
  measureDirectRequestBodyBytes,
} from "../../open-sse/utils/directResponseStartTimeout.ts";

const NO_ENV: Record<string, string | undefined> = {};

test("tier truth table: base window scales by body size", () => {
  const base = 45_000;
  // ≤512KB → unchanged (small body overrunning the probe ≈ dead connection)
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(base, 0, NO_ENV), base);
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(base, 1, NO_ENV), base);
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(base, 512 * 1024, NO_ENV), base);
  // >512KB → ×2
  assert.equal(
    resolveVolumeAwareDirectHeadersTimeoutMs(base, 512 * 1024 + 1, NO_ENV),
    base * 2
  );
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(base, 2 * 1024 * 1024, NO_ENV), base * 2);
  // >2MB → ×3
  assert.equal(
    resolveVolumeAwareDirectHeadersTimeoutMs(base, 2 * 1024 * 1024 + 1, NO_ENV),
    base * 3
  );
  // ~600k-token transcript (≈2.5MB JSON) lands in the ×3 tier → 135s probe,
  // comfortably above the observed 40-75s glm first-byte times.
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(base, 2.5 * 1024 * 1024, NO_ENV), 135_000);
});

test("cap: widened window never exceeds 180s", () => {
  // base 70s ×3 = 210s → capped at 180s
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(70_000, 3 * 1024 * 1024, NO_ENV), 180_000);
});

test("degenerate inputs never widen: base<=0 or body<=0 pass through", () => {
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(0, 10 * 1024 * 1024, NO_ENV), 0);
  assert.equal(resolveVolumeAwareDirectHeadersTimeoutMs(45_000, 0, NO_ENV), 45_000);
});

test("kill switch: OMNIROUTE_DIRECT_HEADERS_VOLUME_ADAPTIVE=0 restores flat window", () => {
  const off: Record<string, string | undefined> = {
    OMNIROUTE_DIRECT_HEADERS_VOLUME_ADAPTIVE: "0",
  };
  assert.equal(
    resolveVolumeAwareDirectHeadersTimeoutMs(45_000, 5 * 1024 * 1024, off),
    45_000
  );
  assert.equal(isVolumeAdaptiveDirectHeadersEnabled(off), false);
});

test("kill switch accepts false/off (case-insensitive), defaults to enabled", () => {
  assert.equal(isVolumeAdaptiveDirectHeadersEnabled({}), true);
  assert.equal(isVolumeAdaptiveDirectHeadersEnabled(NO_ENV), true);
  for (const v of ["false", "FALSE", "Off", " 0 "]) {
    assert.equal(
      isVolumeAdaptiveDirectHeadersEnabled({ OMNIROUTE_DIRECT_HEADERS_VOLUME_ADAPTIVE: v }),
      false,
      `value ${JSON.stringify(v)} should disable`
    );
  }
  // Garbage values do NOT disable (nnd.18 convention: fall back to default ON)
  assert.equal(
    isVolumeAdaptiveDirectHeadersEnabled({ OMNIROUTE_DIRECT_HEADERS_VOLUME_ADAPTIVE: "yes?" }),
    true
  );
});

test("measureDirectRequestBodyBytes: string / typed array / unknown shapes", () => {
  assert.equal(measureDirectRequestBodyBytes("https://x", { body: "hello" }), 5);
  const ascii = "a".repeat(1024);
  assert.equal(measureDirectRequestBodyBytes("https://x", { body: ascii }), 1024);
  // multi-byte content counts BYTES, not chars
  assert.equal(measureDirectRequestBodyBytes("https://x", { body: "é" }), 2);
  assert.equal(
    measureDirectRequestBodyBytes("https://x", { body: new Uint8Array(2048) }),
    2048
  );
  assert.equal(
    measureDirectRequestBodyBytes("https://x", { body: new ArrayBuffer(4096) }),
    4096
  );
  // streams / form data / absent body → 0 (conservative base window)
  assert.equal(measureDirectRequestBodyBytes("https://x", {}), 0);
  assert.equal(
    measureDirectRequestBodyBytes("https://x", { body: new ReadableStream() }),
    0
  );
  assert.equal(measureDirectRequestBodyBytes("https://x"), 0);
});

test("measureDirectRequestBodyBytes: Request objects use content-length when present", () => {
  const req = new Request("https://x", {
    method: "POST",
    body: "y".repeat(1234),
    headers: { "content-length": "1234" },
  });
  assert.equal(measureDirectRequestBodyBytes(req), 1234);
  // Request without content-length → 0 (never clone-and-measure: consuming
  // the body would break the actual dispatch)
  const req2 = new Request("https://x", { method: "POST", body: "z".repeat(99) });
  req2.headers.delete("content-length");
  assert.equal(measureDirectRequestBodyBytes(req2), 0);
});
