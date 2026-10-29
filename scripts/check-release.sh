#!/usr/bin/env bash
# Fails if a build contains the Mantis agent. For CI: run on a release build made WITHOUT MANTIS_E2E.
# usage: scripts/check-release.sh <app.apk | App.app>
#   native: the agent's classes (Android dex) / symbols (iOS binary); JS: the agent's RPC method name in the bundle
set -euo pipefail
export LC_ALL=C # grep -a over binary data (dex, Hermes bytecode): macOS `strings` on a pipe misses Hermes strings
target="${1:?usage: $0 <app.apk | App.app>}"

case "$target" in
  *.apk)
    native=$(unzip -p "$target" 'classes*.dex' | grep -a -c 'com/codelion/mantis/MantisAgent' || true)
    js=$(unzip -p "$target" 'assets/*.bundle' | grep -a -c 'Tree.query' || true)
    ;;
  *.app)
    bin="$target/$(plutil -extract CFBundleExecutable raw "$target/Info.plist")"
    native=$( (nm "$bin" 2>/dev/null; find "$target/Frameworks" -type f -perm +111 -exec nm {} \; 2>/dev/null) | grep -c 'MantisAgent' || true)
    js=$(grep -a -c 'Tree.query' "$target/main.jsbundle" 2>/dev/null || true)
    ;;
  *) echo "not an .apk or .app: $target" >&2; exit 2 ;;
esac

echo "Mantis native agent: $native hit(s), JS agent: $js hit(s) in $target"
[ "$native" -eq 0 ] && [ "$js" -eq 0 ]
