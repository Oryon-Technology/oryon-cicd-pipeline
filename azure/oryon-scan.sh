#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Oryon Azure wrapper requires Node.js 20 or newer." >&2
  exit 1
fi

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$node_major" -lt 20 ]; then
  echo "Oryon Azure wrapper requires Node.js 20 or newer. Current: $(node -v)" >&2
  exit 1
fi

repo="${ORYON_CICD_REPO:-Oryon-Technology/oryon-cicd-pipeline}"
ref="${ORYON_CICD_REF:-v1}"
raw_base="${ORYON_CICD_RAW_BASE:-https://raw.githubusercontent.com/${repo}/${ref}}"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

curl -fsSL "${raw_base}/azure/oryon-scan.mjs" -o "${tmp_dir}/oryon-scan.mjs"
node "${tmp_dir}/oryon-scan.mjs"
