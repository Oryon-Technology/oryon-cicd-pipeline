import path from "node:path";
import * as core from "@actions/core";
import type { FailOn, ReportKind, WrapperOptions } from "./types.js";

const DEFAULT_BACKEND_URL = "https://dashboard.oryontechnology.com";
const failOnValues = new Set(["none", "low", "medium", "high", "critical"]);
const reportValues = new Set(["none", "pdf"]);

export function readActionOptions(): WrapperOptions {
  const workspaceInput = core.getInput("workspace") || ".";
  const outDir = core.getInput("out-dir") || ".oryon";

  return {
    backendUrl: normalizeBackendUrl(core.getInput("backend-url") || DEFAULT_BACKEND_URL),
    workspace: path.resolve(workspaceInput),
    outDir,
    scannerVersion: core.getInput("scanner-version") || "v1",
    upload: core.getBooleanInput("upload"),
    ai: core.getBooleanInput("ai"),
    report: parseReport(core.getInput("report") || "none"),
    sarif: core.getBooleanInput("sarif"),
    failOn: parseFailOn(core.getInput("fail-on") || "none")
  };
}

export function artifactPath(workspace: string, outDir: string, filename: string): string {
  const base = path.isAbsolute(outDir) ? outDir : path.resolve(workspace, outDir);
  return path.join(base, filename);
}

function normalizeBackendUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported backend URL protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}

function parseFailOn(raw: string): FailOn {
  const value = raw.toLowerCase();
  if (!failOnValues.has(value)) {
    throw new Error(`Invalid fail-on value "${raw}". Use none, low, medium, high, or critical.`);
  }
  return value as FailOn;
}

function parseReport(raw: string): ReportKind {
  const value = raw.toLowerCase();
  if (!reportValues.has(value)) {
    throw new Error(`Invalid report value "${raw}". Use none or pdf.`);
  }
  return value as ReportKind;
}

