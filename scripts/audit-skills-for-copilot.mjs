#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const skillsRoot = path.join(repoRoot, '.github', 'skills');
const reportPath = path.join(skillsRoot, 'copilot-compatibility-report.md');

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.sh']);

const RULES = [
  {
    id: 'claude-branding',
    title: 'Claude-Specific Branding',
    description: 'References to Claude or Anthropic that usually need renaming for Copilot.',
    regex: /\b(Claude|Anthropic|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|claude setup-token)\b/i,
    suggestion: 'Replace with GitHub Copilot terminology and environment variables where appropriate.'
  },
  {
    id: 'claude-memory-files',
    title: 'Claude Memory File References',
    description: 'Direct references to CLAUDE.md memory files.',
    regex: /\bCLAUDE\.md\b/,
    suggestion: 'Replace CLAUDE.md references with AGENTS.md as the agent-agnostic memory/instructions file.'
  },
  {
    id: 'claude-tooling',
    title: 'Claude-Specific Tooling Names',
    description: 'Mentions of Claude-only tool APIs.',
    regex: /\bAskUserQuestion\b/,
    suggestion: 'Replace AskUserQuestion with ask_user interaction patterns and options/freeform handling.'
  },
  {
    id: 'claude-commands',
    title: 'Claude Slash Command Links',
    description: 'Skill-to-skill links that rely on Claude slash command semantics.',
    regex: /\/[a-z0-9][a-z0-9-]*/i,
    suggestion: 'Verify command references map to Copilot agents/skills invocation flow.'
  }
];

function walkFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function findMatchesForRule(lines, rule) {
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (rule.regex.test(lines[i])) {
      matches.push({
        line: i + 1,
        text: lines[i].trim().slice(0, 180)
      });
    }
  }
  return matches;
}

function toRepoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function main() {
  if (!fs.existsSync(skillsRoot)) {
    console.error('ERROR: .github/skills does not exist. Run skills:sync first.');
    process.exit(1);
  }

  const allFiles = walkFiles(skillsRoot).filter((filePath) => {
    const normalized = toRepoRelative(filePath);
    return !normalized.endsWith('copilot-compatibility-report.md') && !normalized.endsWith('skill-sync-map.md');
  });

  const findings = [];

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const perRule = [];

    for (const rule of RULES) {
      const matches = findMatchesForRule(lines, rule);
      if (matches.length > 0) {
        perRule.push({ rule, matches });
      }
    }

    if (perRule.length > 0) {
      findings.push({
        file: toRepoRelative(filePath),
        perRule
      });
    }
  }

  const totalMatches = findings.reduce(
    (sum, fileFinding) =>
      sum + fileFinding.perRule.reduce((inner, ruleFinding) => inner + ruleFinding.matches.length, 0),
    0
  );

  const lines = [];
  lines.push('# Copilot Skill Compatibility Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Scanned files: ${allFiles.length}`);
  lines.push(`Files with findings: ${findings.length}`);
  lines.push(`Total findings: ${totalMatches}`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('No Claude-specific patterns found.');
  } else {
    lines.push('## Findings by file');
    lines.push('');

    for (const fileFinding of findings) {
      lines.push(`### ${fileFinding.file}`);
      lines.push('');
      for (const ruleFinding of fileFinding.perRule) {
        lines.push(`- ${ruleFinding.rule.title}: ${ruleFinding.rule.description}`);
        lines.push(`- Suggested update: ${ruleFinding.rule.suggestion}`);
        for (const match of ruleFinding.matches.slice(0, 8)) {
          lines.push(`- Line ${match.line}: ${match.text}`);
        }
        if (ruleFinding.matches.length > 8) {
          lines.push(`- ... ${ruleFinding.matches.length - 8} more matches in this file`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Next Steps');
  lines.push('');
  lines.push('- Replace Claude-specific commands and env vars with Copilot equivalents.');
  lines.push('- Update references to CLAUDE.md to the instruction files Copilot should use.');
  lines.push('- Re-run: npm run skills:audit');
  lines.push('');

  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(`Wrote report: ${toRepoRelative(reportPath)}`);
  console.log(`Scanned ${allFiles.length} files, found ${totalMatches} matches across ${findings.length} files.`);
}

main();
