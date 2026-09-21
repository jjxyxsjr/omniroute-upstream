// nnd.30 单测：GLM 5h 窗去同步（161 设计件 D）。
// 背景：智谱 1308 按账号开窗，七账号窗自然同步 → 同分钟集体见底
// （2026-09-21 15:46 群体 503 导火索）。机制：已验证上游重置点上叠加
// 池内首见序号 × 错峰步长。红线：合成估计绝不拉长；非 glm-cn 不生效。
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveGlmWindowStaggerMinutes,
  glmWindowStaggerExtraMs,
  resetGlmWindowStaggerForTests,
} from "../../open-sse/services/glmWindowStagger.ts";

test("env 旋钮：默认 8 分钟 / 显式 / 0=关 / 无效回落", () => {
  assert.equal(resolveGlmWindowStaggerMinutes({}), 8);
  assert.equal(resolveGlmWindowStaggerMinutes({ OMNIROUTE_GLM_WINDOW_STAGGER_MIN: "12" }), 12);
  assert.equal(resolveGlmWindowStaggerMinutes({ OMNIROUTE_GLM_WINDOW_STAGGER_MIN: "0" }), 0);
  assert.equal(resolveGlmWindowStaggerMinutes({ OMNIROUTE_GLM_WINDOW_STAGGER_MIN: "x" }), 8);
});

test("glm-cn + 已验证 reset：首见序号决定错峰量（0/1/2 号连接）", () => {
  resetGlmWindowStaggerForTests();
  assert.equal(
    glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: "conn-a", upstreamResetVerified: true, env: {} }),
    0,
    "首个观察到的连接不加长"
  );
  assert.equal(
    glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: "conn-b", upstreamResetVerified: true, env: {} }),
    8 * 60_000
  );
  assert.equal(
    glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: "conn-c", upstreamResetVerified: true, env: {} }),
    16 * 60_000
  );
  // 同一连接重复观察：序号稳定不涨
  assert.equal(
    glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: "conn-b", upstreamResetVerified: true, env: {} }),
    8 * 60_000
  );
});

test("红线：合成估计（未验证 reset）与非 glm-cn 一律不加长", () => {
  resetGlmWindowStaggerForTests();
  assert.equal(
    glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: "z", upstreamResetVerified: false, env: {} }),
    0
  );
  assert.equal(
    glmWindowStaggerExtraMs({
      provider: "anthropic-compatible-x",
      connectionId: "z",
      upstreamResetVerified: true,
      env: {},
    }),
    0
  );
  assert.equal(glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: "", upstreamResetVerified: true, env: {} }), 0);
  assert.equal(glmWindowStaggerExtraMs({ provider: "glm-cn", connectionId: null, upstreamResetVerified: true, env: {} }), 0);
});

test("开关：OMNIROUTE_GLM_WINDOW_STAGGER_MIN=0 全关", () => {
  resetGlmWindowStaggerForTests();
  assert.equal(
    glmWindowStaggerExtraMs({
      provider: "glm-cn",
      connectionId: "c1",
      upstreamResetVerified: true,
      env: { OMNIROUTE_GLM_WINDOW_STAGGER_MIN: "0" },
    }),
    0
  );
});
