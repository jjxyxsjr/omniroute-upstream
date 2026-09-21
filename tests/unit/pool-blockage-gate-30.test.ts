// nnd.30 单测：受阻池自适应闸门（161 设计件 A/B/C 的核心逻辑）。
// 背景：2026-09-21 两场秒拒风暴（钉扎×短冷却 25 连发；GLM 同步撞墙×
// 洪峰 140 笔）。闸门契约：全池最早恢复时刻在等待帽内 → 有界挂起重派；
// 帽外/关闭/队满 → 交给错误出口（429+Retry-After）；客户端断开 → abort。
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePoolWaitCapMs,
  resolvePoolParkMax,
  resolveBlockedPoolStatus,
  createPoolBlockageGate,
  resetPoolGateStateForTests,
  parkedCountForCombo,
} from "../../open-sse/services/combo/poolBlockageGate.ts";

test("env 旋钮：默认值 / 显式值 / 无效值回落 / 0=关闭（nnd.18 惯例）", () => {
  assert.equal(resolvePoolWaitCapMs({}), 10_000);
  assert.equal(resolvePoolWaitCapMs({ OMNIROUTE_POOL_WAIT_CAP_MS: "2500" }), 2500);
  assert.equal(resolvePoolWaitCapMs({ OMNIROUTE_POOL_WAIT_CAP_MS: "0" }), 0);
  assert.equal(resolvePoolWaitCapMs({ OMNIROUTE_POOL_WAIT_CAP_MS: "abc" }), 10_000);
  assert.equal(resolvePoolWaitCapMs({ OMNIROUTE_POOL_WAIT_CAP_MS: "-5" }), 10_000);

  assert.equal(resolvePoolParkMax({}), 64);
  assert.equal(resolvePoolParkMax({ OMNIROUTE_POOL_PARK_MAX: "8" }), 8);
  assert.equal(resolvePoolParkMax({ OMNIROUTE_POOL_PARK_MAX: "nope" }), 64);

  assert.equal(resolveBlockedPoolStatus({}), 429);
  assert.equal(resolveBlockedPoolStatus({ OMNIROUTE_BLOCKED_POOL_STATUS: "503" }), 503);
  assert.equal(resolveBlockedPoolStatus({ OMNIROUTE_BLOCKED_POOL_STATUS: "garbage" }), 429);
});

test("短阻碍：readyAt 在帽内 → 挂起后 redispatch", async () => {
  resetPoolGateStateForTests();
  const gate = createPoolBlockageGate({ comboName: "t-short", env: {} });
  const t0 = Date.now();
  const decision = await gate.parkFor(Date.now() + 150);
  assert.equal(decision, "redispatch");
  assert.ok(Date.now() - t0 >= 140, "应真实等到 readyAt");
  assert.equal(parkedCountForCombo("t-short"), 0, "释放后队列清零");
  assert.equal(gate.parkedOnce(), true);
});

test("无恢复时刻 / 帽关闭 → 立即 timeout（不挂起）", async () => {
  resetPoolGateStateForTests();
  const off = createPoolBlockageGate({ comboName: "t-off", env: { OMNIROUTE_POOL_WAIT_CAP_MS: "0" } });
  const t0 = Date.now();
  assert.equal(await off.parkFor(Date.now() + 100), "timeout");
  assert.ok(Date.now() - t0 < 50, "帽关闭必须秒回，绝不等待");

  const noReady = createPoolBlockageGate({ comboName: "t-null", env: {} });
  assert.equal(await noReady.parkFor(null), "timeout");
  assert.equal(await noReady.parkFor(Number.NaN), "timeout");
});

test("长阻碍：readyAt 超出预算 → timeout（走 429 出口）", async () => {
  resetPoolGateStateForTests();
  const gate = createPoolBlockageGate({
    comboName: "t-long",
    env: { OMNIROUTE_POOL_WAIT_CAP_MS: "200" },
  });
  const t0 = Date.now();
  assert.equal(await gate.parkFor(Date.now() + 60_000), "timeout");
  assert.ok(Date.now() - t0 < 50, "预算外必须秒回");
});

test("预算跨多次 park 共享：两次短 park 总量超帽后第三次 timeout", async () => {
  resetPoolGateStateForTests();
  const gate = createPoolBlockageGate({
    comboName: "t-budget",
    env: { OMNIROUTE_POOL_WAIT_CAP_MS: "300" },
  });
  assert.equal(await gate.parkFor(Date.now() + 120), "redispatch");
  assert.equal(await gate.parkFor(Date.now() + 150), "redispatch");
  // 已耗 ~270ms，帽 300ms：再要 100ms 就超预算
  assert.equal(await gate.parkFor(Date.now() + 100), "timeout");
});

test("挂起队列封顶：parkMax 满时新请求 timeout，释放后恢复", async () => {
  resetPoolGateStateForTests();
  const env = { OMNIROUTE_POOL_PARK_MAX: "1", OMNIROUTE_POOL_WAIT_CAP_MS: "5000" };
  const holder = createPoolBlockageGate({ comboName: "t-full", env });
  const holding = holder.parkFor(Date.now() + 400); // 占住唯一槽位
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(parkedCountForCombo("t-full"), 1);
  const second = createPoolBlockageGate({ comboName: "t-full", env });
  assert.equal(await second.parkFor(Date.now() + 100), "timeout", "队满必须拒绝入队");
  assert.equal(await holding, "redispatch");
  assert.equal(parkedCountForCombo("t-full"), 0, "释放后槽位归还");
  const third = createPoolBlockageGate({ comboName: "t-full", env });
  assert.equal(await third.parkFor(Date.now() + 50), "redispatch");
});

test("客户端断开：挂起中 abort → 立即返回 abort", async () => {
  resetPoolGateStateForTests();
  const controller = new AbortController();
  const gate = createPoolBlockageGate({
    comboName: "t-abort",
    signal: controller.signal,
    env: { OMNIROUTE_POOL_WAIT_CAP_MS: "10000" },
  });
  const parked = gate.parkFor(Date.now() + 5_000);
  setTimeout(() => controller.abort(), 60);
  const t0 = Date.now();
  assert.equal(await parked, "abort");
  assert.ok(Date.now() - t0 < 400, "abort 必须立刻打断挂起");
  assert.equal(parkedCountForCombo("t-abort"), 0, "abort 后槽位归还");
});

test("已在过去的 readyAt → 立即 redispatch（零等待）", async () => {
  resetPoolGateStateForTests();
  const gate = createPoolBlockageGate({ comboName: "t-past", env: {} });
  const t0 = Date.now();
  assert.equal(await gate.parkFor(Date.now() - 1000), "redispatch");
  assert.ok(Date.now() - t0 < 50);
});
