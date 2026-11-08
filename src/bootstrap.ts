import type { BootstrapLease, BootstrapRequest, WrapperOptions } from "./types.js";

const ACTION_VERSION = "0.1.3";
const OIDC_HEADER = "X-Oryon-GitHub-OIDC-Token";

export async function requestBootstrap(input: {
  options: WrapperOptions;
  ciToken?: string;
  oidcToken: string;
}): Promise<BootstrapLease> {
  const response = await fetch(`${input.options.backendUrl}/api/v1/ci/bootstrap`, {
    method: "POST",
    headers: {
      ...(input.ciToken ? { "Authorization": `Bearer ${input.ciToken}` } : {}),
      "Content-Type": "application/json",
      "User-Agent": `oryon-cicd-pipeline/${ACTION_VERSION}`,
      [OIDC_HEADER]: input.oidcToken
    },
    body: JSON.stringify(buildBootstrapRequest(input.options))
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(formatBackendRejection(response.status, payload));
  }
  return normalizeBootstrapLease(payload);
}

export function buildBootstrapRequest(options: WrapperOptions): BootstrapRequest {
  return {
    scanner_version: options.scannerVersion,
    action_version: ACTION_VERSION,
    inputs: {
      upload: options.upload,
      ai: options.ai,
      report: options.report,
      sarif: options.sarif,
      fail_on: options.failOn
    },
    github: {
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      workflow: process.env.GITHUB_WORKFLOW,
      event_name: process.env.GITHUB_EVENT_NAME,
      job_workflow_ref: process.env.GITHUB_JOB_WORKFLOW_REF,
      runner_environment: process.env.RUNNER_ENVIRONMENT
    }
  };
}

export function normalizeBootstrapLease(payload: unknown): BootstrapLease {
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
  const lease: BootstrapLease = {
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
      baseUrl: stringValue(ai.base_url),
      provider: stringValue(ai.provider),
      expiresAt: stringValue(ai.expires_at)
    };
  }

  if (root.credentials !== undefined) {
    const credentials = asRecord(root.credentials);
    const token = stringValue(credentials.token);
    const expiresAt = stringValue(credentials.expires_at);
    if (!token?.startsWith("oryon_ci_") || !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new Error("Oryon bootstrap returned invalid temporary credentials.");
    }
    lease.credentials = { token, expiresAt };
  }
  if (root.configuration !== undefined) {
    const config = asRecord(root.configuration);
    if (!Number.isSafeInteger(config.revision) || Number(config.revision) < 1 ||
        !Array.isArray(config.exclusions) || config.exclusions.length > 100 ||
        !config.exclusions.every((value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\r\n\0]/.test(value)) ||
        !["none", "low", "medium", "high", "critical"].includes(String(config.fail_on))) {
      throw new Error("Oryon bootstrap returned an invalid project configuration.");
    }
    lease.configuration = { revision: Number(config.revision), exclusions: config.exclusions, failOn: config.fail_on as WrapperOptions["failOn"] };
  }

  return lease;
}

async function readJson(response: Response): Promise<unknown> {
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

function formatBackendRejection(status: number, payload: unknown): string {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  const code = stringValue(error.code);
  const message = stringValue(error.message) ?? stringValue(root.message);
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `Oryon bootstrap rejected (${status}): ${detail}` : `Oryon bootstrap rejected (${status}).`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
