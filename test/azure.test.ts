import test from "node:test";
import assert from "node:assert/strict";

// @ts-ignore
const azureWrapper = await import("../azure/oryon-scan.mjs");

const {
  buildBootstrapRequest,
  buildScannerArgs,
  extractOidcToken,
  normalizeBootstrapLease,
  readAzureOptions,
  requestBootstrap
} = azureWrapper;

const baseEnv = {
  ORYON_BACKEND_URL: "https://dashboard.oryontechnology.com/path",
  ORYON_SCANNER_VERSION: "v1",
  ORYON_FAIL_ON: "high",
  ORYON_REPORT: "pdf",
  ORYON_UPLOAD: "true",
  ORYON_AI: "false",
  ORYON_SARIF: "true",
  BUILD_SOURCESDIRECTORY: "/tmp/repo",
  SYSTEM_COLLECTIONURI: "https://dev.azure.com/oryontechnology/",
  SYSTEM_TEAMPROJECT: "CICD Testing",
  SYSTEM_TEAMPROJECTID: "1ca20077-e01c-49cd-abf3-705c0ef9ca79",
  SYSTEM_DEFINITIONID: "1",
  BUILD_REPOSITORY_ID: "7d2d828a-cb58-4f3c-aba7-aa647348333d",
  BUILD_REPOSITORY_URI: "https://dev.azure.com/oryontechnology/CICD Testing/_git/oryon-azure-probe",
  BUILD_SOURCEBRANCH: "refs/heads/main",
  BUILD_SOURCEVERSION: "0f21b61160644932622a34bc7aaf4fbf8dae9c4e",
  BUILD_BUILDID: "3",
  BUILD_BUILDNUMBER: "20260707.3",
  BUILD_REASON: "Manual"
};

test("reads Azure wrapper options from environment", () => {
  const options = readAzureOptions(baseEnv, "/fallback");

  assert.equal(options.backendUrl, "https://dashboard.oryontechnology.com");
  assert.equal(options.workspace, "/tmp/repo");
  assert.equal(options.scannerVersion, "v1");
  assert.equal(options.upload, true);
  assert.equal(options.ai, false);
  assert.equal(options.sarif, true);
  assert.equal(options.failOn, "high");
  assert.equal(options.report, "pdf");
});

test("builds Azure bootstrap payload from pipeline variables", () => {
  const options = readAzureOptions(baseEnv);
  const payload = buildBootstrapRequest(options, baseEnv);

  assert.equal(payload.scanner_version, "v1");
  assert.equal(payload.inputs.ai, false);
  assert.equal(payload.inputs.fail_on, "high");
  assert.equal(payload.azure.project_id, "1ca20077-e01c-49cd-abf3-705c0ef9ca79");
  assert.equal(payload.azure.pipeline_id, "1");
  assert.equal(payload.azure.repository_id, "7d2d828a-cb58-4f3c-aba7-aa647348333d");
  assert.equal(payload.azure.ref, "refs/heads/main");
  assert.equal(payload.azure.sha, "0f21b61160644932622a34bc7aaf4fbf8dae9c4e");
  assert.equal(payload.azure.run_id, "3");
});

test("extracts Azure OIDC token from known response shapes", () => {
  assert.equal(extractOidcToken(JSON.stringify({ oidcToken: "token-a" })), "token-a");
  assert.equal(extractOidcToken(JSON.stringify({ id_token: "token-b" })), "token-b");
  assert.equal(extractOidcToken("eyJabc.def.ghi"), "eyJabc.def.ghi");
});

test("requests Oryon bootstrap with Azure OIDC header", async () => {
  const options = readAzureOptions(baseEnv);
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://dashboard.oryontechnology.com/api/v1/ci/bootstrap");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer oryon_ci_test");
    assert.equal((init.headers as Record<string, string>)["X-Oryon-Azure-OIDC-Token"], "azure-oidc");

    const body = JSON.parse(String(init.body));
    assert.equal(body.azure.repository_id, "7d2d828a-cb58-4f3c-aba7-aa647348333d");

    return new Response(JSON.stringify({
      scanner: {
        url: "https://storage.example/scanner.tar.gz",
        sha256: "A".repeat(64),
        version: "1.2.3",
        entrypoint: "dist/cli.cjs"
      }
    }));
  };

  const lease = await requestBootstrap({
    options,
    ciToken: "oryon_ci_test",
    oidcToken: "azure-oidc",
    env: baseEnv,
    fetchImpl
  });

  assert.equal(lease.scanner.sha256, "a".repeat(64));
});

test("builds scanner args from Azure wrapper options", () => {
  const args = buildScannerArgs({
    ...readAzureOptions(baseEnv),
    upload: false,
    ai: false,
    sarif: false
  });

  assert.ok(args.includes("--no-upload"));
  assert.ok(args.includes("--no-ai"));
  assert.ok(args.includes("--no-sarif"));
});

test("rejects malformed bootstrap leases", () => {
  assert.throws(
    () => normalizeBootstrapLease({ scanner: { url: "https://storage.example/scanner.tar.gz", sha256: "bad" } }),
    /valid scanner\.sha256/
  );
});
