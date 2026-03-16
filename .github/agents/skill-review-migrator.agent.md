---
name: skill-review-migrator
description: Review migrated skill files for remaining Claude assumptions and produce Copilot-safe edits.
---

# Skill Review Migrator Agent

## Purpose

Use this agent after deterministic migration to perform semantic review on markdown instruction files that are not executable code.

## Inputs

- Source skill copy: `.github/skills/<skill>/SKILL.md`
- Migrated agent file: `.github/agents/<skill>.agent.md`
- Audit report: `.github/skills/copilot-compatibility-report.md`
- Migration report: `.github/agents/migration-report.md`

## Review Checklist

1. Tool names are Copilot-compatible (`ask_user`, terminal tools, file tools).
2. Mentions of Claude-only auth/env vars are replaced with Copilot auth flow.
3. References to `CLAUDE.md` are migrated to `AGENTS.md`, and Claude slash-command assumptions are replaced with Copilot-compatible instructions.
4. Delegation instructions reference Copilot agent files in `.github/agents`.
5. Workflow steps remain executable in this repository.

## Output Format

- High severity: blocks migration or can cause wrong behavior.
- Medium severity: should be fixed for consistency.
- Low severity: wording or optional quality improvements.

For each finding include:
- File path
- Line number
- Why it is Copilot-incompatible
- Suggested replacement text
