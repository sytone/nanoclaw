# Skill Sync and Copilot Migration

This folder stores a synchronized copy of source skills from `.claude/skills` so skill content can be reviewed and migrated for GitHub Copilot.

## Commands

- `npm run skills:migrate:agents-md`: Rename repo memory files (`CLAUDE.md`) to `AGENTS.md` and rewrite references in tracked files.
- `npm run skills:sync`: Copy all skills from `.claude/skills` into `.github/skills`.
- `npm run skills:migrate`: Deterministically convert all scannable text files in `.github/skills` for Copilot compatibility and regenerate `.github/agents/*.agent.md` workflow agents.
- `npm run skills:audit`: Scan copied skills for remaining Claude-specific references and generate an audit report.
- `npm run skills:audit:strict`: Same as audit, but exits non-zero if any files were skipped as non-text.
- `npm run skills:refresh`: Run AGENTS migration + sync + migrate + audit in order.
- `npm run skills:fleet`: Run per-skill migration agents in parallel with `agency copilot --autopilot`.
- `npm run skills:fleet:fast`: Same as fleet mode, with 8 workers.

Fleet mode also reconciles legacy memory files automatically:
- If `CLAUDE.md` files are present, fleet mode uses Copilot to merge them into corresponding `AGENTS.md` files.
- Canonical files become `AGENTS.md` at root and in tracked group folders.
- Legacy `CLAUDE.md` files are removed after successful reconciliation.

Fleet mode tuning:
- `SKILLS_FLEET_WORKERS=<n>` controls parallel workers.
- `SKILLS_FLEET_MODEL=<model>` selects Copilot model (default `gpt-5.3-codex`).
- `npm run skills:fleet -- --skip-prep` skips sync/migrate/audit pre-steps.

## Outputs

- `.github/skills/sync-summary.json`: What was copied during sync.
- `.github/agents/*.agent.md`: Migrated Copilot agent files generated from skills.
- `.github/agents/migration-report.md`: Replacement summary per migrated skill.
- `.github/skills/copilot-compatibility-report.md`: Remaining Claude-specific findings that still need manual decisions.

## Migration Strategy

The migration script is intentionally deterministic. It applies fixed replacements for known Claude-specific patterns from a centralized rule file:

- `scripts/copilot-migration-rules.mjs`

- `AskUserQuestion` -> `ask_user`
- `Claude` and `Anthropic` branding -> `GitHub Copilot`
- `CLAUDE.md` references -> `AGENTS.md`
- `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` -> Copilot host-auth note

The `ask_user` migration target supports:
- Clarifying questions during a task
- Multiple-choice options for faster decisions
- Freeform text input when needed

This avoids opaque LLM-only rewriting and leaves a clear report trail for manual review.

## How New Files Are Caught

- New files synced from `.claude/skills` are automatically discovered by recursive scan.
- Migrator applies replacements to all scannable text files, not only `SKILL.md`.
- Audit report lists skipped non-text files so nothing is silently ignored.
- If a new instruction format appears, add its extension or basename in `scripts/copilot-migration-rules.mjs`.
- CI runs `npm run skills:audit:strict`, so new file types that are not scannable fail fast.
