import test from "node:test";
import assert from "node:assert/strict";
import { buildScannerArgs, buildScannerEnv } from "../src/scanner.ts";
import type { WrapperOptions } from "../src/types.ts";

const baseOptions: WrapperOptions = {
  backendUrl: "https://dashboard.oryontechnology.com",
  workspace: "/tmp/repo",
  outDir: ".oryon",
  scannerVersion: "v1",
  upload: true,
  ai: true,
  report: "none",
  sarif: true,
  failOn: "none"
};

test("builds scanner args from action inputs", () => {
  assert.deepEqual(buildScannerArgs(baseOptions), [
    "scan",
    "--backend-url",
    "https://dashboard.oryontechnology.com",
    "--workspace",
    "/tmp/repo",
    "--out-dir",
    ".oryon",
    "--fail-on",
    "none",
    "--report",
    "none"
  ]);
});

test("adds disabling flags for optional features", () => {
  const args = buildScannerArgs({
    ...baseOptions,
    upload: false,
    ai: false,
    sarif: false
  });

  assert.ok(args.includes("--no-upload"));
  assert.ok(args.includes("--no-ai"));
  assert.ok(args.includes("--no-sarif"));
});

test("maps OpenAI bootstrap leases into process env", () => {
  const env = buildScannerEnv({
    ciToken: "oryon_ci_test",
    ai: {
      provider: "openai",
      key: "test-provider-key",
      expiresAt: "2026-05-08T20:00:00Z"
    }
  });

  assert.equal(env.ORYON_CI_TOKEN, "oryon_ci_test");
  assert.equal(env.ORYON_AI_PROVIDER, "openai");
  assert.equal(env.ORYON_AI_PROVIDER_KEY, "test-provider-key");
  assert.equal(env.OPENAI_API_KEY, "test-provider-key");
});
