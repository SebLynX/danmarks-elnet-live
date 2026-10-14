#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Reads the tool call as JSON on stdin.
# Denies commands that bypass the repo's guardrails; asks Sebastian before destructive git.
# Exit 2 = deny (stderr goes back to Claude). Exit 0 + JSON = ask. Exit 0 = proceed.

input=$(cat)

# --- hard deny: hook/guardrail bypass -------------------------------------------------------
if printf '%s' "$input" | grep -qE -- '--no-verify|core\.hooksPath|PRE_COMMIT_ALLOW_NO_CONFIG|\bSKIP=|--no-gpg-sign|pre-commit uninstall'; then
  echo "Blocked: this command bypasses the repo guardrails (hooks, pre-commit). Fix the underlying failure instead - do not skip, disable or uninstall a check." >&2
  exit 2
fi

# --- ask: destructive git --------------------------------------------------------------------
if printf '%s' "$input" | grep -qE -- 'git (push[^|;&]* (--force|-f)( |$|\\)|reset --hard|clean -[a-zA-Z]*f|checkout -- \.|branch -D|stash drop|stash clear)' \
   && ! printf '%s' "$input" | grep -q -- '--force-with-lease'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Destructive git command - it can throw work away. Approve only if you asked for exactly this."}}
JSON
  exit 0
fi

exit 0
