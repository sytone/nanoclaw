#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sourceRoot = path.join(repoRoot, '.claude', 'skills');
const destinationRoot = path.join(repoRoot, '.github', 'skills');
const summaryPath = path.join(destinationRoot, 'sync-summary.json');

const PROTECTED_FILES = new Set([
	'README.md',
	'skill-sync-map.md',
	'copilot-compatibility-report.md',
	'sync-summary.json'
]);

function ensureDirectory(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function removeDirectoryIfExists(dirPath) {
	if (fs.existsSync(dirPath)) {
		fs.rmSync(dirPath, { recursive: true, force: true });
	}
}

function copyDirectory(sourceDir, targetDir) {
	ensureDirectory(targetDir);
	const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(sourceDir, entry.name);
		const targetPath = path.join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyDirectory(sourcePath, targetPath);
		} else {
			fs.copyFileSync(sourcePath, targetPath);
		}
	}
}

function countFilesInDirectory(dirPath) {
	let fileCount = 0;
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			fileCount += countFilesInDirectory(fullPath);
		} else {
			fileCount += 1;
		}
	}
	return fileCount;
}

function listSkillDirectories(dirPath) {
	return fs
		.readdirSync(dirPath, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function main() {
	if (!fs.existsSync(sourceRoot)) {
		console.error('ERROR: Source skill directory not found: .claude/skills');
		process.exit(1);
	}

	ensureDirectory(destinationRoot);

	const sourceSkills = listSkillDirectories(sourceRoot);

	for (const entry of fs.readdirSync(destinationRoot, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			removeDirectoryIfExists(path.join(destinationRoot, entry.name));
			continue;
		}
		if (!PROTECTED_FILES.has(entry.name)) {
			fs.rmSync(path.join(destinationRoot, entry.name), { force: true });
		}
	}

	let copiedFiles = 0;
	for (const skillName of sourceSkills) {
		const sourceSkillDir = path.join(sourceRoot, skillName);
		const destinationSkillDir = path.join(destinationRoot, skillName);
		copyDirectory(sourceSkillDir, destinationSkillDir);
		copiedFiles += countFilesInDirectory(sourceSkillDir);
	}

	const summary = {
		generatedAt: new Date().toISOString(),
		source: '.claude/skills',
		destination: '.github/skills',
		skillCount: sourceSkills.length,
		copiedFileCount: copiedFiles,
		skills: sourceSkills
	};

	fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

	console.log(`Synced ${sourceSkills.length} skills and ${copiedFiles} files to .github/skills`);
	console.log('Wrote .github/skills/sync-summary.json');
}

main();
