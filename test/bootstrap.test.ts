import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBootstrapLease } from "../src/bootstrap.ts";

test("normalizes nested bootstrap leases", () => {
  const lease = normalizeBootstrapLease({
    scanner: {
      url: "https://storage.example/scanner.tar.gz",
      sha256: "A".repeat(64),
      version: "1.2.3",
      entrypoint: "dist/cli.cjs"
    },
    ai: {
      provider: "openai",
      key: "test-provider-key",
      expires_at: "2026-05-08T20:00:00Z"
    }
  });

  assert.equal(lease.scanner.url, "https://storage.example/scanner.tar.gz");
  assert.equal(lease.scanner.sha256, "a".repeat(64));
  assert.equal(lease.scanner.version, "1.2.3");
  assert.equal(lease.scanner.entrypoint, "dist/cli.cjs");
  assert.equal(lease.ai?.provider, "openai");
  assert.equal(lease.ai?.key, "test-provider-key");
});

test("rejects bootstrap leases without a valid scanner hash", () => {
  assert.throws(
    () =>
      normalizeBootstrapLease({
        scanner: {
          url: "https://storage.example/scanner.tar.gz",
          sha256: "bad"
        }
      }),
    /valid scanner\.sha256/
  );
});
