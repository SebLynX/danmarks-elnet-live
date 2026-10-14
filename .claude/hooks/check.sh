#!/usr/bin/env bash
# The one command that means "green" (static-site variant). Used by the Stop hook, by AGENTS.md
# and by Sebastian. Same checks as CI.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if command -v pre-commit >/dev/null 2>&1; then PC="pre-commit"; else PC="python -m pre_commit"; fi

echo "== format / lint / secrets =="
$PC run --all-files

echo "== smoke test every page =="
npx --no-install playwright test

echo "== GREEN =="
