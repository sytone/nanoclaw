/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the AI provider API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth modes:
 *   github-copilot: Proxy holds a GitHub token, exchanges it for a short-lived
 *                   Copilot token (refreshed automatically), and injects it as
 *                   Authorization: Bearer <copilot_token> on every request.
 *                   Requests are forwarded to api.githubcopilot.com.
 *   api-key:        Proxy injects x-api-key on every request.
 *                   (Legacy Anthropic API key mode — kept for compatibility.)
 *   oauth:          Container CLI exchanges its placeholder token for a temp
 *                   API key via /api/oauth/claude_cli/create_api_key.
 *                   Proxy injects real OAuth token on that exchange request.
 *                   (Legacy Anthropic OAuth mode — kept for compatibility.)
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { CopilotTokenCache, COPILOT_TOKEN_URL } from './github-copilot-auth.js';

export type AuthMode = 'api-key' | 'oauth' | 'github-copilot';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'COPILOT_BASE_URL',
    'COPILOT_TOKEN_URL',
  ]);

  // Determine auth mode: Copilot takes priority, then API key, then OAuth
  const authMode: AuthMode = secrets.GITHUB_TOKEN
    ? 'github-copilot'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';

  // GitHub Copilot mode: resolve upstream URL and token cache
  const copilotBaseUrl = new URL(
    secrets.COPILOT_BASE_URL || 'https://api.githubcopilot.com',
  );
  const copilotTokenCache =
    authMode === 'github-copilot'
      ? new CopilotTokenCache(
          secrets.GITHUB_TOKEN,
          secrets.COPILOT_TOKEN_URL || COPILOT_TOKEN_URL,
        )
      : null;

  // Legacy Anthropic modes
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const anthropicUpstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );

  const upstreamUrl =
    authMode === 'github-copilot' ? copilotBaseUrl : anthropicUpstreamUrl;
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        const handleRequest = async () => {
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

          // Strip hop-by-hop headers that must not be forwarded by proxies
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'github-copilot' && copilotTokenCache) {
            // Copilot mode: always inject a fresh Authorization header
            delete headers['authorization'];
            const copilotToken = await copilotTokenCache.getToken();
            headers['authorization'] = `Bearer ${copilotToken}`;
            // Required Copilot integration headers
            headers['copilot-integration-id'] = 'vscode-chat';
            headers['editor-version'] = headers['editor-version'] ?? 'vscode/1.85.0';
          } else if (authMode === 'api-key') {
            // API key mode: inject x-api-key on every request
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else {
            // OAuth mode: replace placeholder Bearer token with the real one
            // only when the container actually sends an Authorization header.
            if (headers['authorization']) {
              delete headers['authorization'];
              if (oauthToken) {
                headers['authorization'] = `Bearer ${oauthToken}`;
              }
            }
          }

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        };

        handleRequest().catch((err) => {
          logger.error({ err }, 'Credential proxy error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['GITHUB_TOKEN', 'ANTHROPIC_API_KEY']);
  if (secrets.GITHUB_TOKEN) return 'github-copilot';
  if (secrets.ANTHROPIC_API_KEY) return 'api-key';
  return 'oauth';
}
