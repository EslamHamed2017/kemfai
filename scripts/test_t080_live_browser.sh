#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export KEMFAI_LIVE_MODE=t080
export KEMFAI_T074_REPO_DIR="$repo_dir"
exec "$repo_dir/scripts/test_t074_live_browser.sh"
