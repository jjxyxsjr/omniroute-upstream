/**
 * nnd.23 ② gen-1 — 上游首字画像：采样、分桶 p90、窗口收窄语义。
 *
 * 关键纪律：样本不足(<5)必须返回 null 且窗口回退默认（绝不拿两三个样本调
 * 窗口）；画像只允许把第二段窗口收窄到默认之下（快上游快失败），永不放大
 * 超过 nnd.21 候A 的对齐天花板。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  __test_resetUpstreamProfiles,
  applyFirstByteProfileToWindow,
  getFirstByteP90Ms,
  recordFirstByteMs,
} from "../../open-sse/services/upstreamProfiles.ts";

test("nnd.23 ② sampler: p90 per host×hour bucket; <5 samples → null (never guess)", () => {
  __test_resetUpstreamProfiles();
  const t14 = new Date("2026-09-10T14:00:00Z");
  assert.equal(getFirstByteP90Ms("open.bigmodel.cn", t14), null);
  recordFirstByteMs("open.bigmodel.cn", 8_000, t14);
  recordFirstByteMs("open.bigmodel.cn", 9_000, t14);
  assert.equal(getFirstByteP90Ms("open.bigmodel.cn", t14), null); // 2 个样本仍未知
  for (const ms of [8_500, 9_200, 8_800, 12_000, 8_900, 9_100]) {
    recordFirstByteMs("open.bigmodel.cn", ms, t14);
  }
  const p90 = getFirstByteP90Ms("open.bigmodel.cn", t14);
  assert.ok(p90 !== null && p90 >= 9_100 && p90 <= 12_000, `p90=${p90}`);
  // 不同小时桶隔离
  const t15 = new Date("2026-09-10T15:00:00Z");
  assert.equal(getFirstByteP90Ms("open.bigmodel.cn", t15), null);
  // host 大小写不敏感
  assert.equal(getFirstByteP90Ms("OPEN.BIGMODEL.CN", t14), p90);
});

test("nnd.23 ② window: profile may only narrow, never widen past the aligned default", () => {
  // 无画像 → 默认不动
  assert.equal(applyFirstByteProfileToWindow(120_000, 45_000, null), 120_000);
  // 快上游 p90=9s → 9s×2.5=22.5s，收窄到 22.5s（≥池段 45s？不——45s 池段是地板）
  assert.equal(applyFirstByteProfileToWindow(120_000, 45_000, 9_000), 45_000);
  // 池段=30s（代码默认）时：22.5s 被 30s 地板顶到 30s
  assert.equal(applyFirstByteProfileToWindow(180_000, 30_000, 9_000), 30_000);
  // 慢上游 p90=60s → 150s 超过默认 120s → 封在 120s（永不放大）
  assert.equal(applyFirstByteProfileToWindow(120_000, 45_000, 60_000), 120_000);
  // 中等 p90=30s → 75s
  assert.equal(applyFirstByteProfileToWindow(120_000, 45_000, 30_000), 75_000);
  // 禁用（<=0）跟随禁用
  assert.equal(applyFirstByteProfileToWindow(0, 45_000, 9_000), 0);
  // 非法画像值 → 默认
  assert.equal(applyFirstByteProfileToWindow(120_000, 45_000, Number.NaN), 120_000);
});
