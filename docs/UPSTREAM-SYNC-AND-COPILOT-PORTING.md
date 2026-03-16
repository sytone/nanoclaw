# Upstream Sync and Copilot Porting Runbook

This runbook explains how to:

1. Sync your local `main` with upstream `main`
2. Bring those updates into `copilot/port-to-github-copilot`
3. Update Copilot-specific code paths after the sync
4. Validate and prepare a clean PR

Use this whenever upstream `qwibitai/nanoclaw` changes and your Copilot branch must stay current.

## Branch and Remote Assumptions

- Upstream repo: `qwibitai/nanoclaw`
- Your fork remote: `origin`
- Upstream remote: `upstream`
- Base branch: `main`
- Copilot branch: `copilot/port-to-github-copilot`

## 0. Pre-flight Checks

```bash
git remote -v
git status --short
```

If you have uncommitted work, either commit it or stash it before sync.

```bash
git add -A && git commit -m "WIP before upstream sync"
# or
git stash push -u -m "pre-upstream-sync"
```

## 1. Sync Local Main with Upstream Main

```bash
git fetch upstream --prune
git checkout main
git merge --ff-only upstream/main
```

If you keep your fork's `main` updated:

```bash
git push origin main
```

## 2. Bring Main into the Copilot Branch

Choose one strategy.

### Option A: Merge (safer, preserves branch history)

```bash
git checkout copilot/port-to-github-copilot
git merge main
```

### Option B: Rebase (clean linear history)

```bash
git checkout copilot/port-to-github-copilot
git rebase main
```

If conflicts happen during rebase:

```bash
# resolve files
git add <resolved-files>
git rebase --continue
```

If needed:

```bash
git rebase --abort
```

## 3. Conflict Resolution Priority (Copilot Branch)

Resolve conflicts by preserving Copilot behavior in these files and paths:

- `container-copilot/agent-runner/src/index.ts`
- `container-copilot/agent-runner/src/ipc-mcp-stdio.ts`
- `container-copilot/agent-runner/src/copilot-runner.ts`
- `src/credential-proxy.ts`
- `src/github-copilot-auth.ts`
- `src/copilot-auth-cli.ts`
- `setup/verify.ts`
- `setup/environment.test.ts`
- `docs/GITHUB-COPILOT.md`

General rule:

1. Take upstream logic improvements where possible
2. Re-apply Copilot-specific auth/runtime changes
3. Keep host-token flow (`~/.config/github-copilot/hosts.json`) intact

## 4. Port Upstream Container-Agent Changes into Copilot Container

Upstream often changes `container/agent-runner/*`. Port those changes to `container-copilot/agent-runner/*`.

Recommended pairings:

- `container/agent-runner/src/index.ts` -> `container-copilot/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts` -> `container-copilot/agent-runner/src/ipc-mcp-stdio.ts`

When upstream changes `container/Dockerfile`, port relevant base/runtime changes into:

- `container-copilot/Dockerfile`

Do not reintroduce Claude-only runtime assumptions into Copilot-only paths.

## 5. Run Skill Sync/Migration Pipeline (If Skills Changed)

If skill files changed upstream or branch docs changed:

```bash
npm run skills:refresh
```

`skills:refresh` includes AGENTS migration automation:

- Renames repository memory files from `CLAUDE.md` to `AGENTS.md`
- Rewrites tracked file references from `CLAUDE.md` to `AGENTS.md`
- Syncs `.claude/skills` to `.github/skills`
- Runs deterministic Copilot migration and compatibility audit

If you want semantic migration in parallel fleet mode:

```bash
npm run skills:fleet
# or faster
npm run skills:fleet:fast
```

Fleet mode uses `agency copilot` with autopilot and runs multiple skill agents concurrently.
It also reconciles any reintroduced `CLAUDE.md` files into canonical `AGENTS.md` files before skill migration.

Optional opt-out for memory reconciliation:

```bash
npm run skills:fleet -- --skip-memory-reconcile
```

## 6. Validate Build and Tests

Use Node 20 for consistency:

```bash
nvm use 20
npm install
npm run build
npm test
```

For Copilot container validation:

```bash
cd container-copilot
./build.sh
cd ..
```

Optional auth check:

```bash
npm run copilot-auth
```

## 7. Check for Line Ending and Mode Noise

Before committing, verify diffs are real code changes, not newline churn.

```bash
git status --short
git --no-pager diff --numstat
```

If needed, renormalize:

```bash
git add --renormalize .
```

## 8. Commit and Push

```bash
git add -A
git commit -m "Sync upstream main and port Copilot branch updates"
git push origin copilot/port-to-github-copilot
```

If you rebased and branch was already pushed:

```bash
git push --force-with-lease origin copilot/port-to-github-copilot
```

## 9. PR Checklist

Before opening/updating PR:

- Upstream `main` merged/rebased into branch
- Copilot auth flow still uses host token file
- Copilot container runner still operational
- Credential proxy Copilot mode still works
- Skill migration/audit reports regenerated if needed
- Build and tests pass
- Docs updated where behavior changed

## Quick Command Sequence (Merge Strategy)

```bash
git fetch upstream --prune
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout copilot/port-to-github-copilot
git merge main
nvm use 20
npm install
npm run build
npm test
npm run skills:refresh
npm run skills:fleet -- --skip-prep
```

## Autonomous Agent Mode

If you want one agent to run the full workflow independently:

```bash
npm run upstream:sync:migrate
```

Optional parameters:

```bash
bash scripts/run-upstream-sync-copilot-migrator.sh --strategy rebase --workers 8 --model gpt-5.3-codex
```

## Notes for This Repository

- Keep the branch small and additive where possible.
- Prefer preserving upstream behavior and layering Copilot-specific differences.
- If uncertain during conflicts, compare against `docs/GITHUB-COPILOT.md` and keep that document aligned with actual code behavior.
