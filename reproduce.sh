#!/usr/bin/env bash
# Thin POSIX wrapper around reproduce.mjs.
# Usage: reproduce.sh [--install] [--check-only] [--paper]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/reproduce.mjs" "$@"
