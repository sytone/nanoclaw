#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WORKERS="${SKILLS_FLEET_WORKERS:-4}"
SKIP_PREP="false"
MODEL="${SKILLS_FLEET_MODEL:-gpt-5.3-codex}"
SKILL_FILTER=""
SKIP_MEMORY_RECONCILE="false"

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
    --skip-memory-reconcile)
      SKIP_MEMORY_RECONCILE="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/skills-fleet-orchestrator.sh [--workers N] [--skip-prep] [--model MODEL] [--skill NAME] [--skip-memory-reconcile]"
      exit 1
      ;;
  esac
done

if ! command -v agency >/dev/null 2>&1; then
  echo "ERROR: agency CLI is required for fleet mode."
  exit 1
fi

reconcile_memory_file() {
  local legacy_file="$1"
  local agent_file="$2"
  local log_file="$3"

  if [[ ! -f "$legacy_file" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$agent_file")"
  if [[ ! -f "$agent_file" ]]; then
    cp "$legacy_file" "$agent_file"
  fi

  local prompt
  prompt=$(cat <<EOF
You are reconciling a legacy Claude memory file into the canonical AGENTS file.

Files:
- Legacy source: ${legacy_file}
- Canonical target: ${agent_file}

Required actions:
1) Compare both files and merge any meaningful information from ${legacy_file} into ${agent_file}.
2) Keep structure clean, concise, and agent-agnostic.
3) Preserve repository-specific instructions and operational details.
4) Do not remove important guidance already present in ${agent_file}.
5) Save the final merged result to ${agent_file}.

Return a short summary of what changed.
EOF
)

agency copilot \
  --model "$MODEL" \
  --autopilot \
  --allow-all-tools \
  --allow-all-paths \
  --allow-all-urls \
  -p "$prompt" \
  -s >>"$log_file" 2>&1

  rm -f "$legacy_file"
}

reconcile_claude_memory_files() {
  local mem_log="$LOG_DIR/memory-reconcile.log"
  : > "$mem_log"

  echo "[fleet] Reconciling legacy CLAUDE.md files into AGENTS.md"

  reconcile_memory_file "CLAUDE.md" "AGENTS.md" "$mem_log"
  reconcile_memory_file "groups/main/CLAUDE.md" "groups/main/AGENTS.md" "$mem_log"
  reconcile_memory_file "groups/global/CLAUDE.md" "groups/global/AGENTS.md" "$mem_log"

  echo "[fleet] Memory reconciliation complete"
}

if [[ "$SKIP_PREP" != "true" ]]; then
  echo "[fleet] Running prep: skills:refresh"
  npm run skills:refresh
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

if [[ "$SKIP_MEMORY_RECONCILE" != "true" ]]; then
  reconcile_claude_memory_files
fi

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
