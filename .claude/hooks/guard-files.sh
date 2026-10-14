#!/usr/bin/env bash
# PreToolUse hook (matcher: Edit|Write|MultiEdit). Reads the tool call as JSON on stdin.
# Guardrail files and secrets belong to Sebastian: the agent must ask before editing them.
# Exit 0 + JSON "ask" = permission prompt for Sebastian. Exit 0 = proceed.

input=$(cat)
path=$(printf '%s' "$input" | grep -o '"file_path" *: *"[^"]*"' | head -n1 | sed 's/.*: *"//; s/"$//')
[ -z "$path" ] && exit 0

# normalise Windows backslashes so the patterns below match on Git Bash too
p=$(printf '%s' "$path" | tr '\\' '/')

if printf '%s' "$p" | grep -qE '(^|/)(\.env(\..*)?|.*\.pem|.*\.key|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|\.pre-commit-config\.yaml)$|(^|/)\.github/workflows/|(^|/)\.claude/'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Guardrail or secret file. Approve only if you asked for this exact change; otherwise deny and let the agent fix the real problem."}}
JSON
  exit 0
fi

exit 0
