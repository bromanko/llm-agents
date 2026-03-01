#!/bin/bash
set -euo pipefail

# Read JSON input from stdin
input=$(cat)

# Extract the cwd and command from input
cwd=$(echo "$input" | jq -r '.cwd // ""')
command=$(echo "$input" | jq -r '.tool_input.command // ""')

# Check if we're in a jujutsu repo by looking for .jj directory
# Walk up from cwd to find .jj
is_jj_repo() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.jj" ]; then
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Only check git commands if we're in a jujutsu repo
if [ -n "$cwd" ] && is_jj_repo "$cwd"; then
  # Skip if this is a jj git subcommand (jj git fetch, jj git push, etc.)
  if echo "$command" | grep -qE '\bjj\s+git\b'; then
    exit 0
  fi

  # Check for mutating git commands at command boundaries only
  # (start of command or after shell operators, not inside quoted strings)
  if echo "$command" | grep -qE '(^|&&|\|\||;|\|)\s*git\s+(commit|branch|checkout|switch|merge|rebase|reset|stash|add|stage|push|fetch|pull)\b'; then
    cat >&2 <<'EOF'
{
  "decision": "block",
  "reason": "This is a jujutsu repository. Do not use mutating git commands. Use jujutsu equivalents instead:\n\n- git commit → jj commit -m \"message\" or jj describe -m \"message\"\n- git branch → jj branch create/set/delete\n- git checkout/switch → jj edit or jj new\n- git merge → jj new commit1 commit2\n- git rebase → jj rebase\n- git reset → jj restore or jj abandon\n- git stash → not needed (auto-snapshotted)\n- git add → not needed (auto-tracking)\n- git push → jj git push\n- git fetch → jj git fetch\n- git pull → jj git fetch\n\nRun 'jj --help' for more commands."
}
EOF
    exit 2
  fi
fi

# Allow command
exit 0
