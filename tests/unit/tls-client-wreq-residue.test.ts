import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EXPECTED_BINDINGS = [
  "@wreq-js/binding-android-arm64",
  "@wreq-js/binding-darwin-arm64",
  "@wreq-js/binding-darwin-x64",
  "@wreq-js/binding-linux-arm64-gnu",
  "@wreq-js/binding-linux-arm64-musl",
  "@wreq-js/binding-linux-x64-gnu",
  "@wreq-js/binding-linux-x64-musl",
  "@wreq-js/binding-win32-arm64-msvc",
  "@wreq-js/binding-win32-x64-msvc",
].sort();

// nnd fork caliber (155 #13/#43/#52 + #71): upstream's wreq-js migration test
// asserts tls-client-node is GONE; this fork deliberately still ships it —
// pinned EXACTLY 0.2.0 (nnd.18 pin), binary vendored (vendor/tls-client seed),
// postinstall forced offline via TLS_CLIENT_SKIP_DOWNLOAD=1 in the Dockerfile,
// and registered in config/quality/dependency-allowlist.json with a
// justification. The wreq-js half of the upstream contract (3.2.0 pin + the
// nine native lock entries + one cached runtime loader) is carried unchanged.
test("the distributable pins wreq-js 3.2.0, keeps the fork's tls-client-node 0.2.0 vendor pin, and carries all nine native lock entries", () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    files: string[];
    optionalDependencies: Record<string, string>;
  };
  assert.equal(packageJson.optionalDependencies["wreq-js"], "3.2.0");
  // Fork pin: exact 0.2.0 (no ^ ranges — 155 #43), NOT removed as upstream did.
  assert.equal(packageJson.optionalDependencies["tls-client-node"], "0.2.0");
  assert.equal(packageJson.files.includes("scripts/build/fixTlsClientNodeBinary.mjs"), false);

  const packageLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<
      string,
      { version?: string; integrity?: string; license?: string; optional?: boolean }
    >;
  };
  const bindingNames = Object.keys(packageLock.packages)
    .filter((key) => key.startsWith("node_modules/@wreq-js/binding-"))
    .map((key) => key.slice("node_modules/".length))
    .sort();
  assert.deepEqual(bindingNames, EXPECTED_BINDINGS);
  for (const packageName of EXPECTED_BINDINGS) {
    const entry = packageLock.packages[`node_modules/${packageName}`];
    assert.equal(entry.version, "3.2.0", `${packageName}: version`);
    assert.match(entry.integrity || "", /^sha512-/, `${packageName}: npm integrity`);
    assert.equal(entry.license, "MIT", `${packageName}: license`);
    assert.equal(entry.optional, true, `${packageName}: optional binding`);
  }

  // Files that must stay free of BOTH the orphaned sidecar and koffi. The
  // Dockerfile (TLS_CLIENT_SKIP_DOWNLOAD=1 offline-build line, 155 #52) and
  // config/quality/dependency-allowlist.json (justified fork dependency, 155
  // #71) are the two files where a tls-client-node reference is deliberate —
  // they only carry the no-koffi guarantee below.
  for (const relativePath of [
    "package-lock.json",
    "next.config.mjs",
    "Dockerfile.bun",
    ".trivyignore",
    "pnpm.json",
    "pnpm-workspace.yaml",
    "config/quality/.license-allowlist.json",
    "scripts/build/postinstall.mjs",
    "scripts/build/pack-artifact-policy.ts",
  ]) {
    const source = readFileSync(join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /tls-client-node/i,
      `${relativePath} still references tls-client-node`
    );
    assert.doesNotMatch(source, /\bkoffi\b/i, `${relativePath} still references orphaned koffi`);
  }

  for (const relativePath of ["Dockerfile", "config/quality/dependency-allowlist.json"]) {
    const source = readFileSync(join(ROOT, relativePath), "utf8");
    assert.match(source, /tls-client-node/i, `${relativePath} must keep its fork vendor wiring`);
    assert.doesNotMatch(source, /\bkoffi\b/i, `${relativePath} still references orphaned koffi`);
  }

  assert.equal(existsSync(join(ROOT, "open-sse/services/tlsClientDownloadDir.ts")), false);
  assert.equal(existsSync(join(ROOT, "scripts/build/fixTlsClientNodeBinary.mjs")), false);

  for (const relativePath of [
    ".env.example",
    "docs/reference/ENVIRONMENT.md",
    "docs/security/STEALTH_GUIDE.md",
    "docs/guides/TROUBLESHOOTING.md",
  ]) {
    const source = readFileSync(join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, /tls-client-node/i, `${relativePath} still names the old sidecar`);
    assert.doesNotMatch(source, /\bkoffi\b/i, `${relativePath} still names the old FFI loader`);
  }
});

test("persistent sessions and ephemeral transports share one wreq runtime loader", () => {
  const source = readFileSync(join(ROOT, "open-sse/utils/tlsClient.ts"), "utf8");
  assert.equal(
    source.match(/loadRuntimeModule\("wreq-js"\)/g)?.length,
    1,
    "wreq-js must be resolved through one cached module loader"
  );
});
