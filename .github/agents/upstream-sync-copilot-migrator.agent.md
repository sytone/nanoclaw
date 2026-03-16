---
name: upstream-sync-copilot-migrator
description: Autonomously sync upstream main into the Copilot branch, resolve migration updates, and run validation using repository runbooks and scripts.
---

# Upstream Sync Copilot Migrator

## Purpose

Run the full upstream sync and Copilot migration flow independently, using this repository's runbook and automation scripts.

Primary reference:
- `docs/UPSTREAM-SYNC-AND-COPILOT-PORTING.md`

## Inputs

- Optional strategy: `merge` (default) or `rebase`
- Optional target branch override (default `copilot/port-to-github-copilot`)
- Optional worker/model settings for fleet migration

## Required Workflow

1. Validate git remotes and clean working state.
2. Sync local `main` from `upstream/main` with fast-forward.
3. Move to Copilot branch and integrate `main` via selected strategy.
4. Resolve conflicts with Copilot-priority files preserved.
5. Port upstream container-agent changes into `container-copilot/agent-runner/*` when needed.
6. Run migration automation:
   - `npm run skills:refresh`
   - `npm run skills:fleet -- --skip-prep` (or tuned workers/model)
7. Reconcile any reintroduced `CLAUDE.md` files into canonical `AGENTS.md` files.
8. Run validation:
   - `nvm use 20`
   - `npm install`
   - `npm run build`
   - `npm test`
9. Summarize all changes and list files requiring manual review.

## Conflict Policy

When conflicts occur, prioritize preserving Copilot behavior in:

- `container-copilot/agent-runner/src/index.ts`
- `container-copilot/agent-runner/src/ipc-mcp-stdio.ts`
- `container-copilot/agent-runner/src/copilot-runner.ts`
- `src/credential-proxy.ts`
- `src/github-copilot-auth.ts`
- `src/copilot-auth-cli.ts`
- `setup/verify.ts`
- `setup/environment.test.ts`
- `docs/GITHUB-COPILOT.md`

General merge intent:
- Take upstream logic improvements where possible.
- Re-apply Copilot-specific auth/runtime behavior.
- Keep host-token auth flow intact.

## Tools and Commands

Use shell commands and repository scripts directly:

- `git fetch upstream --prune`
- `git checkout main && git merge --ff-only upstream/main`
- `git checkout copilot/port-to-github-copilot`
- `git merge main` or `git rebase main`
- `npm run skills:refresh`
- `npm run skills:fleet -- --skip-prep`

## Output Requirements

Return a concise execution report with:

1. Strategy used (merge/rebase)
2. Upstream commits integrated
3. Conflict files and how they were resolved
4. Migration scripts executed and outcomes
5. Build/test status
6. Remaining risks or manual follow-ups

## Safety Rules

- Do not use destructive git commands (`reset --hard`, checkout file rollback) unless explicitly requested.
- Do not discard unrelated user changes.
- If blocked by ambiguous conflicts, stop and ask for a targeted decision.
