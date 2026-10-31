import fs from "node:fs/promises";
import { artifactPath } from "./config.js";
import type { WrapperOptions } from "./types.js";

export type WrapperPhase = "authentication" | "bootstrap" | "download" | "scanner";

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = text;
  const values = Object.entries(env)
    .filter(([name, value]) => /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && value && value.length >= 8)
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s"<>]+/g, (url) => {
      // Signed artifact URLs and credential-bearing query strings do not belong in diagnostics.
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
      } catch {
        return "[redacted-url]";
      }
    });
}

export function wrapperErrorCode(phase: WrapperPhase): string {
  return { authentication: "CI_OIDC", bootstrap: "CI_BOOTSTRAP", download: "CI_DOWNLOAD", scanner: "CI_SCANNER_PROCESS" }[phase];
}

export async function writeWrapperFailure(input: {
  options: WrapperOptions;
  runId: string;
  startedAt: string;
  phase: WrapperPhase;
  error: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = input.env ?? process.env;
  const message = redactSecrets(input.error instanceof Error ? input.error.message : String(input.error), env).slice(-8_000);
  const diagnosticPath = artifactPath(input.options.workspace, input.options.outDir, "oryon-wrapper-diagnostic.json");
  const logPath = artifactPath(input.options.workspace, input.options.outDir, "oryon-wrapper.log");
  await fs.mkdir(artifactPath(input.options.workspace, input.options.outDir, "."), { recursive: true });
  await fs.writeFile(diagnosticPath, `${JSON.stringify({
    runId: input.runId,
    status: "failed",
    phase: input.phase,
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    error: {
      code: wrapperErrorCode(input.phase),
      message
    }
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(logPath, `[${input.phase}] ${message}\nSupport run ID: ${input.runId}\n`, { mode: 0o600 });
  return diagnosticPath;
}

export async function submitWrapperTelemetry(input: {
  options: WrapperOptions;
  ciToken: string;
  runId: string;
  startedAt: string;
  status: "running" | "failed";
  phase: WrapperPhase;
  error?: unknown;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const errorMessage = input.error === undefined ? undefined : redactSecrets(
    input.error instanceof Error ? input.error.message : String(input.error)
  ).slice(-4_000);
  const terminal = input.status === "failed";
  const endedAt = new Date();
  const response = await (input.fetchImpl ?? fetch)(`${input.options.backendUrl}/api/v1/scan-telemetry`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: { Authorization: `Bearer ${input.ciToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ report: {
      run_id: input.runId,
      status: input.status,
      client_name: "github-action",
      client_version: "0.1.1",
      platform: process.platform,
      architecture: process.arch,
      started_at: input.startedAt,
      ...(terminal ? { ended_at: endedAt.toISOString(), duration_ms: Math.max(0, endedAt.getTime() - Date.parse(input.startedAt)) } : {}),
      phase: input.phase === "scanner" ? "scan" : "preflight",
      metrics_json: { phase: input.phase },
      ...(input.error === undefined ? {} : {
        error_code: wrapperErrorCode(input.phase),
        error_message: errorMessage
      })
    } })
  });
  if (!response.ok) {
    throw new Error(`Attempt status could not be recorded (${response.status}).`);
  }
}
