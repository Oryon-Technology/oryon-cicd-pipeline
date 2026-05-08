import * as core from "@actions/core";
import { requestBootstrap } from "./bootstrap.js";
import { readActionOptions } from "./config.js";
import { installScanner } from "./download.js";
import { setScannerOutputs } from "./outputs.js";
import { buildScannerEnv, runScanner } from "./scanner.js";

const OIDC_AUDIENCE = "oryon-ci";

async function main(): Promise<void> {
  const options = readActionOptions();
  const ciToken = process.env.ORYON_CI_TOKEN?.trim();
  if (!ciToken) {
    throw new Error("ORYON_CI_TOKEN is required. Add it as a repository secret and pass it to the Oryon reusable workflow.");
  }
  core.setSecret(ciToken);

  core.info("Requesting GitHub OIDC token.");
  const oidcToken = await requestOidcToken();
  core.setSecret(oidcToken);

  core.info("Requesting Oryon CI bootstrap lease.");
  const lease = await requestBootstrap({ options, ciToken, oidcToken });
  if (lease.ai?.key) {
    core.setSecret(lease.ai.key);
  }

  core.info(`Downloading Oryon scanner ${lease.scanner.version}.`);
  const installed = await installScanner(lease.scanner);

  core.info("Running Oryon scanner.");
  await runScanner({
    executable: installed.entrypoint,
    options,
    env: buildScannerEnv({ ciToken, ai: lease.ai })
  });

  await setScannerOutputs(options);
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

