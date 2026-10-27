#!/bin/sh
# Writes the version, commit and build time shown at the bottom of the app's window.
# Run by the "Build Info" build phase of both app targets.
set -eu

repo="${SRCROOT}/../.."
commit=$(git -C "${repo}" rev-parse --short HEAD 2>/dev/null || echo unknown)
# Builds of uncommitted changes aren't that commit, so mark them.
if [ "${commit}" != unknown ] && [ -n "$(git -C "${repo}" status --porcelain 2>/dev/null)" ]; then
  commit="${commit}-dirty"
fi
date=$(date '+%Y-%m-%d %H:%M:%S')

printf 'globalThis.buildInfo = { version: "%s", build: "%s", commit: "%s", date: "%s" }\n' \
  "${MARKETING_VERSION}" "${CURRENT_PROJECT_VERSION}" "${commit}" "${date}" >"${SCRIPT_OUTPUT_FILE_0}"
