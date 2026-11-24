#!/usr/bin/env bash
# Exercise the npm tarball with Bun as a separate consumer, with and without optional dependencies.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
tarball=$(cd "$repo" && npm pack --silent --pack-destination "$scratch")
for mode in with omit; do
  mkdir "$scratch/$mode"
  (
    cd "$scratch/$mode"
    printf '{"name":"mcp-tarball-smoke","private":true,"type":"module"}\n' > package.json
    options=()
    if [[ "$mode" == omit ]]; then options+=(--omit=optional); fi
    npm install --no-audit --no-fund "${options[@]}" "$scratch/$tarball"
    cp "$repo/test/packaging/native-mcp-consumer.ts" .
    cp "$repo/test/native/fixtures/mcp-stdio-fixture.ts" .
    bun run native-mcp-consumer.ts "$mode"
  )
done
