/**
 * GitHub Copilot agent runner.
 *
 * Implements an agentic loop using the GitHub Copilot chat completions API
 * (OpenAI-compatible) with:
 *   - Built-in bash tool for shell execution
 *   - NanoClaw MCP tools (send_message, schedule_task, …) via stdio MCP server
 *   - Persistent conversation history stored in /workspace/group/.copilot-sessions/
 *   - Automatic archiving + truncation when history grows large
 *
 * The credential proxy on the host supplies a valid Copilot token via
 * COPILOT_BASE_URL, so containers never see the real GitHub token.
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSIONS_DIR = '/workspace/group/.copilot-sessions';
/** Maximum messages kept in the active window before archiving. */
const MAX_HISTORY_MESSAGES = 80;
/** Messages to retain after archiving (keeps recent context). */
const RETAIN_AFTER_ARCHIVE = 40;
/** Max agentic tool-call iterations per query. */
const MAX_TOOL_ITERATIONS = 50;
/** Bash command timeout in milliseconds. */
const BASH_TIMEOUT_MS = 120_000;
/** Maximum output buffer per bash call. */
const BASH_MAX_OUTPUT = 1024 * 1024; // 1 MB

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface SessionData {
  sessionId: string;
  messages: ChatCompletionMessageParam[];
  createdAt: string;
  updatedAt: string;
}

export interface CopilotQueryResult {
  result: string | null;
  newSessionId: string;
}

// ─── Session persistence ──────────────────────────────────────────────────────

function loadSession(sessionId: string): SessionData | null {
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SessionData;
  } catch {
    return null;
  }
}

function saveSession(session: SessionData): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updatedAt = new Date().toISOString();
  const p = path.join(SESSIONS_DIR, `${session.sessionId}.json`);
  // Atomic write via temp-then-rename
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, p);
}

/** Archive the full history to conversations/ then truncate. */
function archiveAndTruncate(
  session: SessionData,
  assistantName: string | undefined,
): void {
  try {
    const dir = '/workspace/group/conversations';
    fs.mkdirSync(dir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const timeStamp = new Date()
      .toTimeString()
      .slice(0, 5)
      .replace(':', '');
    const filename = `${date}-${timeStamp}-${session.sessionId.slice(0, 8)}.md`;
    const lines: string[] = ['# Conversation Archive', ''];
    lines.push(`Archived: ${new Date().toLocaleString()}`, '', '---', '');

    for (const msg of session.messages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const snippet =
          msg.content.length > 2000
            ? msg.content.slice(0, 2000) + '…'
            : msg.content;
        lines.push(`**User**: ${snippet}`, '');
      } else if (
        msg.role === 'assistant' &&
        typeof msg.content === 'string' &&
        msg.content
      ) {
        const snippet =
          msg.content.length > 2000
            ? msg.content.slice(0, 2000) + '…'
            : msg.content;
        lines.push(`**${assistantName || 'Assistant'}**: ${snippet}`, '');
      }
    }

    fs.writeFileSync(path.join(dir, filename), lines.join('\n'));
  } catch {
    /* best-effort archive */
  }

  session.messages = session.messages.slice(-RETAIN_AFTER_ARCHIVE);
}

// ─── Bash tool ────────────────────────────────────────────────────────────────

function executeBash(
  command: string,
  log: (msg: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    log(`bash: ${command.slice(0, 120)}`);
    exec(
      command,
      {
        cwd: '/workspace/group',
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: BASH_MAX_OUTPUT,
        env: { ...process.env, HOME: '/home/node' },
      },
      (error, stdout, stderr) => {
        const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
        if (error && error.code !== undefined) {
          resolve(`Exit code: ${error.code}\n${combined || '(no output)'}`);
        } else {
          resolve(combined || '(no output)');
        }
      },
    );
  });
}

const BUILTIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a bash command in the /workspace/group directory. ' +
        'Use for file operations (read, write, create, delete, list), ' +
        'running scripts, making HTTP requests (curl), git operations, ' +
        'installing packages, and any other shell tasks. ' +
        'Working directory is /workspace/group.',
      parameters: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
        },
        required: ['command'],
      },
    },
  },
];

// ─── MCP client ───────────────────────────────────────────────────────────────

async function setupMcpClient(
  mcpServerPath: string,
  containerInput: ContainerInput,
  log: (msg: string) => void,
): Promise<Client | null> {
  try {
    const client = new Client({ name: 'nanoclaw-agent', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [mcpServerPath],
      env: {
        ...process.env,
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    });
    await client.connect(transport);
    log('MCP client connected');
    return client;
  } catch (err) {
    log(
      `MCP client failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function mcpToolsToOpenAI(
  tools: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }[],
): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: `mcp__nanoclaw__${t.name}`,
      description: t.description || t.name,
      parameters: t.inputSchema,
    },
  }));
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  // Load per-group memory file (CLAUDE.md or generic ASSISTANT.md)
  for (const p of [
    '/workspace/group/CLAUDE.md',
    '/workspace/group/ASSISTANT.md',
  ]) {
    if (fs.existsSync(p)) {
      parts.push(fs.readFileSync(p, 'utf-8').trim());
    }
  }

  // Load global shared memory (non-main groups only, to avoid duplication)
  if (!input.isMain) {
    for (const p of [
      '/workspace/global/CLAUDE.md',
      '/workspace/global/ASSISTANT.md',
    ]) {
      if (fs.existsSync(p)) {
        parts.push(fs.readFileSync(p, 'utf-8').trim());
      }
    }
  }

  // Load any extra mounted directories' memory files
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      for (const memFile of ['CLAUDE.md', 'ASSISTANT.md']) {
        const p = path.join(extraBase, entry, memFile);
        if (fs.existsSync(p)) {
          parts.push(fs.readFileSync(p, 'utf-8').trim());
        }
      }
    }
  }

  const name = input.assistantName || 'Andy';
  parts.push(
    `You are ${name}, a helpful assistant integrated into a messaging platform.`,
    `Working directory: /workspace/group`,
    `Use the bash tool for all file operations, commands, and web requests.`,
    `Use NanoClaw MCP tools (mcp__nanoclaw__*) to send messages and manage scheduled tasks.`,
    `For long-running tasks, use mcp__nanoclaw__send_message for progress updates.`,
    `Wrap internal reasoning that should not be shown to the user in <internal>…</internal> tags.`,
  );

  if (input.isMain) {
    parts.push(
      `You are the main assistant. You have read-only access to the full project at /workspace/project.`,
    );
  }

  return parts.join('\n\n');
}

// ─── Main query function ──────────────────────────────────────────────────────

/**
 * Run a single Copilot query for the given prompt and return the final text
 * result plus the session ID (new or resumed).
 */
export async function runCopilotQuery(
  prompt: string,
  containerInput: ContainerInput,
  mcpServerPath: string,
  log: (msg: string) => void,
): Promise<CopilotQueryResult> {
  // ── OpenAI client (routes through credential proxy on ANTHROPIC_BASE_URL) ─
  // The existing container-runner injects ANTHROPIC_BASE_URL pointing to the
  // credential proxy, which transparently swaps in a real Copilot token.
  const openai = new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.githubcopilot.com',
    // The proxy replaces this placeholder with the real Copilot token
    apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder',
    defaultHeaders: {
      'Copilot-Integration-Id': 'vscode-chat',
      'editor-version': 'vscode/1.85.0',
      'editor-plugin-version': 'nanoclaw/1.0.0',
    },
  });

  // COPILOT_MODEL can be set via Dockerfile ENV or passed by the host
  const model = process.env.COPILOT_MODEL || 'gpt-4o';

  // ── MCP tools ─────────────────────────────────────────────────────────────
  const mcpClient = await setupMcpClient(mcpServerPath, containerInput, log);
  let mcpTools: ChatCompletionTool[] = [];
  if (mcpClient) {
    try {
      const { tools } = await mcpClient.listTools();
      mcpTools = mcpToolsToOpenAI(
        tools as {
          name: string;
          description?: string;
          inputSchema: Record<string, unknown>;
        }[],
      );
      log(`Loaded ${mcpTools.length} MCP tools`);
    } catch (err) {
      log(
        `MCP listTools failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const allTools: ChatCompletionTool[] = [...BUILTIN_TOOLS, ...mcpTools];

  // ── Session ───────────────────────────────────────────────────────────────
  const sessionId =
    containerInput.sessionId ?? crypto.randomUUID();
  let session = containerInput.sessionId
    ? loadSession(containerInput.sessionId)
    : null;

  if (!session) {
    session = {
      sessionId,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    log(`New session: ${sessionId}`);
  } else {
    log(`Resumed session: ${sessionId} (${session.messages.length} msgs)`);
  }

  // Add the incoming user message
  session.messages.push({ role: 'user', content: prompt });

  // Archive + truncate if the history is getting long
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    log(
      `Archiving session (${session.messages.length} messages → ${RETAIN_AFTER_ARCHIVE})`,
    );
    archiveAndTruncate(session, containerInput.assistantName);
  }

  const systemPrompt = buildSystemPrompt(containerInput);

  // ── Agentic loop ──────────────────────────────────────────────────────────
  let finalResult: string | null = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    log(`Iteration ${iter + 1}/${MAX_TOOL_ITERATIONS}`);

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...session.messages,
      ],
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: allTools.length > 0 ? 'auto' : undefined,
    });

    const choice = response.choices[0];
    if (!choice) {
      log('Empty response from Copilot API');
      break;
    }

    const assistantMsg = choice.message as ChatCompletionMessageParam;
    session.messages.push(assistantMsg);

    const toolCalls =
      choice.message.tool_calls && choice.message.tool_calls.length > 0
        ? choice.message.tool_calls
        : null;

    // Done — no more tool calls
    if (choice.finish_reason === 'stop' || !toolCalls) {
      finalResult = choice.message.content ?? '';
      log(`Done. Result length: ${finalResult.length}`);
      break;
    }

    // Execute tool calls
    log(`Executing ${toolCalls.length} tool call(s)`);
    for (const toolCall of toolCalls) {
      // Only function-type tool calls are supported
      if (toolCall.type !== 'function') continue;
      const name = toolCall.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<
          string,
          unknown
        >;
      } catch {
        /* malformed args — use empty object */
      }

      let result: string;
      try {
        if (name === 'bash') {
          result = await executeBash((args.command as string) || '', log);
        } else if (name.startsWith('mcp__nanoclaw__') && mcpClient) {
          const toolName = name.slice('mcp__nanoclaw__'.length);
          log(`MCP call: ${toolName}`);
          const mcpResult = await mcpClient.callTool({
            name: toolName,
            arguments: args,
          });
          result = (
            mcpResult.content as { type: string; text?: string }[]
          )
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('');
        } else {
          result = `Unknown tool: ${name}`;
        }
      } catch (err) {
        result = `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
      }

      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  if (finalResult === null) {
    log(`Reached max iterations (${MAX_TOOL_ITERATIONS})`);
    finalResult = 'Reached maximum tool iteration limit.';
  }

  saveSession(session);

  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch {
      /* best-effort cleanup */
    }
  }

  return { result: finalResult, newSessionId: session.sessionId };
}
