/**
 * Settings Types
 */

import { defaultOllamaUrl } from '../config/ollama-url.js';

export interface AgentSettings {
  // AI Provider
  provider: 'local' | 'claude' | 'openai';

  // Local (Ollama)
  local?: {
    url: string;
    model: string;
  };

  // Claude API
  claude?: {
    apiKey: string;
    model: 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | 'claude-haiku-4-5-20251001';
    maxTokens?: number;
  };

  // OpenAI API
  openai?: {
    apiKey: string;
    model: string;
    maxTokens?: number;
  };

  // General
  temperature?: number;
  enableTools?: boolean;
  enableSkills?: boolean;

  // Public rooms (Q-14, CL-07): anonymous visitors may read/post only when on.
  publicRooms?: {
    allowAnonymous: boolean;
  };
}

export const DEFAULT_SETTINGS: AgentSettings = {
  provider: 'local',
  local: {
    // F4: follows OLLAMA_URL / LOCAL_MODEL_API_URL (default http://127.0.0.1:11434).
    url: defaultOllamaUrl(),
    model: 'qwen3.5:9b',
  },
  temperature: 0.7,
  enableTools: true,
  enableSkills: true,
};
