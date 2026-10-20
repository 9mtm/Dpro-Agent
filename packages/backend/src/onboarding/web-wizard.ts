/**
 * Web onboarding wizard (F-05): per-user state + per-step validation.
 *
 * `/onboarding` is shown after the first owner login. This module is separate
 * from the terminal wizard in `./wizard.ts` (which must not be reachable over
 * HTTP, S0-Q.14).
 *
 * Rules:
 * - State is stored per user in `onboarding_state` (migration 050).
 * - Saved answers never contain secrets. A provider API key goes to the
 *   settings manager (encrypted at rest) and is only ever returned masked.
 * - Channels are only saved as a preference, never started.
 * - Skills are only saved as a preference, never installed.
 *
 * B2.2c: the state runs on the process driver (sql-steps). A save or a
 * completion reads, merges and writes the row in one transaction under a
 * per-user lock, so two concurrent saves never lose each other's answers.
 */

import { lockName, one, q, run, sql, type Step } from '../repositories/sql-steps.js';
import { trimTrailingSlashes } from '../auth/setup-input.js';
import { getSettingsManager } from '../settings/index.js';
import { DEFAULT_SETTINGS } from '../settings/types.js';
import type { AgentSettings } from '../settings/types.js';
import { isMaskedSecret, maskSecret } from '../credentials/secret-mask.js';
import { getGlobalProviderApiKey } from '../credentials/authority.js';

export const TOTAL_STEPS = 6;

export const STEP_IDS = ['profile', 'provider', 'channels', 'skills'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** D-LANG: the 12 UI languages. */
export const LANGUAGES = ['en', 'ar', 'de', 'fr', 'es', 'zh', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'hi'] as const;

export const PROVIDERS = ['ollama', 'anthropic', 'openai'] as const;
export type WizardProvider = (typeof PROVIDERS)[number];

export const CHANNELS = ['web', 'whatsapp', 'telegram', 'discord'] as const;

/** M-03: local default provider. */
export const DEFAULT_OLLAMA_URL = DEFAULT_SETTINGS.local!.url; // F4: OLLAMA_URL, else http://127.0.0.1:11434
export const DEFAULT_OLLAMA_MODEL = DEFAULT_SETTINGS.local!.model; // qwen3.5:9b

const CLAUDE_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'] as const;
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_OPENAI_MODEL = 'gpt-4';

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SKILLS = 50;

export interface WizardAnswers {
  userName?: string;
  language?: string;
  aiProvider?: WizardProvider;
  aiModel?: string;
  ollamaUrl?: string;
  selectedChannels?: string[];
  selectedSkills?: string[];
}

export interface WizardState {
  completed: boolean;
  skipped: boolean;
  currentStep: number;
  totalSteps: number;
  data: WizardAnswers & { apiKeySet?: boolean; apiKeyMasked?: string };
}

/** Thrown for invalid client input; the message is safe to return (never echoes a secret). */
export class WizardInputError extends Error {}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new WizardInputError(`Unknown field "${k.slice(0, 40)}" in ${where}`);
  }
}

/** Only http(s) URLs on the loopback interface (services bind to 127.0.0.1). */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (url.search || url.hash) return false;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function stringIdList(v: unknown, field: string, check: (s: string) => boolean, max: number): string[] {
  if (!Array.isArray(v)) throw new WizardInputError(`${field} must be a list`);
  if (v.length > max) throw new WizardInputError(`${field} has too many entries`);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || !check(item)) throw new WizardInputError(`${field} contains an invalid entry`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export interface ProviderInput {
  aiProvider: WizardProvider;
  aiModel: string;
  ollamaUrl?: string;
  /** New key to store, or undefined to keep the stored one. Never persisted in answers. */
  apiKey?: string;
}

export type ValidatedStep =
  | { step: 'profile'; answers: { userName: string; language: string } }
  | { step: 'provider'; answers: Omit<ProviderInput, 'apiKey'>; apiKey?: string }
  | { step: 'channels'; answers: { selectedChannels: string[] } }
  | { step: 'skills'; answers: { selectedSkills: string[] } };

/** Validate one step's input. Throws WizardInputError. */
export function validateStep(step: unknown, data: unknown): ValidatedStep {
  if (typeof step !== 'string' || !(STEP_IDS as readonly string[]).includes(step)) {
    throw new WizardInputError('Unknown step');
  }
  if (!isPlainObject(data)) throw new WizardInputError('data must be an object');

  switch (step as StepId) {
    case 'profile': {
      onlyKeys(data, ['userName', 'language'], 'profile');
      const { userName, language } = data;
      if (typeof userName !== 'string') throw new WizardInputError('userName is required');
      const name = userName.trim();
      if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new WizardInputError('userName must be 1-100 characters without control characters');
      }
      const lang = language === undefined ? 'en' : language;
      if (typeof lang !== 'string' || !(LANGUAGES as readonly string[]).includes(lang)) {
        throw new WizardInputError('Unsupported language');
      }
      return { step: 'profile', answers: { userName: name, language: lang } };
    }

    case 'provider': {
      onlyKeys(data, ['aiProvider', 'aiModel', 'ollamaUrl', 'apiKey'], 'provider');
      const { aiProvider, aiModel, ollamaUrl, apiKey } = data;
      if (typeof aiProvider !== 'string' || !(PROVIDERS as readonly string[]).includes(aiProvider)) {
        throw new WizardInputError('Unsupported AI provider');
      }
      const provider = aiProvider as WizardProvider;
      const defaultModel =
        provider === 'ollama' ? DEFAULT_OLLAMA_MODEL : provider === 'anthropic' ? DEFAULT_CLAUDE_MODEL : DEFAULT_OPENAI_MODEL;
      const model = aiModel === undefined || aiModel === '' ? defaultModel : aiModel;
      if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) throw new WizardInputError('Invalid model name');
      if (provider === 'anthropic' && !(CLAUDE_MODELS as readonly string[]).includes(model)) {
        throw new WizardInputError('Unsupported Claude model');
      }

      let url: string | undefined;
      if (provider === 'ollama') {
        url = ollamaUrl === undefined || ollamaUrl === '' ? DEFAULT_OLLAMA_URL : (ollamaUrl as string);
        if (typeof url !== 'string' || url.length > 2048 || !isLoopbackUrl(url)) {
          throw new WizardInputError('Ollama URL must be a local address (127.0.0.1)');
        }
        url = trimTrailingSlashes(url);
      } else if (ollamaUrl !== undefined && ollamaUrl !== '') {
        throw new WizardInputError('ollamaUrl is only valid for the Ollama provider');
      }

      let key: string | undefined;
      if (apiKey !== undefined && apiKey !== '') {
        if (provider === 'ollama') throw new WizardInputError('Ollama does not use an API key');
        if (typeof apiKey !== 'string') throw new WizardInputError('Invalid API key');
        if (!isMaskedSecret(apiKey)) {
          if (apiKey.length < 8 || apiKey.length > 500 || /\s/.test(apiKey)) {
            throw new WizardInputError('Invalid API key format');
          }
          key = apiKey;
        }
      }

      const answers: Omit<ProviderInput, 'apiKey'> = { aiProvider: provider, aiModel: model };
      if (url) answers.ollamaUrl = url;
      return { step: 'provider', answers, apiKey: key };
    }

    case 'channels': {
      onlyKeys(data, ['selectedChannels'], 'channels');
      const list = stringIdList(
        data.selectedChannels,
        'selectedChannels',
        s => (CHANNELS as readonly string[]).includes(s),
        CHANNELS.length
      );
      return { step: 'channels', answers: { selectedChannels: list } };
    }

    case 'skills': {
      onlyKeys(data, ['selectedSkills'], 'skills');
      const list = stringIdList(data.selectedSkills, 'selectedSkills', s => SKILL_ID_PATTERN.test(s), MAX_SKILLS);
      return { step: 'skills', answers: { selectedSkills: list } };
    }
  }
}

export function validateCurrentStep(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > TOTAL_STEPS) {
    throw new WizardInputError(`currentStep must be an integer 1-${TOTAL_STEPS}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface Row {
  current_step: number;
  answers: string;
  completed: number;
  skipped: number;
}

function readRowStep(userId: string): Step<Row | undefined> {
  return one<Row>('SELECT current_step, answers, completed, skipped FROM onboarding_state WHERE user_id = ?', userId);
}

function readRow(userId: string): Promise<Row | undefined> {
  return sql().read(readRowStep(userId));
}

/** Read-modify-write of one user's row: one transaction under the user's lock. */
function updateRow(userId: string, fn: (row: Row | undefined) => Step<void>): Promise<void> {
  return sql().tx(function* () {
    yield* lockName(`onboarding_state:${userId}`);
    const row = yield* readRowStep(userId);
    yield* fn(row);
  });
}

function parseAnswers(raw: string | undefined): WizardAnswers {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return isPlainObject(v) ? (v as WizardAnswers) : {};
  } catch {
    return {};
  }
}

function* writeRow(userId: string, row: Row, completedAt: 'now' | 'null' | 'keep'): Step<void> {
  const completedSql =
    completedAt === 'now' ? 'CURRENT_TIMESTAMP' : completedAt === 'null' ? 'NULL' : 'onboarding_state.completed_at';
  yield* run(
      `INSERT INTO onboarding_state (user_id, current_step, answers, completed, skipped, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ${completedAt === 'now' ? 'CURRENT_TIMESTAMP' : 'NULL'}, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         current_step = excluded.current_step,
         answers = excluded.answers,
         completed = excluded.completed,
         skipped = excluded.skipped,
         completed_at = ${completedSql},
         updated_at = CURRENT_TIMESTAMP`,
    userId, row.current_step, row.answers, row.completed, row.skipped);
}

/** Masked view of the stored key for the chosen cloud provider (never the key itself). */
async function providerKeyView(provider: WizardProvider | undefined): Promise<{ apiKeySet?: boolean; apiKeyMasked?: string }> {
  if (provider !== 'anthropic' && provider !== 'openai') return {};
  const key = await getGlobalProviderApiKey(provider === 'anthropic' ? 'claude' : 'openai');
  return key ? { apiKeySet: true, apiKeyMasked: maskSecret(key) } : { apiKeySet: false };
}

export async function getWizardState(userId: string): Promise<WizardState> {
  const row = await readRow(userId);
  const answers = parseAnswers(row?.answers);
  return {
    completed: row?.completed === 1,
    skipped: row?.skipped === 1,
    currentStep: row?.current_step ?? 1,
    totalSteps: TOTAL_STEPS,
    data: { ...answers, ...(await providerKeyView(answers.aiProvider)) },
  };
}

/** Apply a validated step through the existing settings paths and save the answers. */
export async function saveWizardStep(
  userId: string,
  step: ValidatedStep | null,
  currentStep: number | undefined
): Promise<WizardState> {
  if (step) {
    if (step.step === 'profile') {
      // The same statement UsersRepository.update ran (SQLite only), on the process driver.
      await q.run('UPDATE users SET full_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', step.answers.userName, userId);
    } else if (step.step === 'provider') {
      await applyProviderSettings(step.answers, step.apiKey);
    }
  }

  await updateRow(userId, function* (row) {
    const answers = parseAnswers(row?.answers);
    if (step) {
      // A previously saved ollamaUrl must not linger after switching provider.
      if (step.step === 'provider') delete answers.ollamaUrl;
      // channels: saved only, never started. skills: saved only, never installed.
      Object.assign(answers, step.answers);
    }
    yield* writeRow(
      userId,
      {
        current_step: currentStep ?? row?.current_step ?? 1,
        answers: JSON.stringify(answers),
        completed: row?.completed ?? 0,
        skipped: row?.skipped ?? 0,
      },
      'keep'
    );
  });
  return getWizardState(userId);
}

async function applyProviderSettings(answers: Omit<ProviderInput, 'apiKey'>, apiKey: string | undefined): Promise<void> {
  const manager = getSettingsManager();
  const updates: Partial<AgentSettings> = {};
  if (answers.aiProvider === 'ollama') {
    updates.provider = 'local';
    updates.local = { url: answers.ollamaUrl ?? DEFAULT_OLLAMA_URL, model: answers.aiModel };
  } else if (answers.aiProvider === 'anthropic') {
    updates.provider = 'claude';
    // apiKey undefined keeps the stored key (settings manager merges provider blocks).
    updates.claude = { model: answers.aiModel, ...(apiKey ? { apiKey } : {}) } as AgentSettings['claude'];
  } else {
    updates.provider = 'openai';
    updates.openai = { model: answers.aiModel, ...(apiKey ? { apiKey } : {}) } as AgentSettings['openai'];
  }
  await manager.updateSettings(updates);
}

export async function completeWizard(userId: string, skipped: boolean): Promise<WizardState> {
  await updateRow(userId, (row) => writeRow(
    userId,
    {
      current_step: skipped ? row?.current_step ?? 1 : TOTAL_STEPS,
      answers: row?.answers ?? '{}',
      completed: 1,
      skipped: skipped ? 1 : 0,
    },
    'now'
  ));
  return getWizardState(userId);
}

/** Start over: answers cleared, not completed. Settings already applied stay as they are. */
export async function resetWizard(userId: string): Promise<WizardState> {
  await sql().read(writeRow(userId, { current_step: 1, answers: '{}', completed: 0, skipped: 0 }, 'null'));
  return getWizardState(userId);
}
