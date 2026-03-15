import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

let mockCopilotToken: string | undefined;
vi.mock('./github-copilot-auth.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./github-copilot-auth.js')>();
  return {
    ...actual,
    readTokenFromCopilotConfigFile: vi.fn(() => mockCopilotToken),
  };
});

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let tokenServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let tokenServerPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    // Token exchange server for Copilot mode tests
    tokenServer = http.createServer((_req, res) => {
      const expires = new Date(Date.now() + 3600_000).toISOString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ token: 'copilot-token-xyz', expires_at: expires }),
      );
    });
    await new Promise<void>((resolve) =>
      tokenServer.listen(0, '127.0.0.1', resolve),
    );
    tokenServerPort = (tokenServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    await new Promise<void>((r) => tokenServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    mockCopilotToken = undefined;
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  async function startCopilotProxy(githubToken: string): Promise<number> {
    mockCopilotToken = githubToken;
    Object.assign(mockEnv, {
      COPILOT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      COPILOT_TOKEN_URL: `http://127.0.0.1:${tokenServerPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('Copilot mode exchanges GitHub token for Copilot token and injects Authorization', async () => {
    proxyPort = await startCopilotProxy('ghp_real-github-token');

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    // Proxy must replace placeholder with the fresh Copilot token
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer copilot-token-xyz',
    );
  });

  it('Copilot mode injects copilot-integration-id header', async () => {
    proxyPort = await startCopilotProxy('ghp_real-github-token');

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/chat/completions',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['copilot-integration-id']).toBe('vscode-chat');
  });

  it('Copilot mode forwards requests to Copilot base URL', async () => {
    proxyPort = await startCopilotProxy('ghp_real-github-token');

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/chat/completions',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    // The upstream (mock) returns 200 with { ok: true }
    expect(res.statusCode).toBe(200);
  });

  it('detectAuthMode returns github-copilot when copilot config file has token', async () => {
    const { detectAuthMode } = await import('./credential-proxy.js');
    mockCopilotToken = 'ghp_test';
    expect(detectAuthMode()).toBe('github-copilot');
  });

  it('detectAuthMode returns api-key when ANTHROPIC_API_KEY is set (no copilot token)', async () => {
    const { detectAuthMode } = await import('./credential-proxy.js');
    Object.assign(mockEnv, { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(detectAuthMode()).toBe('api-key');
  });
});
