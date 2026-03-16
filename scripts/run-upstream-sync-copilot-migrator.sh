#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STRATEGY="${UPSTREAM_SYNC_STRATEGY:-merge}"
MODEL="${UPSTREAM_SYNC_MODEL:-gpt-5.3-codex}"
WORKERS="${UPSTREAM_SYNC_WORKERS:-4}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strategy)
      STRATEGY="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --workers)
      WORKERS="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/run-upstream-sync-copilot-migrator.sh [--strategy merge|rebase] [--model MODEL] [--workers N]"
      exit 1
      ;;
  esac
done

if ! command -v agency >/dev/null 2>&1; then
  echo "ERROR: agency CLI is required."
  exit 1
fi

PROMPT=$(cat <<EOF
Execute the upstream-sync-copilot-migrator workflow in this repository.

Parameters:
- Integration strategy: ${STRATEGY}
- Fleet worker hint: ${WORKERS}

Requirements:
1) Follow docs/UPSTREAM-SYNC-AND-COPILOT-PORTING.md.
2) Sync main from upstream/main.
3) Integrate into copilot/port-to-github-copilot using ${STRATEGY}.
4) Resolve conflicts with Copilot-priority paths preserved.
5) Run migration automation (skills:refresh and fleet/autopilot migration).
6) Ensure CLAUDE.md reintroductions are reconciled into AGENTS.md.
7) Run build and tests.
8) Provide a concise final report with modified files and any follow-ups.
EOF
)

agency copilot \
  --agent upstream-sync-copilot-migrator \
  --source repo \
  --model "$MODEL" \
  --autopilot \
  --allow-all-tools \
  --allow-all-paths \
  --allow-all-urls \
  -p "$PROMPT"
