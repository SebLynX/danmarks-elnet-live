#!/usr/bin/env bash
# PostToolUse hook (matcher: Edit|Write|MultiEdit). Runs the pre-commit checks on the file
# that was just edited, so format/lint feedback arrives immediately, not at commit time.
# Exit 2 feeds the output back to Claude (the edit already happened); exit 0 = quiet.

input=$(cat)
path=$(printf '%s' "$input" | grep -o '"file_path" *: *"[^"]*"' | head -n1 | sed 's/.*: *"//; s/"$//')
[ -z "$path" ] && exit 0
path=$(printf '%s' "$path" | tr '\\' '/')
[ -f "$path" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-.}"
root=$(printf '%s' "$root" | tr '\\' '/')
cd "$root" || exit 0
[ -f .pre-commit-config.yaml ] || exit 0

# only files inside this repo; guardrail files are handled by the PreToolUse hook
case "$path" in
  "$root"/*) rel="${path#"$root"/}" ;;
  /*) exit 0 ;;
  *) rel="$path" ;;
esac
case "$rel" in .claude/*|.github/*|node_modules/*) exit 0 ;; esac

# pre-commit only notices changes to files git knows about; register new files with intent-to-add
if ! git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
  git add --intent-to-add -- "$rel" 2>/dev/null || true
fi

if command -v pre-commit >/dev/null 2>&1; then PC="pre-commit"; else PC="python -m pre_commit"; fi

out=$($PC run --files "$rel" 2>&1); rc=$?
if [ $rc -ne 0 ]; then
  printf '%s\n' "$out" | grep -vE '^\[INFO\]' | tail -n 40 >&2
  echo "pre-commit changed or rejected $rel. If a formatter rewrote it, re-read the file before editing again; if a linter failed, fix the code (never the linter config)." >&2
  exit 2
fi
exit 0
