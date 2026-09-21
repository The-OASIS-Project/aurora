#!/bin/bash
#
# Install the tracked pre-commit hook into this clone's .git/hooks.
# Re-run after a fresh clone to (re)activate the hook (git never installs
# hooks from a clone automatically).
#
# The hook runs ./pre-commit.local.hook if present (a gitignored, per-developer
# extension - e.g. the personal-name PII filter).
#

cd "$(git rev-parse --show-toplevel)" || exit 1

cp pre-commit.hook .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

echo "Installed .git/hooks/pre-commit"
if [ -x "./pre-commit.local.hook" ]; then
   echo "Local extension ./pre-commit.local.hook is present and will run."
else
   echo "No ./pre-commit.local.hook found (the local PII filter). It is optional and gitignored."
fi
