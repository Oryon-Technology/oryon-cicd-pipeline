import fs from "node:fs/promises";
import * as core from "@actions/core";
import { artifactPath } from "./config.js";
import type { WrapperOptions } from "./types.js";

export async function setScannerOutputs(options: WrapperOptions, includeScannerArtifacts = true): Promise<void> {
  for (const [name, value] of Object.entries(await collectScannerOutputs(options, includeScannerArtifacts))) {
    core.setOutput(name, value);
  }
}

export async function collectScannerOutputs(options: WrapperOptions, includeScannerArtifacts = true): Promise<Record<string, string>> {
  const artifacts: [string, string][] = [["diagnostic-path", "oryon-wrapper-diagnostic.json"]];
  if (includeScannerArtifacts) artifacts.push(
    ["results-path", "oryon-results.json"],
    ["summary-path", "oryon-summary.md"],
    ["run-path", "oryon-run.json"]
  );
  if (includeScannerArtifacts && options.sarif) artifacts.push(["sarif-path", "oryon.sarif"]);
  if (includeScannerArtifacts && options.report === "pdf") artifacts.push(["report-path", "oryon-report.pdf"]);
  const outputs: Record<string, string> = {};
  for (const [name, filename] of artifacts) {
    const filenamePath = artifactPath(options.workspace, options.outDir, filename);
    if (await isFile(filenamePath)) outputs[name] = filenamePath;
  }
  for (const filename of includeScannerArtifacts ? ["oryon-scanner.log", "oryon-wrapper.log"] : ["oryon-wrapper.log"]) {
    const filenamePath = artifactPath(options.workspace, options.outDir, filename);
    if (await isFile(filenamePath)) {
      outputs["log-path"] = filenamePath;
      break;
    }
  }
  if (outputs["results-path"]) {
    const findings = await readFindingsCount(outputs["results-path"]);
    if (findings !== undefined) outputs.findings = String(findings);
  }
  return outputs;
}

async function isFile(filename: string): Promise<boolean> {
  try {
    return (await fs.stat(filename)).isFile();
  } catch {
    return false;
  }
}

async function readFindingsCount(resultsPath: string): Promise<number | undefined> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(resultsPath, "utf8"));
    const root = asRecord(raw);
    // The packaged scanner writes { repository, scan: { stats, findings, ... } }.
    // Keep compatibility with older flat results files.
    const scan = root.scan && typeof root.scan === "object" ? asRecord(root.scan) : root;
    if (Array.isArray(scan.findings)) return scan.findings.length;
    const stats = asRecord(scan.stats);
    if (typeof stats.findings === "number" && Number.isFinite(stats.findings) && stats.findings >= 0) {
      return Math.trunc(stats.findings);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
