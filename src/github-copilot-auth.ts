/**
 * GitHub Copilot authentication helpers.
 *
 * Provides:
 *   1. OAuth device-code flow to obtain a GitHub access token
 *   2. Copilot token exchange (GitHub token → short-lived Copilot API token)
 *   3. Token cache with automatic refresh
 *
 * The GitHub OAuth device-code flow:
 *   POST https://github.com/login/device/code  → device_code + user_code
 *   User visits verification_uri and enters user_code
 *   Poll https://github.com/login/oauth/access_token → access_token
 *
 * The Copilot token exchange:
 *   GET https://api.github.com/copilot_internal/v2/token  (Authorization: token <github_token>)
 *   → { token, expires_at }
 *
 * Copilot tokens expire roughly every hour; CopilotTokenCache handles refresh.
 */

import * as https from 'https';
import * as http from 'http';
import type { IncomingMessage } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

// Well-known client ID for GitHub Copilot device-code flow.
// Users may override with their own OAuth app's client ID via GITHUB_OAUTH_CLIENT_ID.
const DEFAULT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const COPILOT_TOKEN_URL =
  process.env.COPILOT_TOKEN_URL ||
  'https://api.github.com/copilot_internal/v2/token';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface CopilotTokenResponse {
  token: string;
  expires_at: string;
}

/** Collect a response body and resolve as parsed JSON. */
function collectJson(res: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(
          new Error(
            `Failed to parse response: ${Buffer.concat(chunks).toString()}`,
          ),
        );
      }
    });
    res.on('error', reject);
  });
}

/** Simple HTTPS/HTTP POST helper that returns the parsed JSON body. */
function httpPost(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'nanoclaw/1.0.0',
        ...headers,
      },
    };

    const req = isHttps
      ? https.request(options, (res) => collectJson(res).then(resolve, reject))
      : http.request(options, (res) => collectJson(res).then(resolve, reject));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Simple HTTPS/HTTP GET helper that returns the parsed JSON body. */
function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'nanoclaw/1.0.0',
        ...headers,
      },
    };

    const req = isHttps
      ? https.request(options, (res) => collectJson(res).then(resolve, reject))
      : http.request(options, (res) => collectJson(res).then(resolve, reject));
    req.on('error', reject);
    req.end();
  });
}

/** Request a device code from GitHub. */
export async function requestDeviceCode(
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<DeviceCodeResponse> {
  const raw = await httpPost(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: 'copilot',
  });
  const data = raw as DeviceCodeResponse & {
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(
      `Device code request failed: ${data.error} — ${data.error_description || ''}`,
    );
  }
  return data;
}

/** Poll GitHub until the user authorises the device or it times out. */
export async function pollForAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<string> {
  const pollIntervalMs = Math.max(intervalSeconds, 5) * 1000;
  const maxAttempts = 60; // ~5 min with 5-second intervals

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const raw = await httpPost(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const data = raw as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      continue;
    }
    if (data.error === 'slow_down') {
      // Server asks us to back off — wait an extra 5 seconds
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (data.error) {
      throw new Error(
        `Access token poll failed: ${data.error} — ${data.error_description || ''}`,
      );
    }
  }

  throw new Error('Timed out waiting for GitHub authorisation');
}

/** Exchange a GitHub access token for a short-lived Copilot API token. */
export async function exchangeForCopilotToken(
  githubToken: string,
  tokenUrl: string = COPILOT_TOKEN_URL,
): Promise<CopilotTokenResponse> {
  const raw = await httpGet(tokenUrl, {
    Authorization: `token ${githubToken}`,
  });
  const data = raw as CopilotTokenResponse & { message?: string };

  if (!data.token) {
    throw new Error(
      `Copilot token exchange failed: ${data.message || JSON.stringify(data)}`,
    );
  }
  return data;
}

/** Cache that holds the current Copilot token and refreshes it before expiry. */
export class CopilotTokenCache {
  private cachedToken: string | null = null;
  private expiresAt: number = 0;
  private pendingRefresh: Promise<string> | null = null;

  constructor(
    private readonly githubToken: string,
    private readonly tokenUrl: string = COPILOT_TOKEN_URL,
  ) {}

  async getToken(): Promise<string> {
    // Return cached token if still valid with a 5-minute safety margin
    if (
      this.cachedToken !== null &&
      Date.now() < this.expiresAt - 5 * 60 * 1000
    ) {
      return this.cachedToken;
    }

    // Coalesce concurrent refresh calls
    if (this.pendingRefresh) {
      return this.pendingRefresh;
    }

    this.pendingRefresh = this.refresh().finally(() => {
      this.pendingRefresh = null;
    });
    return this.pendingRefresh;
  }

  private async refresh(): Promise<string> {
    logger.debug('Refreshing GitHub Copilot token');
    const result = await exchangeForCopilotToken(
      this.githubToken,
      this.tokenUrl,
    );
    this.cachedToken = result.token;
    this.expiresAt = new Date(result.expires_at).getTime();
    logger.debug(
      { expiresAt: result.expires_at },
      'GitHub Copilot token refreshed',
    );
    return this.cachedToken;
  }
}

/**
 * Interactive CLI: run the OAuth device-code flow and save the token to
 * ~/.config/github-copilot/hosts.json.
 * Run via: npm run copilot-auth
 */
export async function runDeviceCodeFlow(): Promise<void> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;

  console.log('\n🔑  GitHub Copilot Authentication\n');
  console.log('Requesting a device code from GitHub…');

  const deviceCode = await requestDeviceCode(clientId);

  console.log('\n  1. Open this URL in your browser:');
  console.log(`     ${deviceCode.verification_uri}`);
  console.log('\n  2. Enter this code when prompted:');
  console.log(`     ${deviceCode.user_code}`);
  console.log(
    '\nWaiting for you to authorise in the browser… (press Ctrl+C to cancel)\n',
  );

  const token = await pollForAccessToken(
    deviceCode.device_code,
    deviceCode.interval,
    clientId,
  );

  console.log('✅  Authorised!');

  // Verify the token can exchange for a Copilot token
  try {
    const copilotToken = await exchangeForCopilotToken(token);
    const expiresAt = new Date(copilotToken.expires_at).toLocaleTimeString();
    console.log(`✅  Copilot token obtained (expires ~${expiresAt})`);
  } catch (err) {
    console.warn(
      `⚠️  Could not exchange for Copilot token: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.warn(
      '   Make sure your GitHub account has an active Copilot subscription.',
    );
  }

  // Write token to ~/.config/github-copilot/hosts.json
  writeCopilotHostsFile(token);

  console.log(
    '\n✅  Done!  Run `npm start` or `npm run dev` to start NanoClaw.',
  );
}

/**
 * Read the GitHub OAuth token from the local Copilot CLI credentials file
 * (`~/.config/github-copilot/hosts.json`).  This is the same file that the
 * `gh` CLI, VS Code Copilot extension, and `npm run copilot-auth` write after
 * a `copilot login` / `gh auth login` flow.
 *
 * Returns `undefined` when the file is absent or cannot be parsed.
 */
export function readTokenFromCopilotConfigFile(): string | undefined {
  const hostsFile = path.join(
    os.homedir(),
    '.config',
    'github-copilot',
    'hosts.json',
  );
  if (!fs.existsSync(hostsFile)) return undefined;

  try {
    const raw = fs.readFileSync(hostsFile, 'utf-8');
    const hosts = JSON.parse(raw) as Record<
      string,
      { oauth_token?: string; user?: string }
    >;
    // Prefer github.com; fall back to first entry that has a token
    const entry =
      hosts['github.com'] ?? Object.values(hosts).find((v) => v.oauth_token);
    return entry?.oauth_token || undefined;
  } catch {
    return undefined;
  }
}

/** Write the GitHub OAuth token to ~/.config/github-copilot/hosts.json. */
function writeCopilotHostsFile(token: string): void {
  const hostsDir = path.join(os.homedir(), '.config', 'github-copilot');
  const hostsFile = path.join(hostsDir, 'hosts.json');

  fs.mkdirSync(hostsDir, { recursive: true });

  let hosts: Record<string, { oauth_token?: string; user?: string }> = {};
  if (fs.existsSync(hostsFile)) {
    try {
      hosts = JSON.parse(fs.readFileSync(hostsFile, 'utf-8'));
    } catch {
      // ignore — overwrite with fresh content
    }
  }

  hosts['github.com'] = { ...hosts['github.com'], oauth_token: token };
  fs.writeFileSync(hostsFile, JSON.stringify(hosts, null, 2) + '\n', {
    mode: 0o600,
  });
  logger.info('OAuth token written to ~/.config/github-copilot/hosts.json');
}
