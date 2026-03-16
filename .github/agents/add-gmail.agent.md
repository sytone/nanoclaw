---
name: add-gmail-agent
description: Migrated from .claude skill add-gmail for GitHub Copilot agent usage.
---

# add-gmail Sync and Migration Agent

Source of truth: .claude/skills/add-gmail/SKILL.md
Working copy: .github/skills/add-gmail/SKILL.md
Agent file: .github/agents/add-gmail.agent.md

## Purpose

This agent keeps one skill aligned across Claude and Copilot formats.
It is responsible for reviewing the source skill in `.claude/skills`, syncing updates into `.github/skills`, and applying Copilot compatibility changes.

## Required Workflow

1. Read source skill from `.claude/skills/<skill>/SKILL.md`.
2. Compare source skill to `.github/skills/<skill>/SKILL.md`.
3. If source changed, copy source content to `.github/skills/<skill>/SKILL.md` first.
4. Review synced copy for Claude-specific assumptions and convert for Copilot use.
5. Keep behavior intact; only change provider/tooling assumptions and incompatible references.
6. Update this agent file summary when migration behavior changes.
7. Record unresolved items in compatibility report.

## Copilot Migration Rules

- No deterministic replacements were detected in current source snapshot.

- Replace `AskUserQuestion` references with `ask_user` usage patterns.
- Replace Claude-only auth/env references with GitHub Copilot host-auth flow.
- Replace memory-file references from `CLAUDE.md` to `AGENTS.md` for agent-agnostic compatibility.
- Validate slash-command and delegation references against Copilot agent invocation flow.

## Done Criteria

- `.github/skills/<skill>/SKILL.md` matches latest source structure and behavior.
- Copilot-incompatible wording or tooling is removed or documented as a known exception.
- Compatibility findings are reduced or explained in reports.
