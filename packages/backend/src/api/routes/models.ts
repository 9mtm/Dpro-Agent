import {subscriptionEnabled,subscriptionBinary} from '../../services/subscription-chat.js';
/**
 * Models API Routes
 * Lists available AI models from all providers
 */

import type { FastifyInstance } from 'fastify';
import { getSettingsManager } from '../../settings/index.js';

import { OLLAMA_URL } from '../../llm/ollama.js';
import { LMSTUDIO_PREFIX, listLmStudioModels } from '../../llm/lmstudio.js';
import { getEnvProviderApiKey, hasGlobalProviderApiKey } from '../../credentials/authority.js';

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export async function modelsRoutes(fastify: FastifyInstance) {
  // GET /api/models - List ALL available models from ALL providers
  fastify.get('/api/models', async (request, reply) => {
    try {
      const settingsManager = getSettingsManager();
      const settings = await settingsManager.getSettings();

      const allModels: any[] = [];
      if(subscriptionEnabled())for(const kind of ['claude','codex'] as const)if(await subscriptionBinary(kind))allModels.push({id:'subscription:'+kind,provider:'subscription',label:kind==='claude'?'Claude Code · existing account':'Codex · existing ChatGPT account',size:''});

      // 1. Add Ollama models (if available)
      try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`, {
          signal: AbortSignal.timeout(2000),
        });

        if (response.ok) {
          const data = await response.json() as { models: OllamaModel[] };
          const ollamaModels = data.models.map((m) => ({
            id: m.name,
            name: `🏠 ${m.name}`,
            provider: 'local',
            size: formatSize(m.size),
            modifiedAt: m.modified_at,
            details: m.details,
            available: true,
          }));
          allModels.push(...ollamaModels);
        }
      } catch (error) {
        console.log('[Models] Ollama not available');
      }

      // 1b. LM Studio models on this computer (CHAT-PRO-02 G): listed only
      // while its local server answers; ids carry the `lmstudio:` prefix.
      const lmStudio = await listLmStudioModels();
      allModels.push(...lmStudio.models.map((id) => ({
        id: `${LMSTUDIO_PREFIX}${id}`,
        name: id,
        provider: 'lmstudio',
        size: '',
        available: true,
      })));

      // 2. Add Claude models (if API key configured)
      if (await hasGlobalProviderApiKey('claude')) {
        const claudeModels = [
          {
            id: 'claude-opus-4-6',
            name: '🧠 Claude Opus 4.6',
            provider: 'claude',
            description: 'Most powerful, best for complex tasks',
            size: 'API',
            available: true,
          },
          {
            id: 'claude-sonnet-4-5-20250929',
            name: '🧠 Claude Sonnet 4.5',
            provider: 'claude',
            description: 'Balanced performance and speed',
            size: 'API',
            available: true,
          },
          {
            id: 'claude-haiku-4-5-20251001',
            name: '🧠 Claude Haiku 4.5',
            provider: 'claude',
            description: 'Fastest, great for simple tasks',
            size: 'API',
            available: true,
          },
        ];
        allModels.push(...claudeModels);
      }

      // 3. Add OpenAI models (if API key configured)
      if (await hasGlobalProviderApiKey('openai')) {
        const openaiModels = [
          {
            id: 'gpt-4-turbo',
            name: '🤖 GPT-4 Turbo',
            provider: 'openai',
            description: 'Most capable OpenAI model',
            size: 'API',
            available: true,
          },
          {
            id: 'gpt-4',
            name: '🤖 GPT-4',
            provider: 'openai',
            description: 'Standard GPT-4 model',
            size: 'API',
            available: true,
          },
          {
            id: 'gpt-3.5-turbo',
            name: '🤖 GPT-3.5 Turbo',
            provider: 'openai',
            description: 'Fast and efficient',
            size: 'API',
            available: true,
          },
        ];
        allModels.push(...openaiModels);
      }

      // Return all models with active provider info
      return {
        models: allModels,
        activeProvider: settings.provider,
        defaultModel: settings[settings.provider]?.model || allModels[0]?.id,
      };
    } catch (error) {
      console.error('[Models] Error loading models:', error);
      return reply.status(500).send({
        error: 'Failed to load models',
        message: 'Check your configuration'
      });
    }
  });

  // GET /api/models/providers - List available providers
  fastify.get('/api/models/providers', async () => {
    const providers = [
      { name: 'ollama', available: await checkOllama() },
      { name: 'lmstudio', available: (await listLmStudioModels()).running },
      { name: 'openai', available: !!getEnvProviderApiKey('openai') },
      { name: 'anthropic', available: !!getEnvProviderApiKey('claude') },
    ];
    return { providers };
  });
}

// Helper: Format file size
function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

// Helper: Check if Ollama is running
async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}
