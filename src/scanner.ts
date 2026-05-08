import { spawn } from "node:child_process";
import type { AiLease, WrapperOptions } from "./types.js";

export function buildScannerArgs(options: WrapperOptions): string[] {
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

export function buildScannerEnv(input: {
  ciToken: string;
  ai?: AiLease;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORYON_CI_TOKEN: input.ciToken
  };

  if (input.ai) {
    env.ORYON_AI_PROVIDER = input.ai.provider ?? "";
    env.ORYON_AI_PROVIDER_KEY = input.ai.key;
    env.ORYON_AI_EXPIRES_AT = input.ai.expiresAt ?? "";
    if ((input.ai.provider ?? "").toLowerCase() === "openai") {
      env.OPENAI_API_KEY = input.ai.key;
    }
  }

  return env;
}

export function runScanner(input: {
  executable: string;
  options: WrapperOptions;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, buildScannerArgs(input.options), {
      cwd: input.options.workspace,
      env: input.env,
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

