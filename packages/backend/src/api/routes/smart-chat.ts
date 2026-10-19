import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Smart Chat API - Uses Agent System
 * Enhanced chat with intelligent prompt building, skill selection, and learning
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { AgentRuntime, type Message, type Skill } from '../../agent/index.js';
import { handleError } from '../error-handler.js';

import { OLLAMA_URL, DEFAULT_OLLAMA_MODEL } from '../../llm/ollama.js';

const DEFAULT_MODEL = DEFAULT_OLLAMA_MODEL;

interface SmartChatRequest {
  message: string;
  sessionId: string;
  history?: Message[];
  stream?: boolean;
  userPreferences?: {
    language?: 'en' | 'ar' | 'auto';
    tone?: 'friendly' | 'professional' | 'concise' | 'detailed';
    responseLength?: 'short' | 'medium' | 'long';
    codeExamples?: boolean;
  };
}

// Mock skills for now (will be loaded from registry later)
const mockSkills: Skill[] = [
  {
    id: 'weather',
    name: 'Weather',
    description: 'Get weather forecasts and current conditions for any location',
    location: '/skills/weather.md',
    category: 'utilities',
    tags: ['weather', 'temperature', 'forecast', 'climate', 'الطقس'],
    triggers: ['weather', 'temperature', 'forecast', 'الطقس'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage GitHub repositories, pull requests, and issues',
    location: '/skills/github.md',
    category: 'development',
    tags: ['github', 'repository', 'pr', 'issue', 'git', 'جيتهاب'],
    triggers: ['github', 'repository', 'pull request', 'جيتهاب'],
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for information using various search engines',
    location: '/skills/web-search.md',
    category: 'utilities',
    tags: ['search', 'web', 'google', 'find', 'بحث', 'جوجل'],
    triggers: ['search', 'find online', 'look up', 'ابحث'],
  },
  {
    id: 'calculator',
    name: 'Calculator',
    description: 'Perform mathematical calculations and solve equations',
    location: '/skills/calculator.md',
    category: 'utilities',
    tags: ['calculate', 'math', 'compute', 'sum', 'حساب', 'احسب'],
    triggers: ['calculate', 'compute', 'math', 'احسب'],
  },
  {
    id: 'note-taking',
    name: 'Note Taking',
    description: 'Create, manage, and organize notes',
    location: '/skills/note-taking.md',
    category: 'productivity',
    tags: ['note', 'remember', 'save', 'write', 'ملاحظة', 'تذكر'],
    triggers: ['note', 'remember', 'write down', 'ملاحظة'],
  },
];

// Initialize agent runtime
const agent = new AgentRuntime({
  skills: {
    maxSelected: 5,
    confidenceThreshold: 0.5,
    enableLearning: true,
  },
  learning: {
    enabled: true,
    feedbackWeight: 0.8,
    minInteractionsForUpdate: 1,
  },
});

// Load skills
agent.loadSkills(mockSkills);

export async function smartChatRoutes(fastify: FastifyInstance) {
  // POST /api/chat/smart - Smart chat with agent system
  fastify.post<{ Body: SmartChatRequest }>(
    '/api/chat/smart',
    async (request, reply) => {
      const { message, sessionId, history = [], stream = true, userPreferences } = request.body;

      if (!message || !sessionId) {
        return reply.status(400).send({
          error: 'message and sessionId are required',
        });
      }

      console.log('[SmartChat] 🧠 Processing with Agent System');
      safeConsole.log('[SmartChat]   Message:', message.slice(0, 50) + '...');
      safeConsole.log('[SmartChat]   Session:', sessionId);
      safeConsole.log('[SmartChat]   History:', history.length, 'messages');

      try {
        // Clean userPreferences to match expected type
        const cleanPreferences = userPreferences ? {
          language: userPreferences.language || 'auto',
          tone: userPreferences.tone || 'friendly',
          responseLength: userPreferences.responseLength || 'medium',
          codeExamples: userPreferences.codeExamples ?? false,
        } as const : undefined;

        // Process with agent system
        const agentResponse = await agent.process({
          message,
          sessionId,
          history,
          context: {
            userPreferences: cleanPreferences,
          },
        });

        console.log('[SmartChat] ✅ Agent analysis complete');
        console.log('[SmartChat]   Intent:', agentResponse.analysis.intent);
        console.log('[SmartChat]   Language:', agentResponse.analysis.language);
        console.log('[SmartChat]   Complexity:', agentResponse.analysis.complexity);
        console.log('[SmartChat]   Tokens:', agentResponse.systemPrompt.metadata.tokenCount);
        console.log('[SmartChat]   Skills suggested:', agentResponse.analysis.requiresSkills);

        if (stream) {
          return streamSmartChat(
            reply,
            agentResponse.systemPrompt.full,
            message,
            history,
            agentResponse
          );
        } else {
          return {
            content: agentResponse.content,
            analysis: agentResponse.analysis,
            metrics: agentResponse.metrics,
            systemPrompt: {
              tokenCount: agentResponse.systemPrompt.metadata.tokenCount,
              layersIncluded: agentResponse.systemPrompt.metadata.layersIncluded,
            },
          };
        }
      } catch (error: any) {
        console.error('[SmartChat] ❌ Error:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[SmartChat] Process failed');
      }
    }
  );

  // POST /api/chat/smart/feedback - Record learning feedback
  fastify.post<{
    Body: {
      interactionId: string;
      skillUsed?: string;
      success: boolean;
      userFeedback?: 'positive' | 'negative' | 'neutral';
    };
  }>('/api/chat/smart/feedback', async (request, reply) => {
    const { interactionId, skillUsed, success, userFeedback } = request.body;

    if (!interactionId) {
      return reply.status(400).send({ error: 'interactionId is required' });
    }

    try {
      await agent.recordFeedback({
        interactionId,
        skillUsed,
        success,
        userFeedback,
      });

      console.log('[SmartChat] 📚 Feedback recorded');
      safeConsole.log('[SmartChat]   Skill:', skillUsed);
      safeConsole.log('[SmartChat]   Success:', success);
      safeConsole.log('[SmartChat]   User feedback:', userFeedback);

      return { success: true };
    } catch (error: any) {
      console.error('[SmartChat] ❌ Feedback error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[SmartChat] Record feedback failed');
    }
  });

  // GET /api/chat/smart/stats - Get learning statistics
  fastify.get('/api/chat/smart/stats', async (request, reply) => {
    try {
      const stats = agent.getLearningStats();
      return stats;
    } catch (error: any) {
      console.error('[SmartChat] ❌ Stats error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[SmartChat] Get stats failed');
    }
  });

  // GET /api/chat/smart/health - Agent health check
  fastify.get('/api/chat/smart/health', async (request, reply) => {
    try {
      const health = await agent.healthCheck();
      return health;
    } catch (error: any) {
      console.error('[SmartChat] ❌ Health check error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[SmartChat] Health check failed');
    }
  });
}

// Stream response with agent's smart system prompt
async function streamSmartChat(
  reply: FastifyReply,
  systemPrompt: string,
  userMessage: string,
  history: Message[],
  agentResponse: any
) {
  console.log('[SmartChat] 🚀 Starting stream with smart prompt');
  console.log('[SmartChat]   System prompt tokens:', agentResponse.systemPrompt.metadata.tokenCount);

  // Build messages for LLM
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history,
    { role: 'user' as const, content: userMessage },
  ];

  // Call Ollama
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
      stream: true,
      options: {
        temperature: 0.7,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[SmartChat] ❌ Ollama error:', error);
    return reply.status(502).send({
      error: 'Ollama error',
      message: error,
    });
  }

  console.log('[SmartChat] ✅ Ollama connected, streaming...');

  // Set up SSE headers
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
  });

  // Send initial metadata
  reply.raw.write(
    `data: ${JSON.stringify({
      type: 'metadata',
      analysis: {
        intent: agentResponse.analysis.intent,
        language: agentResponse.analysis.language,
        complexity: agentResponse.analysis.complexity,
        requiresSkills: agentResponse.analysis.requiresSkills,
      },
      metrics: {
        tokenCount: agentResponse.systemPrompt.metadata.tokenCount,
        layersIncluded: agentResponse.systemPrompt.metadata.layersIncluded,
        promptBuildTime: agentResponse.metrics.promptBuildTime,
      },
      done: false,
    })}\n\n`
  );

  const reader = response.body?.getReader();
  if (!reader) {
    console.error('[SmartChat] ❌ No reader available');
    reply.raw.end();
    return reply;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let totalContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          processLine(buffer);
        }
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        processLine(line);
      }
    }
  } catch (error) {
    console.error('[SmartChat] ❌ Stream error:', error);
  }

  console.log('[SmartChat] ✅ Stream completed');
  console.log('[SmartChat]   Total chunks:', chunkCount);
  console.log('[SmartChat]   Response length:', totalContent.length, 'chars');

  reply.raw.end();
  return reply;

  function processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const json = JSON.parse(trimmed);

      // Send content chunk
      if (json.message?.content) {
        chunkCount++;
        totalContent += json.message.content;
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'content',
            content: json.message.content,
            done: false,
          })}\n\n`
        );

        if (chunkCount === 1) {
          console.log('[SmartChat] 📡 First chunk:', json.message.content.slice(0, 30));
        }
      }

      // Send done signal
      if (json.done) {
        console.log('[SmartChat] 📡 Done signal received');
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'done',
            content: '',
            done: true,
            totalChunks: chunkCount,
            totalLength: totalContent.length,
          })}\n\n`
        );
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }
}
