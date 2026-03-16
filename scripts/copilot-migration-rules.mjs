import path from 'node:path';

export const REPLACEMENT_RULES = [
  {
    id: 'ask-user-tool-rename',
    title: 'AskUserQuestion tool rename',
    pattern: '\\bAskUserQuestion\\b',
    flags: 'g',
    replacement: 'ask_user'
  },
  {
    id: 'claude-brand-rename',
    title: 'Claude brand rename',
    pattern: '\\bClaude\\b',
    flags: 'g',
    replacement: 'GitHub Copilot'
  },
  {
    id: 'anthropic-brand-rename',
    title: 'Anthropic brand rename',
    pattern: '\\bAnthropic\\b',
    flags: 'g',
    replacement: 'GitHub Copilot'
  },
  {
    id: 'claude-memory-file-rename',
    title: 'CLAUDE memory file rename',
    pattern: '\\bCLAUDE\\.md\\b',
    flags: 'g',
    replacement: 'AGENTS.md'
  },
  {
    id: 'oauth-env-var-rename',
    title: 'OAuth env var rename',
    pattern: '\\bCLAUDE_CODE_OAUTH_TOKEN\\b',
    flags: 'g',
    replacement: 'GitHub Copilot host authentication (~/.config/github-copilot/hosts.json)'
  },
  {
    id: 'api-key-env-var-rename',
    title: 'API key env var rename',
    pattern: '\\bANTHROPIC_API_KEY\\b',
    flags: 'g',
    replacement: 'GitHub Copilot host authentication (~/.config/github-copilot/hosts.json)'
  }
];

export const SCANNABLE_TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.json',
  '.sh',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.ini',
  '.cfg',
  '.conf',
  '.toml',
  '.xml',
  '.csv',
  '.env'
]);

export const SCANNABLE_TEXT_BASENAMES = new Set(['SKILL', 'README', 'AGENTS.md', 'CLAUDE.md']);

export function buildRegex(rule) {
  return new RegExp(rule.pattern, rule.flags);
}

export function isScannableTextFile(filePath) {
  const baseName = path.basename(filePath);
  if (SCANNABLE_TEXT_BASENAMES.has(baseName)) {
    return true;
  }
  const extension = path.extname(filePath).toLowerCase();
  return SCANNABLE_TEXT_EXTENSIONS.has(extension);
}
