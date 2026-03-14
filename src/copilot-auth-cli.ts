#!/usr/bin/env tsx
/**
 * GitHub Copilot OAuth device-code authentication CLI.
 * Run: npm run copilot-auth
 *
 * This walks through the GitHub OAuth device-code flow and saves
 * GITHUB_TOKEN to your .env file.  Requires an active GitHub Copilot
 * subscription on the authorised account.
 */
import { runDeviceCodeFlow } from './github-copilot-auth.js';

runDeviceCodeFlow().catch((err) => {
  console.error(
    '\n❌  Authentication failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
