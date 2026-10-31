import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

async function actionFixture(input: { bootstrapFailure?: boolean; threshold?: boolean; azure?: boolean; killed?: boolean }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "oryon-wrapper-test-"));
  const workspace = path.join(temp, "repo");
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(temp, "scanner"));
  const scannerSource = `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync('.oryon', { recursive: true });
fs.writeFileSync('.oryon/oryon-results.json', JSON.stringify({ scan: { findings: [{}, {}, {}], stats: { findings: 3 } } }));
fs.writeFileSync('.oryon/oryon-summary.md', 'Partial evidence');
fs.writeFileSync('.oryon/oryon-run.json', JSON.stringify({ runId: process.env.ORYON_RUN_ID, status: '${input.killed ? "running" : input.threshold ? "completed" : "failed"}' }));
console.error('${input.threshold ? "Severity threshold exceeded" : "Suppression lookup failed: HTTP 403"} '+process.env.ORYON_AI_PROVIDER_KEY);
${input.killed ? "process.kill(process.pid, 'SIGTERM');" : `process.exit(${input.threshold ? 2 : 1});`}
`;
  await fs.writeFile(path.join(temp, "scanner", "cli.cjs"), scannerSource, { mode: 0o755 });
  const archivePath = path.join(temp, "scanner.tar.gz");
  await exec("tar", ["-czf", archivePath, "-C", path.join(temp, "scanner"), "cli.cjs"]);
  const archive = await fs.readFile(archivePath);
  const reports: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/oidc")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ value: "oidc-test-secret-token", oidcToken: "azure-oidc-test-secret-token" }));
    } else if (request.url === "/api/v1/scan-telemetry") {
      reports.push(JSON.parse(await body(request)).report);
      response.end("{}");
    } else if (request.url === "/api/v1/ci/bootstrap") {
      await body(request);
      response.setHeader("Content-Type", "application/json");
      if (input.bootstrapFailure) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: { code: "ci_project_forbidden", message: "Repository is not linked to this project." } }));
      } else {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        response.end(JSON.stringify({
          scanner: { url: `http://127.0.0.1:${address.port}/scanner.tar.gz`, sha256: createHash("sha256").update(archive).digest("hex"), version: "test", entrypoint: "cli.cjs" },
          ai: { provider: "openai", key: "private-provider-test-key" }
        }));
      }
    } else if (request.url === "/scanner.tar.gz") {
      response.end(archive);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const outputPath = path.join(temp, "github-output");
  await fs.writeFile(outputPath, "");
  try {
    let exitCode = 0;
    try {
      await exec(process.execPath, [path.join(root, input.azure ? "azure/oryon-scan.mjs" : "dist/action.cjs")], {
        cwd: workspace,
        env: {
          ...process.env,
          "INPUT_BACKEND-URL": origin,
          INPUT_WORKSPACE: workspace,
          INPUT_UPLOAD: "true",
          INPUT_AI: "true",
          INPUT_SARIF: "true",
          ORYON_BACKEND_URL: origin,
          ORYON_WORKSPACE: workspace,
          SYSTEM_OIDCREQUESTURI: `${origin}/oidc`,
          SYSTEM_ACCESSTOKEN: "azure-oidc-request-secret",
          GITHUB_OUTPUT: outputPath,
          ORYON_CI_TOKEN: "private-ci-test-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-oidc-request-secret"
        }
      });
    } catch (error) {
      exitCode = Number((error as { code: number }).code);
    }
    return {
      exitCode,
      reports,
      outputs: await fs.readFile(outputPath, "utf8"),
      diagnostic: JSON.parse(await fs.readFile(path.join(workspace, ".oryon", "oryon-wrapper-diagnostic.json"), "utf8")),
      log: await fs.readFile(path.join(workspace, ".oryon", "oryon-wrapper.log"), "utf8")
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("publishes real partial artifacts and useful redacted diagnostics when scanner exits 1", async () => {
  const result = await actionFixture({});
  assert.equal(result.exitCode, 1);
  assert.match(result.outputs, /run-id<</);
  assert.match(result.outputs, /results-path<</);
  assert.match(result.outputs, /summary-path<</);
  assert.match(result.outputs, /findings<<[^\n]+\n3\n/);
  assert.doesNotMatch(result.outputs, /sarif-path<</);
  assert.match(result.diagnostic.error.message, /Suppression lookup failed: HTTP 403/);
  assert.match(result.diagnostic.runId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /private-provider-test-key/);
  assert.doesNotMatch(result.log, /private-provider-test-key/);
  assert.equal(result.reports.length, 1, "scanner terminal telemetry must not be overwritten by wrapper failure");
  assert.equal(result.reports[0].status, "running");
  assert.equal(result.reports[0].run_id, result.diagnostic.runId);
});

test("records early bootstrap failure and keeps downloadable diagnostics with the same support ID", async () => {
  const result = await actionFixture({ bootstrapFailure: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[1].status, "failed");
  assert.equal(result.reports[1].error_code, "CI_BOOTSTRAP");
  assert.equal(result.reports[1].phase, "preflight");
  assert.equal(result.reports[1].run_id, result.diagnostic.runId);
  assert.match(result.diagnostic.error.message, /ci_project_forbidden/);
  assert.match(result.outputs, /diagnostic-path<</);
  assert.doesNotMatch(result.outputs, /results-path<</);
});

test("does not turn a successful scan into a failed attempt when only the severity gate fails", async () => {
  const result = await actionFixture({ threshold: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reports.length, 1);
  assert.match(result.outputs, /results-path<</);
});


test("records a killed scanner as failed while preserving its partial artifacts", async () => {
  const result = await actionFixture({ killed: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[1].status, "failed");
  assert.equal(result.reports[1].phase, "scan");
  assert.match(result.diagnostic.error.message, /signal SIGTERM/);
  assert.match(result.outputs, /results-path<</);
});

test("Azure reports early bootstrap failures and saves the same support diagnostic", async () => {
  const result = await actionFixture({ azure: true, bootstrapFailure: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[1].error_code, "CI_BOOTSTRAP");
  assert.equal(result.reports[1].run_id, result.diagnostic.runId);
  assert.match(result.log, /ci_project_forbidden/);
});

test("Azure preserves scanner failures with a redacted diagnostic and shared run ID", async () => {
  const result = await actionFixture({ azure: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reports.length, 1);
  assert.match(result.diagnostic.error.message, /Suppression lookup failed: HTTP 403/);
  assert.doesNotMatch(result.log, /private-provider-test-key/);
  assert.equal(result.reports[0].run_id, result.diagnostic.runId);
});
