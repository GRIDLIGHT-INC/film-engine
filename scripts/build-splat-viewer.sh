#!/usr/bin/env bash
# Builds src/vendor/splat-viewer.js — the ONE file the Previs console lazy-loads
# to render Gaussian splats (ADR-008). Nothing here becomes a dependency of the
# app: the tools are installed into a throwaway folder, the output is committed,
# and package.json is untouched. Re-run only to change a pinned version.
#
#   three              0.180.0   (Spark's minimum; the page's own r149 is untouched)
#   @sparkjsdev/spark  2.2.0     (World Labs' renderer for their .spz splats)
#
# The page keeps its classic-script three r149 for the GLB stage. This module
# carries its OWN three inside it and exports it, so the two never meet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund @sparkjsdev/spark@2.2.0 three@0.180.0 esbuild@0.25 >/dev/null
cat > entry.js <<'JS'
export * as THREE from 'three';
export { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
JS
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof \
  --banner:js="/* Film Engine splat viewer — three 0.180.0 + @sparkjsdev/spark 2.2.0, built by scripts/build-splat-viewer.sh (ADR-008). */" \
  --outfile="$ROOT/src/vendor/splat-viewer.js"
ls -l "$ROOT/src/vendor/splat-viewer.js"
