import * as core from "@actions/core";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { redactSecrets, submitWrapperTelemetry, writeWrapperFailure, type WrapperPhase } from "./diagnostics.js";
import { requestBootstrap } from "./bootstrap.js";
import { artifactPath, readActionOptions } from "./config.js";
import { installScanner } from "./download.js";
import { setScannerOutputs } from "./outputs.js";
import { buildScannerEnv, runScanner } from "./scanner.js";

const OIDC_AUDIENCE = "oryon-ci";

async function main(): Promise<void> {
  const options = readActionOptions();
  let ciToken = process.env.ORYON_CI_TOKEN?.trim();
  if (ciToken) core.setSecret(ciToken);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  process.env.ORYON_RUN_ID = runId;
  process.env.ORYON_RUN_STARTED_AT = startedAt;
  core.setOutput("run-id", runId);
  core.info(`Oryon support run ID: ${runId}`);
  let phase: WrapperPhase = "authentication";
  let scannerStarted = false;
  const secrets: NodeJS.ProcessEnv = { ...process.env };
  const telemetry = (status: "running" | "failed", error?: unknown) => ciToken ? submitWrapperTelemetry({
    options, ciToken, runId, startedAt, status, phase, error
  }).catch((telemetryError: unknown) => {
    core.warning(telemetryError instanceof Error ? telemetryError.message : "Attempt status could not be recorded.");
  }) : Promise.resolve();

  try {
    await telemetry("running");
    core.info("Requesting GitHub OIDC token.");
    const oidcToken = await requestOidcToken();
    core.setSecret(oidcToken);
    secrets.ORYON_OIDC_TOKEN = oidcToken;

    phase = "bootstrap";
    core.info("Requesting Oryon CI bootstrap lease.");
    const lease = await requestBootstrap({ options, ciToken, oidcToken });
    if (lease.credentials) {
      ciToken = lease.credentials.token;
      core.setSecret(ciToken);
      secrets.ORYON_CI_TOKEN = ciToken;
    }
    if (!ciToken) throw new Error("Connect this repository through the Oryon GitHub App or provide an ORYON_CI_TOKEN.");
    if (lease.configuration) {
      options.failOn = lease.configuration.failOn;
      options.exclusions = lease.configuration.exclusions;
      options.configurationRevision = lease.configuration.revision;
      core.info(`Using Oryon project configuration revision ${options.configurationRevision}.`);
    }
    if (lease.credentials) await telemetry("running");
    if (lease.ai?.key) {
      core.setSecret(lease.ai.key);
      secrets.ORYON_AI_PROVIDER_KEY = lease.ai.key;
    }

    phase = "download";
    core.info(`Downloading Oryon scanner ${lease.scanner.version}.`);
    const installed = await installScanner(lease.scanner);

    phase = "scanner";
    core.info("Running Oryon scanner.");
    scannerStarted = true;
    await runScanner({
      executable: installed.entrypoint,
      options,
      env: buildScannerEnv({ ciToken, ai: lease.ai })
    });
  } catch (error) {
    await writeWrapperFailure({ options, runId, startedAt, phase, error, env: secrets }).catch((artifactError: unknown) => {
      core.warning(`Could not save wrapper diagnostics: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`);
    });
    // Once the scanner starts, its richer telemetry is authoritative (including
    // successful scans that fail a severity gate). Do not overwrite it here.
    let scannerRecordedTerminalState = false;
    if (scannerStarted) {
      try {
        const state = JSON.parse(await fs.readFile(artifactPath(options.workspace, options.outDir, "oryon-run.json"), "utf8"));
        scannerRecordedTerminalState = state.runId === runId && ["completed", "partial", "failed", "cancelled"].includes(state.status);
      } catch { /* A process killed before it can write its state is recorded by the wrapper. */ }
    }
    if (!scannerRecordedTerminalState) await telemetry("failed", error);
    throw new Error(`[${phase}] ${redactSecrets(error instanceof Error ? error.message : String(error), secrets)} Support run ID: ${runId}`);
  } finally {
    await setScannerOutputs(options, scannerStarted).catch((error: unknown) => {
      core.warning(`Could not collect Oryon artifact outputs: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function requestOidcToken(): Promise<string> {
  try {
    const token = (await core.getIDToken(OIDC_AUDIENCE)).trim();
    if (!token) {
      throw new Error("GitHub returned an empty OIDC token.");
    }
    return token;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `GitHub OIDC token unavailable. Add permissions: id-token: write and use the approved Oryon reusable workflow. ${detail}`
    );
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
