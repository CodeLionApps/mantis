#!/usr/bin/env bash
# Fails if a build contains the Mantis agent. For CI: run on the build you ship (made WITHOUT MANTIS_E2E).
# usage: scripts/check-release.sh <app.apk | app.aab | App.app>
# exit: 0 = no agent, 1 = agent found, 2 = could not check (never read as "clean")
# Reads every file of the build as raw bytes (grep -a): survives stripping (iOS keeps ObjC class names in
# __objc_classname), R8 (the ContentProvider is kept by its manifest name) and Hermes bytecode (string table).
set -euo pipefail
export LC_ALL=C
target="${1:?usage: $0 <app.apk | app.aab | App.app>}"
cannot() { echo "cannot check $target: $*" >&2; exit 2; }

# the build must contain code we can read, else "no hits" means nothing
case "$target" in
  *.apk | *.aab)
    [ -f "$target" ] || cannot "no such file"
    unzip -tq "$target" >/dev/null || cannot "not a readable zip"
    list=$(unzip -Z1 "$target")
    grep -q '\.dex$' <<<"$list" || cannot "no dex"
    grep -q '\.bundle$' <<<"$list" || cannot "no JS bundle"
    scan() { unzip -p "$target"; } # streamed: extracting can stall on names that collide on a case-insensitive disk
    ;;
  *.app)
    [ -d "$target" ] || cannot "no such directory"
    [ -n "$(find "$target" -type f -perm -u+x -print -quit)" ] || cannot "no executable"
    [ -n "$(find "$target" -type f -name '*.jsbundle' -print -quit)" ] || cannot "no JS bundle"
    scan() { find "$target" -type f -exec cat {} +; }
    ;;
  *) cannot "not an .apk, .aab or .app" ;;
esac

# native: iOS class / Android classes; JS: the agent's RPC method name. grep exit 1 = no match, not an error.
hits=$(scan | { grep -a -o -e MantisAgent -e MantisInitProvider -e Tree.query || [ $? -eq 1 ]; } | sort -u) ||
  cannot "reading the build failed"
if [ -n "$hits" ]; then
  echo "Mantis agent FOUND in $target:" $hits
  exit 1
fi
echo "no Mantis agent in $target"
