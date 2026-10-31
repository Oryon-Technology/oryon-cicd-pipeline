import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectScannerOutputs } from "../src/outputs.ts";
import { redactSecrets } from "../src/diagnostics.ts";
import type { WrapperOptions } from "../src/types.ts";

test("collects only existing files and handles legacy results without inventing a zero count", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "oryon-outputs-test-"));
  const options: WrapperOptions = {
    backendUrl: "https://example.test", workspace, outDir: ".oryon", scannerVersion: "v1",
    upload: true, ai: false, report: "pdf", sarif: true, failOn: "none"
  };
  try {
    assert.deepEqual(await collectScannerOutputs(options), {});
    await fs.mkdir(path.join(workspace, ".oryon"));
    const results = path.join(workspace, ".oryon", "oryon-results.json");
    await fs.writeFile(results, JSON.stringify({ stats: { findings: 7 } }));
    assert.deepEqual(await collectScannerOutputs(options), { "results-path": results, findings: "7" });
    assert.deepEqual(await collectScannerOutputs(options, false), {}, "an early bootstrap failure must not advertise previous scan artifacts");
    await fs.writeFile(results, "{broken JSON");
    assert.deepEqual(await collectScannerOutputs(options), { "results-path": results });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("redacts known credentials, JWTs and signed download URLs before persisting diagnostics", () => {
  const raw = "provider=private-provider-key Bearer abcdef123456 eyJabc.def.ghi https://example.test/archive?signature=secret";
  const safe = redactSecrets(raw, { ORYON_AI_PROVIDER_KEY: "private-provider-key" });
  assert.doesNotMatch(safe, /private-provider-key|abcdef123456|eyJabc|signature=secret/);
  assert.match(safe, /https:\/\/example.test\/archive\?\[redacted\]/);
});
