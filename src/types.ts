export type FailOn = "none" | "low" | "medium" | "high" | "critical";
export type ReportKind = "none" | "pdf";

export interface WrapperOptions {
  backendUrl: string;
  workspace: string;
  outDir: string;
  scannerVersion: string;
  upload: boolean;
  ai: boolean;
  report: ReportKind;
  sarif: boolean;
  failOn: FailOn;
  exclusions?: string[];
  configurationRevision?: number;
}

export interface BootstrapRequest {
  scanner_version: string;
  action_version: string;
  inputs: {
    upload: boolean;
    ai: boolean;
    report: ReportKind;
    sarif: boolean;
    fail_on: FailOn;
  };
  github: Record<string, string | undefined>;
}

export interface ScannerLease {
  url: string;
  sha256: string;
  version: string;
  entrypoint: string;
}

export interface AiLease {
  baseUrl?: string;
  provider?: string;
  key: string;
  expiresAt?: string;
}

export interface BootstrapLease {
  scanner: ScannerLease;
  ai?: AiLease;
  credentials?: { token: string; expiresAt: string };
  configuration?: { revision: number; exclusions: string[]; failOn: FailOn };
}

export interface InstalledScanner {
  rootDir: string;
  entrypoint: string;
}
