#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sourceRoot = path.join(repoRoot, '.github', 'skills');
const destinationRoot = path.join(repoRoot, '.github', 'agents');
const reportPath = path.join(destinationRoot, 'migration-report.md');

const REPLACEMENTS = [
  {
    key: 'AskUserQuestion tool rename',
    regex: /\bAskUserQuestion\b/g,
    replacement: 'ask_user'
  },
  {
    key: 'Claude brand rename',
    regex: /\bClaude\b/g,
    replacement: 'GitHub Copilot'
  },
  {
    key: 'Anthropic brand rename',
    regex: /\bAnthropic\b/g,
    replacement: 'GitHub Copilot'
  },
  {
    key: 'CLAUDE memory file rename',
    regex: /\bCLAUDE\.md\b/g,
    replacement: 'AGENTS.md'
  },
  {
    key: 'OAuth env var rename',
    regex: /\bCLAUDE_CODE_OAUTH_TOKEN\b/g,
    replacement: 'GitHub Copilot host authentication (~/.config/github-copilot/hosts.json)'
  },
  {
    key: 'API key env var rename',
    regex: /\bANTHROPIC_API_KEY\b/g,
    replacement: 'GitHub Copilot host authentication (~/.config/github-copilot/hosts.json)'
  }
];

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function listSkillDirectories(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function applyReplacements(content) {
  let updated = content;
  const counts = new Map();

  for (const rule of REPLACEMENTS) {
    const before = updated;
    updated = updated.replace(rule.regex, rule.replacement);

    if (before !== updated) {
      const matchCount = (before.match(rule.regex) || []).length;
      counts.set(rule.key, (counts.get(rule.key) || 0) + matchCount);
    }
  }

  return { updated, counts };
}

function buildAgentFile(skillName, sourceContent, conversionCounts) {
  const replacementSummary = [...conversionCounts.entries()]
    .map(([key, count]) => `- ${key}: ${count}`)
    .join('\n');

  const header = [
    '---',
    `name: ${skillName}-agent`,
    `description: Migrated from .claude skill ${skillName} for GitHub Copilot agent usage.`,
    '---',
    '',
    `# ${skillName} Sync and Migration Agent`,
    '',
    `Source of truth: .claude/skills/${skillName}/SKILL.md`,
    `Working copy: .github/skills/${skillName}/SKILL.md`,
    `Agent file: .github/agents/${skillName}.agent.md`,
    '',
    '## Purpose',
    '',
    'This agent keeps one skill aligned across Claude and Copilot formats.',
    'It is responsible for reviewing the source skill in `.claude/skills`, syncing updates into `.github/skills`, and applying Copilot compatibility changes.',
    '',
    '## Required Workflow',
    '',
    '1. Read source skill from `.claude/skills/<skill>/SKILL.md`.',
    '2. Compare source skill to `.github/skills/<skill>/SKILL.md`.',
    '3. If source changed, copy source content to `.github/skills/<skill>/SKILL.md` first.',
    '4. Review synced copy for Claude-specific assumptions and convert for Copilot use.',
    '5. Keep behavior intact; only change provider/tooling assumptions and incompatible references.',
    '6. Update this agent file summary when migration behavior changes.',
    '7. Record unresolved items in compatibility report.',
    '',
    '## Copilot Migration Rules',
    '',
    replacementSummary || '- No deterministic replacements were detected in current source snapshot.',
    '',
    '- Replace `AskUserQuestion` references with `ask_user` usage patterns.',
    '- Replace Claude-only auth/env references with GitHub Copilot host-auth flow.',
    '- Replace memory-file references from `CLAUDE.md` to `AGENTS.md` for agent-agnostic compatibility.',
    '- Validate slash-command and delegation references against Copilot agent invocation flow.',
    '',
    '## Done Criteria',
    '',
    '- `.github/skills/<skill>/SKILL.md` matches latest source structure and behavior.',
    '- Copilot-incompatible wording or tooling is removed or documented as a known exception.',
    '- Compatibility findings are reduced or explained in reports.',
    ''
  ].join('\n');

  return `${header}`;
}

function main() {
  if (!fs.existsSync(sourceRoot)) {
    console.error('ERROR: .github/skills not found. Run npm run skills:sync first.');
    process.exit(1);
  }

  ensureDirectory(destinationRoot);

  const skillDirs = listSkillDirectories(sourceRoot).filter((skillName) =>
    fs.existsSync(path.join(sourceRoot, skillName, 'SKILL.md'))
  );

  const reportLines = [];
  reportLines.push('# Skill Migration Report');
  reportLines.push('');
  reportLines.push(`Generated: ${new Date().toISOString()}`);
  reportLines.push('');

  for (const skillName of skillDirs) {
    const sourcePath = path.join(sourceRoot, skillName, 'SKILL.md');
    const sourceContent = fs.readFileSync(sourcePath, 'utf8');
    const { updated, counts } = applyReplacements(sourceContent);

    // Keep .github/skills content migrated for Copilot compatibility.
    if (updated !== sourceContent) {
      fs.writeFileSync(sourcePath, updated, 'utf8');
    }

    const outputPath = path.join(destinationRoot, `${skillName}.agent.md`);
    const outputContent = buildAgentFile(skillName, sourceContent, counts);
    fs.writeFileSync(outputPath, outputContent, 'utf8');

    reportLines.push(`## ${skillName}`);
    reportLines.push('');
    reportLines.push(`- Source: .github/skills/${skillName}/SKILL.md`);
    reportLines.push(`- Agent: .github/agents/${skillName}.agent.md`);

    if (counts.size === 0) {
      reportLines.push('- Replacements: none');
    } else {
      reportLines.push('- Replacements:');
      for (const [key, count] of counts.entries()) {
        reportLines.push(`  - ${key}: ${count}`);
      }
    }

    reportLines.push('');
  }

  fs.writeFileSync(reportPath, `${reportLines.join('\n')}\n`, 'utf8');

  console.log(`Migrated ${skillDirs.length} skills to .github/agents`);
  console.log('Wrote .github/agents/migration-report.md');
}

main();
