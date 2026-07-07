#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const WRAPPER_VERSION = "0.1.0";
const DEFAULT_BACKEND_URL = "https://dashboard.oryontechnology.com";
const AZURE_DEVOPS_API_VERSION = "7.1";
const AZURE_OIDC_HEADER = "X-Oryon-Azure-OIDC-Token";
const failOnValues = new Set(["none", "low", "medium", "high", "critical"]);
const reportValues = new Set(["none", "pdf"]);

export async function runAzureWrapper(env = process.env) {
  const options = readAzureOptions(env);
  const ciToken = requireEnv(env, "ORYON_CI_TOKEN");
  setAzureSecret(ciToken);

  log("Requesting Azure Pipelines OIDC token.");
  const oidcToken = await requestAzureOidcToken(env);
  setAzureSecret(oidcToken);

  log("Requesting Oryon CI bootstrap lease.");
  const lease = await requestBootstrap({ options, ciToken, oidcToken, env });
  if (lease.ai?.key) {
    setAzureSecret(lease.ai.key);
  }

  log(`Downloading Oryon scanner ${lease.scanner.version}.`);
  const installed = await installScanner(lease.scanner);

  log("Running Oryon scanner.");
  await runScanner({
    executable: installed.entrypoint,
    options,
    env: buildScannerEnv({ env, ciToken, ai: lease.ai })
  });
}

export function readAzureOptions(env = process.env, cwd = process.cwd()) {
  const workspace = env.ORYON_WORKSPACE?.trim() ||
    env.BUILD_SOURCESDIRECTORY?.trim() ||
    env.SYSTEM_DEFAULTWORKINGDIRECTORY?.trim() ||
    cwd;

  return {
    backendUrl: normalizeBackendUrl(env.ORYON_BACKEND_URL || DEFAULT_BACKEND_URL),
    workspace: path.resolve(workspace),
    outDir: env.ORYON_OUT_DIR?.trim() || ".oryon",
    scannerVersion: env.ORYON_SCANNER_VERSION?.trim() || "v1",
    upload: parseBoolean(env.ORYON_UPLOAD, true),
    ai: parseBoolean(env.ORYON_AI, true),
    report: parseReport(env.ORYON_REPORT || "none"),
    sarif: parseBoolean(env.ORYON_SARIF, true),
    failOn: parseFailOn(env.ORYON_FAIL_ON || "none")
  };
}

export async function requestAzureOidcToken(env = process.env, fetchImpl = fetch) {
  const requestUri = env.SYSTEM_OIDCREQUESTURI?.trim();
  if (!requestUri) {
    throw new Error("SYSTEM_OIDCREQUESTURI is unavailable. Enable Azure Pipelines OIDC for this job.");
  }

  const headers = {
    "Content-Length": "0",
    "User-Agent": `oryon-cicd-pipeline-azure/${WRAPPER_VERSION}`
  };
  const systemAccessToken = env.SYSTEM_ACCESSTOKEN?.trim();
  if (systemAccessToken) {
    headers.Authorization = `Bearer ${systemAccessToken}`;
  }

  const response = await fetchImpl(withAzureDevOpsApiVersion(requestUri), {
    method: "POST",
    headers
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Azure Pipelines OIDC token request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return extractOidcToken(text);
}

function withAzureDevOpsApiVersion(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has("api-version")) {
      url.searchParams.set("api-version", AZURE_DEVOPS_API_VERSION);
    }
    return url.toString();
  } catch {
    if (/[?&]api-version=/.test(rawUrl)) {
      return rawUrl;
    }
    return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}api-version=${AZURE_DEVOPS_API_VERSION}`;
  }
}

export function extractOidcToken(raw) {
  const text = String(raw || "").trim();
  if (/^eyJ[A-Za-z0-9_-]+\./.test(text)) {
    return text;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Azure Pipelines OIDC response was not valid JSON.");
  }

  const token = stringValue(payload.oidcToken) ||
    stringValue(payload.oidc_token) ||
    stringValue(payload.idToken) ||
    stringValue(payload.id_token) ||
    stringValue(payload.token);
  if (!token) {
    throw new Error("Azure Pipelines OIDC response did not include a token.");
  }
  return token;
}

export async function requestBootstrap({ options, ciToken, oidcToken, env = process.env, fetchImpl = fetch }) {
  const response = await fetchImpl(`${options.backendUrl}/api/v1/ci/bootstrap`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ciToken}`,
      "Content-Type": "application/json",
      "User-Agent": `oryon-cicd-pipeline-azure/${WRAPPER_VERSION}`,
      [AZURE_OIDC_HEADER]: oidcToken
    },
    body: JSON.stringify(buildBootstrapRequest(options, env))
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(formatBackendRejection(response.status, payload));
  }
  return normalizeBootstrapLease(payload);
}

export function buildBootstrapRequest(options, env = process.env) {
  return {
    scanner_version: options.scannerVersion,
    action_version: WRAPPER_VERSION,
    inputs: {
      upload: options.upload,
      ai: options.ai,
      report: options.report,
      sarif: options.sarif,
      fail_on: options.failOn
    },
    azure: {
      organization_url: env.SYSTEM_COLLECTIONURI,
      project: env.SYSTEM_TEAMPROJECT,
      project_id: env.SYSTEM_TEAMPROJECTID,
      pipeline_id: env.SYSTEM_DEFINITIONID || env.BUILD_DEFINITIONID,
      repository_id: env.BUILD_REPOSITORY_ID,
      repository_uri: env.BUILD_REPOSITORY_URI,
      ref: env.BUILD_SOURCEBRANCH,
      sha: env.BUILD_SOURCEVERSION,
      run_id: env.BUILD_BUILDID,
      build_number: env.BUILD_BUILDNUMBER,
      reason: env.BUILD_REASON
    }
  };
}

export function normalizeBootstrapLease(payload) {
  const root = asRecord(payload);
  const scanner = asRecord(root.scanner);
  const scannerUrl = stringValue(scanner.url);
  const scannerSha256 = stringValue(scanner.sha256);
  const scannerVersion = stringValue(scanner.version) ?? "unknown";
  const scannerEntrypoint = stringValue(scanner.entrypoint) ?? "dist/cli.cjs";

  if (!scannerUrl) {
    throw new Error("Oryon bootstrap response did not include scanner.url.");
  }
  if (!scannerSha256 || !/^[a-f0-9]{64}$/i.test(scannerSha256)) {
    throw new Error("Oryon bootstrap response did not include a valid scanner.sha256.");
  }

  const ai = asRecord(root.ai);
  const aiKey = stringValue(ai.key);
  const lease = {
    scanner: {
      url: scannerUrl,
      sha256: scannerSha256.toLowerCase(),
      version: scannerVersion,
      entrypoint: scannerEntrypoint
    }
  };

  if (aiKey) {
    lease.ai = {
      key: aiKey,
      provider: stringValue(ai.provider),
      expiresAt: stringValue(ai.expires_at)
    };
  }

  return lease;
}

export async function installScanner(scanner) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "oryon-scanner-"));
  const archivePath = path.join(rootDir, "scanner.tar.gz");
  const extractDir = path.join(rootDir, "scanner");
  await fsp.mkdir(extractDir, { recursive: true });

  await downloadFile(scanner.url, archivePath);
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== scanner.sha256.toLowerCase()) {
    throw new Error(`Downloaded scanner SHA256 mismatch. Expected ${scanner.sha256}, got ${actualSha256}.`);
  }

  await extractTarGz(archivePath, extractDir);
  const entrypoint = safeResolve(extractDir, scanner.entrypoint);
  await fsp.access(entrypoint, fs.constants.X_OK).catch(async () => {
    await fsp.chmod(entrypoint, 0o755);
  });

  return { rootDir, entrypoint };
}

export function buildScannerArgs(options) {
  const args = [
    "scan",
    "--backend-url",
    options.backendUrl,
    "--workspace",
    options.workspace,
    "--out-dir",
    options.outDir,
    "--fail-on",
    options.failOn,
    "--report",
    options.report
  ];

  if (!options.upload) {
    args.push("--no-upload");
  }
  if (!options.ai) {
    args.push("--no-ai");
  }
  if (!options.sarif) {
    args.push("--no-sarif");
  }

  return args;
}

export function buildScannerEnv({ env = process.env, ciToken, ai }) {
  const scannerEnv = {
    ...env,
    ORYON_CI_TOKEN: ciToken
  };

  if (ai) {
    scannerEnv.ORYON_AI_PROVIDER = ai.provider ?? "";
    scannerEnv.ORYON_AI_PROVIDER_KEY = ai.key;
    scannerEnv.ORYON_AI_EXPIRES_AT = ai.expiresAt ?? "";
    if ((ai.provider ?? "").toLowerCase() === "openai") {
      scannerEnv.OPENAI_API_KEY = ai.key;
    }
  }

  return scannerEnv;
}

export function runScanner({ executable, options, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, buildScannerArgs(options), {
      cwd: options.workspace,
      env,
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Oryon scanner exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Scanner download failed (${response.status}).`);
  }

  const nodeStream = Readable.fromWeb(response.body);
  await pipeline(nodeStream, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function extractTarGz(archivePath, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destination], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function safeResolve(rootDir, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Scanner entrypoint must be relative.");
  }
  const resolved = path.resolve(rootDir, relativePath);
  const rootWithSeparator = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (!resolved.startsWith(rootWithSeparator)) {
    throw new Error("Scanner entrypoint escapes the scanner archive root.");
  }
  return resolved;
}

async function readJson(response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function formatBackendRejection(status, payload) {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  const code = stringValue(error.code);
  const message = stringValue(error.message) ?? stringValue(root.message);
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `Oryon bootstrap rejected (${status}): ${detail}` : `Oryon bootstrap rejected (${status}).`;
}

function normalizeBackendUrl(raw) {
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported backend URL protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}

function parseBoolean(raw, defaultValue) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function parseFailOn(raw) {
  const value = String(raw).trim().toLowerCase();
  if (!failOnValues.has(value)) {
    throw new Error(`Invalid ORYON_FAIL_ON value "${raw}". Use none, low, medium, high, or critical.`);
  }
  return value;
}

function parseReport(raw) {
  const value = String(raw).trim().toLowerCase();
  if (!reportValues.has(value)) {
    throw new Error(`Invalid ORYON_REPORT value "${raw}". Use none or pdf.`);
  }
  return value;
}

function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function log(message) {
  console.log(`[oryon] ${message}`);
}

function setAzureSecret(value) {
  if (value) {
    console.log(`##vso[task.setsecret]${value}`);
  }
}

function logAzureError(message) {
  const escaped = String(message)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll("]", "%5D");
  console.error(`##vso[task.logissue type=error]${escaped}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === invokedPath || fileURLToPath(import.meta.url) === process.argv[1]) {
  runAzureWrapper().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logAzureError(message);
    process.exitCode = 1;
  });
}
