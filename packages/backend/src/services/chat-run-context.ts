import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolResult } from '../tools/types.js';

/** Trusted execution context, never read from model arguments or HTTP bodies. */
export interface ChatRunContext {
  reviewTools: boolean;
  failed?: boolean;
  beforeTool(name: string, params: Record<string, unknown>): Promise<string>;
  afterTool(id: string, result: ToolResult): Promise<void>;
}
const storage = new AsyncLocalStorage<ChatRunContext>();
export const currentChatRun = () => storage.getStore();
export function withChatRun<T>(context: ChatRunContext, execute: () => T): T { return storage.run(context, execute); }
