#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { REPLACEMENT_RULES, buildRegex, isScannableTextFile } from './copilot-migration-rules.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const skillsRoot = path.join(repoRoot, '.github', 'skills');
const reportPath = path.join(skillsRoot, 'copilot-compatibility-report.md');
const SKIP_FILES = new Set(['README.md', 'copilot-compatibility-report.md', 'skill-sync-map.md', 'sync-summary.json']);

const RULES = [
  {
    id: 'claude-commands',
    title: 'Claude Slash Command Links',
    description: 'Skill-to-skill links that rely on Claude slash command semantics.',
    regex: /\/[a-z0-9][a-z0-9-]*/i,
    suggestion: 'Verify command references map to Copilot agents/skills invocation flow.'
  },
  ...REPLACEMENT_RULES.map((rule) => ({
    id: `migration-rule-${rule.id}`,
    title: `Migration Rule Drift: ${rule.title}`,
    description: `Pattern still present after migration: ${rule.pattern}`,
    regex: buildRegex({ ...rule, flags: rule.flags.replace('g', '') || 'i' }),
    suggestion: 'Run npm run skills:migrate and review files that were skipped as non-text.'
  }))
];

function walkFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
      continue;
    }

    files.push(fullPath);
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

function parseArgs(argv) {
  return {
    failOnSkipped: argv.includes('--fail-on-skipped')
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(skillsRoot)) {
    console.error('ERROR: .github/skills does not exist. Run skills:sync first.');
    process.exit(1);
  }

  const allFiles = walkFiles(skillsRoot).filter((filePath) => {
    const relativeToSkillsRoot = path.relative(skillsRoot, filePath).split(path.sep).join('/');
    return relativeToSkillsRoot.includes('/') && !SKIP_FILES.has(path.basename(filePath));
  });

  const scannedFiles = [];
  const skippedFiles = [];

  const findings = [];

  for (const filePath of allFiles) {
    if (!isScannableTextFile(filePath)) {
      skippedFiles.push(toRepoRelative(filePath));
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    scannedFiles.push(toRepoRelative(filePath));
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
  lines.push(`Scannable text files: ${scannedFiles.length}`);
  lines.push(`Skipped non-text files: ${skippedFiles.length}`);
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

  if (skippedFiles.length > 0) {
    lines.push('## Skipped Non-Text Files');
    lines.push('');
    lines.push('These files were skipped by content audit. If new instruction formats are added, extend scannable extensions in scripts/copilot-migration-rules.mjs.');
    lines.push('');
    for (const filePath of skippedFiles.slice(0, 30)) {
      lines.push(`- ${filePath}`);
    }
    if (skippedFiles.length > 30) {
      lines.push(`- ... ${skippedFiles.length - 30} more skipped files`);
    }
    lines.push('');
  }

  lines.push('## Next Steps');
  lines.push('');
  lines.push('- Replace Claude-specific commands and env vars with Copilot equivalents.');
  lines.push('- Update references to CLAUDE.md to the instruction files Copilot should use.');
  lines.push('- Re-run: npm run skills:audit');
  lines.push('');

  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(`Wrote report: ${toRepoRelative(reportPath)}`);
  console.log(`Scanned ${scannedFiles.length}/${allFiles.length} files, found ${totalMatches} matches across ${findings.length} files.`);
  if (skippedFiles.length > 0) {
    console.log(`Skipped ${skippedFiles.length} non-text files (listed in report).`);
  }

  if (options.failOnSkipped && skippedFiles.length > 0) {
    console.error('ERROR: Strict audit failed because skipped non-text files were detected.');
    process.exit(2);
  }
}

main();
