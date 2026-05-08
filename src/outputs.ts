import fs from "node:fs/promises";
import * as core from "@actions/core";
import { artifactPath } from "./config.js";
import type { WrapperOptions } from "./types.js";

export async function setScannerOutputs(options: WrapperOptions): Promise<void> {
  const resultsPath = artifactPath(options.workspace, options.outDir, "oryon-results.json");
  const summaryPath = artifactPath(options.workspace, options.outDir, "oryon-summary.md");
  const sarifPath = artifactPath(options.workspace, options.outDir, "oryon.sarif");
  const reportPath = artifactPath(options.workspace, options.outDir, "oryon-report.pdf");

  core.setOutput("results-path", resultsPath);
  core.setOutput("summary-path", summaryPath);
  if (options.sarif) {
    core.setOutput("sarif-path", sarifPath);
  }
  if (options.report === "pdf") {
    core.setOutput("report-path", reportPath);
  }

  const findings = await readFindingsCount(resultsPath);
  if (findings !== undefined) {
    core.setOutput("findings", String(findings));
  }
}

async function readFindingsCount(resultsPath: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(resultsPath, "utf8")) as unknown;
    const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const stats = root.stats && typeof root.stats === "object" ? (root.stats as Record<string, unknown>) : {};
    if (typeof stats.findings === "number") {
      return stats.findings;
    }
    if (Array.isArray(root.findings)) {
      return root.findings.length;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

