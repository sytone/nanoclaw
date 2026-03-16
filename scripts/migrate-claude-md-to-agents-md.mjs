#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const RENAME_PAIRS = [
  ['CLAUDE.md', 'AGENTS.md'],
  ['groups/main/CLAUDE.md', 'groups/main/AGENTS.md'],
  ['groups/global/CLAUDE.md', 'groups/global/AGENTS.md'],
];

function safeMove(fromRel, toRel) {
  const fromPath = path.join(repoRoot, fromRel);
  const toPath = path.join(repoRoot, toRel);

  if (!fs.existsSync(fromPath)) {
    return { moved: false, reason: 'missing-source' };
  }

  fs.mkdirSync(path.dirname(toPath), { recursive: true });

  if (fs.existsSync(toPath)) {
    // Source already migrated in a previous run.
    fs.rmSync(fromPath, { force: true });
    return { moved: false, reason: 'target-exists' };
  }

  fs.renameSync(fromPath, toPath);
  return { moved: true, reason: 'renamed' };
}

function getTrackedFiles() {
  const raw = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function updateReferences(fileRelPath) {
  const filePath = path.join(repoRoot, fileRelPath);
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = original.replace(/\bCLAUDE\.md\b/g, 'AGENTS.md');

  if (updated !== original) {
    fs.writeFileSync(filePath, updated, 'utf8');
    return true;
  }
  return false;
}

function main() {
  const renameSummary = [];
  for (const [fromRel, toRel] of RENAME_PAIRS) {
    const result = safeMove(fromRel, toRel);
    renameSummary.push({ fromRel, toRel, ...result });
  }

  const trackedFiles = getTrackedFiles();
  let updatedCount = 0;
  for (const relPath of trackedFiles) {
    try {
      const changed = updateReferences(relPath);
      if (changed) updatedCount += 1;
    } catch {
      // Skip files that are not readable as text.
    }
  }

  const movedCount = renameSummary.filter((r) => r.moved).length;

  console.log(`Renamed memory files: ${movedCount}`);
  for (const row of renameSummary) {
    console.log(`- ${row.fromRel} -> ${row.toRel} (${row.reason})`);
  }
  console.log(`Updated CLAUDE.md references in tracked files: ${updatedCount}`);
}

main();
