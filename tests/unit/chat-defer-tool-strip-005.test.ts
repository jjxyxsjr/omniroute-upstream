// 005-defer-strip: WorkBuddy 5.3.14 injects a ToolSearch/DeferExecuteTool pair into
// custom-model sessions. The pair's descriptions lack the "listed tools can be called
// directly" declaration, so high-compliance models (glm-5.x) loop on ToolSearch and
// conclude direct tools (Read/Bash/...) are unavailable — they are not in the search
// index. The gateway strips the pair right after body validation, before any routing
// decision. STRIP_DEFER_TOOLS="0"/"false" disables the strip so an emergency rollback
// needs only an env change + restart, never a code change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-defer-strip-005-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");

const originalFetch = globalThis.fetch;
const originalStripEnv = process.env.STRIP_DEFER_TOOLS;

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function deferTools(): unknown[] {
  return [
    { type: "function", function: { name: "Read", description: "read a file" } },
    { type: "function", function: { name: "ToolSearch", description: "search deferred tools" } },
    {
      type: "function",
      function: { name: "DeferExecuteTool", description: "execute a deferred tool" },
    },
    { type: "function", function: { name: "Bash", description: "run a shell command" } },
  ];
}

function makeRequest(tools: unknown, marker: string): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4.1",
      messages: [{ role: "user", content: `Reply with OK only. (${marker})` }],
      max_tokens: 16,
      stream: false,
      temperature: 0,
      tools,
    }),
  });
}

async function postAndCapture(
  tools: unknown,
  marker: string
): Promise<{ status: number; upstream: CapturedRequest | null }> {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({
      id: "chatcmpl-defer-strip-test",
      choices: [{ message: { role: "assistant", content: "OK" } }],
    });
  }) as typeof fetch;
  const response = await chatRoute.POST(makeRequest(tools, marker));
  return { status: response.status, upstream: calls[0] ?? null };
}

function upstreamToolNames(upstream: CapturedRequest | null): string[] {
  const tools = upstream?.body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => {
    const fn = (t as { function?: { name?: string } }).function;
    return fn?.name ?? (t as { name?: string }).name ?? "";
  });
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-defer-strip-test",
    apiKey: "sk-defer-strip-test",
    isActive: true,
    testStatus: "active",
  });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStripEnv === undefined) delete process.env.STRIP_DEFER_TOOLS;
  else process.env.STRIP_DEFER_TOOLS = originalStripEnv;
});

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("#005 strips the WorkBuddy ToolSearch/DeferExecuteTool pair before upstream dispatch", async () => {
  const { status, upstream } = await postAndCapture(deferTools(), "strip-on");
  assert.equal(status, 200);
  assert.ok(upstream, "request must reach the upstream");
  // nnd.31: chatCore's memory/skills pass sorts the outgoing tools by name (upstream
  // behavior independent of this strip), so assert the pair was removed and the two
  // direct tools survive — in the name-sorted delivery order.
  assert.deepEqual(upstreamToolNames(upstream), ["Bash", "Read"]);
  assert.ok(
    Array.isArray(upstream.body.messages) && upstream.body.messages.length > 0,
    "messages must survive the strip untouched"
  );
});

test("#005 leaves non-WorkBuddy tools untouched (order and count preserved)", async () => {
  const tools = [
    { type: "function", function: { name: "Read", description: "read a file" } },
    { type: "function", function: { name: "web_search", description: "search the web" } },
    { type: "function", function: { name: "Bash", description: "run a shell command" } },
  ];
  const { status, upstream } = await postAndCapture(tools, "untouched");
  assert.equal(status, 200);
  assert.ok(upstream, "request must reach the upstream");
  assert.deepEqual(upstreamToolNames(upstream), ["Bash", "Read", "web_search"]);
});

test("#005 STRIP_DEFER_TOOLS=0 passes the pair through (rollback switch)", async () => {
  process.env.STRIP_DEFER_TOOLS = "0";
  const { status, upstream } = await postAndCapture(deferTools(), "env-off");
  assert.equal(status, 200);
  assert.ok(upstream, "request must reach the upstream");
  assert.deepEqual(upstreamToolNames(upstream), ["Bash", "DeferExecuteTool", "Read", "ToolSearch"]);
});

test("#005 STRIP_DEFER_TOOLS=false also disables the strip", async () => {
  process.env.STRIP_DEFER_TOOLS = "false";
  const { status, upstream } = await postAndCapture(deferTools(), "env-false");
  assert.equal(status, 200);
  assert.ok(upstream, "request must reach the upstream");
  assert.deepEqual(upstreamToolNames(upstream), ["Bash", "DeferExecuteTool", "Read", "ToolSearch"]);
});

test("#005 strips Anthropic-shape tools keyed by name (no function wrapper)", async () => {
  const tools = [
    { name: "ToolSearch", description: "search deferred tools" },
    { name: "Read", description: "read a file" },
    { name: "DeferExecuteTool", description: "execute a deferred tool" },
  ];
  const { status, upstream } = await postAndCapture(tools, "anthropic-shape");
  assert.equal(status, 200);
  assert.ok(upstream, "request must reach the upstream");
  assert.deepEqual(upstreamToolNames(upstream), ["Read"]);
});
