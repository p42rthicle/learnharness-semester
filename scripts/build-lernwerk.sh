#!/usr/bin/env bash
# Builds dist/lernwerk/mac-arm64/Lernwerk.app (Apple Silicon, ad-hoc signed). Needs Node 26; no Xcode, no Apple account.
# Publishes nothing and installs nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 26 ]] || { echo "Node 26 required: fnm exec --using 26 npm run lernwerk:build" >&2; exit 1; }
rm -rf dist/lernwerk .next/standalone
npm run build
git checkout -q -- next-env.d.ts # generated churn from next build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --mac dir --arm64 --publish never --config electron-builder.lernwerk.yml
APP=dist/lernwerk/mac-arm64/Lernwerk.app
codesign --verify --deep --strict "$APP"
[[ ! -e "$APP/Contents/Resources/app-update.yml" ]] || { echo "update feed found in the build" >&2; exit 1; }
echo "built $APP"
