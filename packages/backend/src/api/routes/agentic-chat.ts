import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Claude Streaming Chat Handler with Agentic Tool Loop
 *
 * Implements full tool_use cycle:
 *   1. Send message to Claude with tools
 *   2. If Claude calls tools → execute them, send results back
 *   3. Repeat until Claude returns final text (stop_reason = end_turn)
 *   4. Stream final response to client via SSE
 */

import * as os from 'node:os';
import type { FastifyReply } from 'fastify';
import { ClaudeClient } from '../../llm/claude-client.js';
import { recordInteractiveUsage } from '../../llm/model-call.js';
import { createAgentToolsRegistry } from '../../tools/index.js';
import type { ChannelToolPolicy } from '../../tools/channel-policy.js';
import { loadClaudeProjectMemory } from './claude-local.js';
import { buildAiToolsContext } from './ai-tools.js';
import { uiSpecPrompt } from './json-render-prompt.js';
import { buildDynamicSystemPrompt, detectChatContext, type ChatContext } from './system-prompts.js';
import { chunkText, openSseStream } from '../../services/chat-sse.js';
import { safeErrorFields } from '../../services/safe-error-log.js';

/** UTF-8 text per final-answer frame: a 256 KiB answer needs about 64 frames. */
export const ANSWER_FRAME_BYTES = 4 * 1024;

// ─── OS detection (runs once at module load) ──────────────────────────────────

function buildOsContext(): string {
  const platform = process.platform;
  const arch     = process.arch;
  const release  = os.release();

  if (platform === 'win32') {
    const ver = release.startsWith('10.0') ? 'Windows 10/11' : `Windows (${release})`;
    return (
      `## System Information\n` +
      `OS: ${ver} (win32, ${arch})\n` +
      `Shell: PowerShell\n` +
      `Key modifier: Ctrl (not Cmd)\n` +
      `App launcher: Start-Process "AppName" in PowerShell\n` +
      `Home directory: C:\\Users\\<username>\\\n` +
      `Path separator: \\\n`
    );
  }

  if (platform === 'darwin') {
    return (
      `## System Information\n` +
      `OS: macOS (darwin, ${arch})\n` +
      `Shell: bash / zsh\n` +
      `Key modifier: Cmd (⌘) — use "command" in pyautogui hotkeys\n` +
      `App launcher: open -a "AppName"\n` +
      `Home directory: /Users/<username>/\n` +
      `Path separator: /\n`
    );
  }

  const distro = (() => {
    try {
      const { execSync } = require('node:child_process');
      return execSync('lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2', { timeout: 1000 }).toString().trim().replace(/"/g, '');
    } catch { return 'Linux'; }
  })();

  return (
    `## System Information\n` +
    `OS: ${distro} (linux, ${arch})\n` +
    `Shell: bash\n` +
    `Key modifier: Ctrl\n` +
    `App launcher: use the app binary name directly, or xdg-open for files\n` +
    `Home directory: /home/<username>/\n` +
    `Path separator: /\n`
  );
}

const OS_CONTEXT = buildOsContext();

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[];
}

/**
 * Stream chat using Claude API with full agentic tool loop
 */
export async function streamChatClaude(
  reply: FastifyReply,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  systemPrompt: string | undefined,
  tools: any[],
  temperature: number,
  userId: string = 'default',
  sessionId: string = 'default',
  chatContext?: Partial<ChatContext>,
  toolPolicy?: ChannelToolPolicy,
  agentId?: string,
  maxTokens?: number,
  memoryDrawers?: import('../../memory/drawers.js').DrawerRef[],
  fileReadRoot?: string,
  uiSet: 'full' | 'chat' = 'full'
): Promise<FastifyReply> {
  console.log('[Chat] 🚀 Starting Claude agentic stream');
  const startedAt = Date.now();
  safeConsole.log('[Chat]   Model:', model);
  console.log('[Chat]   Messages:', messages.length);
  console.log('[Chat]   Tools offered:', tools.length);

  // SSE headers + heartbeat (a no-op when the route already opened the
  // stream). The heartbeat covers tool steps and rate-limit waits (CHAT-01).
  openSseStream(reply.raw);
  // CHAT-01: when the client closes the connection before the reply ended,
  // the turn is aborted: no further model calls or tool steps run.
  let clientGone = false;
  reply.raw.once?.('close', () => { if (!reply.raw.writableEnded) clientGone = true; });

  try {
    const claude = new ClaudeClient(apiKey, model);

    // Build tools registry for execution
    // Same tool policy and agent grants as the offered list: a turn cannot run a tool it was not offered.
    const toolsRegistry = await createAgentToolsRegistry({ userId, sessionId, workspaceDir: process.cwd(), toolPolicy, agentId, memoryDrawers, chatPlan: !toolPolicy, ...(fileReadRoot ? { fileReadRoot } : {}) });

    // Convert messages to Claude format (filter out system role)
    let loopMessages: Array<{ role: 'user' | 'assistant'; content: string | any[] }> = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // For desktop/browser tasks allow many more steps
    const MAX_ITERATIONS = 25;
    let iteration = 0;
    let finalContent = '';
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 4;

    // Load project MEMORY.md and AI tools context. Not for channel turns: that is the
    // owner's private local context and the reply goes to an outside sender (S0-Q.8).
    const [projectMemory, aiToolsContext]: [string | null, string] = toolPolicy
      ? [null, '']
      : await Promise.all([
          loadClaudeProjectMemory(),
          buildAiToolsContext(),
        ]);

    // Detect chat context (auto-detect or use explicit context from caller)
    const context = detectChatContext(
      messages.map(m => ({ role: m.role, content: m.content })),
      tools,
      chatContext
    );

    console.log('[Chat] 🎯 Context detected:', {
      sessionType: context.sessionType,
      hasAvatarViewer: context.hasAvatarViewer,
      isInteractiveMode: context.isInteractiveMode,
      hasDesktopControl: context.hasDesktopControl,
    });

    // Build base prompt with project memory
    const basePrompt = [
      projectMemory ? `# Project Memory\n\n${projectMemory}` : '',
      systemPrompt || '',
    ].filter(Boolean).join('\n\n---\n\n');

    // Build dynamic system prompt based on context
    const agenticSystemPrompt = buildDynamicSystemPrompt(
      basePrompt,
      OS_CONTEXT,
      context,
      true,  // includeJsonRender
      tools.length > 0,  // includeAiTools
      aiToolsContext,
      uiSpecPrompt(uiSet)
    );

    // Strip image data from older tool_result messages to control token usage.
    // Only the most recent N screenshots are kept; older ones become text placeholders.
    const MAX_IMAGES_IN_CONTEXT = 2;
    function pruneOldImages(msgs: typeof loopMessages): typeof loopMessages {
      let imageCount = 0;
      // Count images from newest to oldest
      const imageCounts: boolean[] = msgs.map(() => false);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result' && Array.isArray(block.content)) {
              for (const inner of block.content) {
                if (inner.type === 'image') {
                  imageCount++;
                  if (imageCount <= MAX_IMAGES_IN_CONTEXT) {
                    imageCounts[i] = true; // keep this message's images
                  }
                }
              }
            }
          }
        }
      }

      return msgs.map((msg, i) => {
        if (msg.role !== 'user' || !Array.isArray(msg.content) || imageCounts[i]) return msg;
        // Strip images from this message — replace with text placeholder
        const stripped = (msg.content as any[]).map((block: any) => {
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            return {
              ...block,
              content: block.content.map((inner: any) =>
                inner.type === 'image'
                  ? { type: 'text', text: '[Screenshot from earlier step — removed to save context]' }
                  : inner
              ),
            };
          }
          return block;
        });
        return { ...msg, content: stripped };
      });
    }

    // Call Claude with automatic retry on rate limit errors
    async function callWithRetry(msgs: any[], attempt = 0): Promise<any> {
      try {
        const r = await claude.sendMessage(msgs, {
          systemPrompt: agenticSystemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          temperature,
          maxTokens: maxTokens ?? 4096,
        });
        // R2.2: interactive owner chat is not gated; its paid usage is recorded for GET /api/budget.
        await recordInteractiveUsage({ provider: 'claude', model, usage: r.usage, outputText: r.content, purpose: 'interactive_chat' });
        return r;
      } catch (err: any) {
        const isRateLimit = err.message?.includes('rate_limit_error') || err.message?.includes('rate limit');
        if (isRateLimit && attempt < 3) {
          const waitSec = (attempt + 1) * 30; // 30s, 60s, 90s
          console.log(`[Chat] ⏳ Rate limit — waiting ${waitSec}s before retry ${attempt + 1}/3`);
          reply.raw.write(`data: ${JSON.stringify({
            type: 'text',
            content: `\n\n*Rate limit reached — waiting ${waitSec}s before continuing...*\n\n`,
          })}\n\n`);
          await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
          if (clientGone) throw new Error('client closed');
          return callWithRetry(msgs, attempt + 1);
        }
        throw err;
      }
    }

    // === AGENTIC LOOP ===
    while (iteration < MAX_ITERATIONS) {
      if (clientGone) break;
      iteration++;
      console.log(`[Chat] 🔄 Agentic loop iteration ${iteration}/${MAX_ITERATIONS}`);

      const response = await callWithRetry(pruneOldImages(loopMessages) as any);

      console.log(`[Chat]   Stop reason: ${response.stopReason}`);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        finalContent = response.content;
        console.log(`[Chat] ✅ Final response after ${iteration} iterations (${finalContent.length} chars)`);
        break;
      }

      if (clientGone) break;

      // Reset consecutive error counter when Claude makes tool calls
      consecutiveErrors = 0;

      // Claude wants to use tools
      console.log(`[Chat] 🔧 Claude requested ${response.toolCalls.length} tool(s):`);
      response.toolCalls.forEach((tc: any) =>
        console.log(`[Chat]     • ${tc.tool}(${JSON.stringify(tc.arguments).slice(0, 80)})`)
      );

      // Notify client — structured tool_start event
      reply.raw.write(`data: ${JSON.stringify({
        type: 'tool_start',
        step: iteration,
        tools: response.toolCalls.map((tc: any) => ({
          name: tc.tool,
          input: JSON.stringify(tc.arguments).slice(0, 300),
        })),
      })}\n\n`);

      // Add assistant message (with tool_use blocks) to conversation
      loopMessages.push({
        role: 'assistant',
        content: response.rawBlocks || response.content,
      });

      // Execute all tools IN PARALLEL and collect results (order preserved by Promise.all)
      const toolResults = await Promise.all(
        response.toolCalls.map(async (toolCall: any) => {
          console.log(`[Chat] ⚙️  Executing (parallel): ${toolCall.tool}`);
          try {
            const result = await toolsRegistry.execute(toolCall.tool, toolCall.arguments);

            let resultContent: any[];
            if (result.content) {
              resultContent = result.content.map((block: any) => {
                if (block.type === 'image' && block.source) {
                  // Normalize media_type: desktop.py now saves as JPEG
                  const mediaType = (block.source.media_type === 'image/jpeg' || block.source.data?.length)
                    ? 'image/jpeg'
                    : block.source.media_type;
                  return { ...block, source: { ...block.source, media_type: mediaType } };
                }
                return { type: 'text', text: block.text || JSON.stringify(block) };
              });
            } else {
              resultContent = [{ type: 'text', text: JSON.stringify(result) }];
            }

            console.log(`[Chat] ✅ Tool result: ${resultContent[0]?.text?.slice(0, 100) || '(image)'}`);
            return { type: 'tool_result', tool_use_id: toolCall.id, content: resultContent };
          } catch (err: any) {
            console.error(`[Chat] ❌ Tool error for ${toolCall.tool}:`, err.message);
            return {
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: [{ type: 'text', text: `Error: ${err.message}. Try a different approach.` }],
              is_error: true,
            };
          }
        })
      );
      // Notify client — structured tool_result event
      reply.raw.write(`data: ${JSON.stringify({
        type: 'tool_result',
        step: iteration,
        results: toolResults.map((r: any, idx: number) => ({
          name: response.toolCalls[idx]?.tool ?? '',
          output: (r.content?.find((b: any) => b.type === 'text')?.text ?? '').slice(0, 500),
          isError: r.is_error === true,
        })),
      })}\n\n`);

      const stepHadError = toolResults.some((r: any) => r.is_error === true);

      if (stepHadError) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          finalContent = `Task stopped after ${consecutiveErrors} consecutive errors. Last error prevented the tool from running. Please check if the required application is installed.`;
          break;
        }
      }

      // Add tool results as user message and continue loop
      loopMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    if (!finalContent && iteration >= MAX_ITERATIONS) {
      finalContent = `I completed ${MAX_ITERATIONS} steps on this task. The task may need more steps — please tell me to continue if needed.`;
    }

    // Auto-cleanup: always hide the desktop indicator when the task ends
    // (in case Claude forgot to call hide_indicator before giving its final reply)
    try {
      await toolsRegistry.execute('desktop_control', { action: 'hide_indicator' });
    } catch {
      // Silently ignore — indicator may already be hidden or desktop_control unavailable
    }

    if (clientGone) {
      console.log('[Chat] Client closed the connection; turn aborted');
      reply.raw.end();
      return reply;
    }

    // Stream final content to client in bounded chunks (never splits an emoji)
    for (const chunk of chunkText(finalContent, ANSWER_FRAME_BYTES)) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
    }

    reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    console.log('[Chat] ✅ Agentic stream completed');

  } catch (error: any) {
    // SECURITY: Don't expose error details in SSE stream (H-09)
    // FU-01: safe fields only; provider errors can echo the request or a key.
    console.error('[Chat] ❌ Claude error', safeErrorFields(error, startedAt));
    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'error',
        error: 'Chat request failed',
      })}\n\n`
    );
  }

  reply.raw.end();
  return reply;
}
