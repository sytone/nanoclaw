#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WORKERS="${SKILLS_FLEET_WORKERS:-4}"
SKIP_PREP="false"
MODEL="${SKILLS_FLEET_MODEL:-gpt-5.3-codex}"
SKILL_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workers)
      WORKERS="$2"
      shift 2
      ;;
    --skip-prep)
      SKIP_PREP="true"
      shift
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --skill)
      SKILL_FILTER="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/skills-fleet-orchestrator.sh [--workers N] [--skip-prep] [--model MODEL] [--skill NAME]"
      exit 1
      ;;
  esac
done

if ! command -v agency >/dev/null 2>&1; then
  echo "ERROR: agency CLI is required for fleet mode."
  exit 1
fi

if [[ "$SKIP_PREP" != "true" ]]; then
  echo "[fleet] Running prep: sync + migrate + audit"
  npm run skills:sync
  npm run skills:migrate
  npm run skills:audit
fi

mapfile -t SKILLS < <(find .github/skills -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
if [[ -n "$SKILL_FILTER" ]]; then
  mapfile -t SKILLS < <(printf '%s\n' "${SKILLS[@]}" | grep -x "$SKILL_FILTER" || true)
fi
if [[ "${#SKILLS[@]}" -eq 0 ]]; then
  echo "ERROR: No skills found in .github/skills"
  exit 1
fi

LOG_DIR=".github/agents/fleet-logs"
STATUS_FILE="$LOG_DIR/status.log"
mkdir -p "$LOG_DIR"
: > "$STATUS_FILE"

export ROOT_DIR LOG_DIR STATUS_FILE MODEL

run_skill() {
  local skill="$1"
  local agent_name="${skill}-agent"
  local source_file=".claude/skills/${skill}/SKILL.md"
  local target_file=".github/skills/${skill}/SKILL.md"
  local agent_file=".github/agents/${agent_name}.agent.md"
  local logfile="$LOG_DIR/${skill}.log"

  if [[ ! -f "$source_file" || ! -f "$target_file" || ! -f "$agent_file" ]]; then
    echo "SKIP ${skill} missing source/target/agent file" >> "$STATUS_FILE"
    return 0
  fi

  local prompt
  prompt=$(cat <<EOF
Execute the ${agent_name} workflow in autopilot mode for one skill migration.

Scope:
- Source: ${source_file}
- Target: ${target_file}
- Agent instructions: ${agent_file}

Required actions:
1) Review source vs target and sync any source updates into target first.
2) Apply Copilot compatibility migration updates to the target skill.
3) Convert AskUserQuestion usage to ask_user usage patterns.
4) For ask_user usage, preserve intent and include:
   - clarifying question support
   - multiple-choice options when appropriate
   - freeform input when needed
5) Keep behavior unchanged except tool/provider compatibility updates.
6) Save edits directly to ${target_file}.

When done, output a concise summary of concrete edits made.
EOF
)

  if agency copilot \
      --agent "$agent_name" \
      --source repo \
      --model "$MODEL" \
      --autopilot \
      --allow-all-tools \
      --allow-all-paths \
      --allow-all-urls \
      -p "$prompt" \
      -s >"$logfile" 2>&1; then
    echo "OK ${skill}" >> "$STATUS_FILE"
  else
    echo "FAIL ${skill}" >> "$STATUS_FILE"
  fi
}

export -f run_skill

printf '%s\n' "${SKILLS[@]}" | xargs -P "$WORKERS" -I {} bash -lc 'run_skill "$@"' _ {}

ok_count=$(grep -c '^OK ' "$STATUS_FILE" || true)
fail_count=$(grep -c '^FAIL ' "$STATUS_FILE" || true)
skip_count=$(grep -c '^SKIP ' "$STATUS_FILE" || true)

echo "[fleet] Completed. ok=${ok_count} fail=${fail_count} skip=${skip_count}"
echo "[fleet] Logs: ${LOG_DIR}"

if [[ "$fail_count" -gt 0 ]]; then
  echo "[fleet] Failed skills:"
  grep '^FAIL ' "$STATUS_FILE" | sed 's/^FAIL /- /'
  exit 1
fi
