import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { InstalledScanner, ScannerLease } from "./types.js";

export async function installScanner(scanner: ScannerLease): Promise<InstalledScanner> {
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

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Scanner download failed (${response.status}).`);
  }

  const nodeStream = Readable.fromWeb(response.body as unknown as NodeReadableStream);
  await pipeline(nodeStream, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function extractTarGz(archivePath: string, destination: string): Promise<void> {
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

function safeResolve(rootDir: string, relativePath: string): string {
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
