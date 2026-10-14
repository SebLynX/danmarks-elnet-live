#!/usr/bin/env bash
# Stop hook. Claude may not end its turn on a red repo: if anything changed since the last
# commit, the full check must pass first. One retry only (stop_hook_active), so a genuinely
# stuck agent can still stop and ask Sebastian instead of looping.
# Exit 2 = block the stop, stderr goes back to Claude. Exit 0 = let it stop.

input=$(cat)
if printf '%s' "$input" | grep -q '"stop_hook_active" *: *true'; then exit 0; fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f .claude/hooks/check.sh ] || exit 0

# nothing modified or untracked -> nothing to check
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then exit 0; fi

out=$(bash .claude/hooks/check.sh 2>&1); rc=$?
if [ $rc -ne 0 ]; then
  printf '%s\n' "$out" | tail -n 60 >&2
  echo "The repo is red (see above). Make it green before finishing: fix the code, never delete, skip or weaken tests, never edit guardrail files. If you are stuck, say exactly what fails and stop - the next stop will be allowed." >&2
  exit 2
fi
exit 0
