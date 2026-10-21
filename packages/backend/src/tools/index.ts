/**
 * Tools System - Main Export
 *
 * This module exports all available tools and utilities for creating
 * and managing the tools registry.
 */

export * from './types.js';
export * from './registry.js';
export * from './grants.js';

// Re-export organized tools
export * from './core/index.js';
export * from './browser/index.js';
export * from './memory/index.js';
export * from './desktop/index.js';
export * from './storage/index.js';
export * from './cli/index.js';
export * from './notifications/index.js';
export * from './credentials/index.js';

// Utility function to create a pre-configured registry
import { loadRunPermissions, loadRunPermissionsSync, type RunScope } from './agent-permissions.js';
import { ToolsRegistry } from './registry.js';
import type { ToolExecutionContext } from './types.js';
import { defaultGrants, loadAgentGrants, loadAgentGrantsSync } from './grants.js';

// Import tools from organized directories
import {
  execTool,
  readTool,
  writeTool,
  webFetchTool,
  executeCodeTool,
} from './core/index.js';

import {
  browserNavigateTool,
  browserScreenshotTool,
  browserExtractTool,
  browserInteractTool,
} from './browser/index.js';

import {
  memorySaveTool,
  memorySearchTool,
  memoryReflectTool,
  memoryStatsTool,
  memoryEditTool,
  memoryDeleteTool,
  memoryForgetTool,
  memoryDoctorTool,
  memoryDoctorFixTool,
  memoryGraphTool,
  memoryScopesTool,
  memoryScopeApplyTool,
  memoryAccessApplyTool,
  memoryScopeForgetTool,
  memoryMoveTool,
  memoryBridgeTool,
  memoryBridgeApplyTool,
  memoryReviewTool,
  memoryReviewDecideTool,
  memoryReviewRoutineTool,
  memoryGraphReviewTool,
  memoryGraphTopicTool,
  memoryGraphSyncTool,
  memoryRecallTool,
} from './memory/index.js';

import {
  desktopControlTool,
} from './desktop/index.js';

import {
  storageSaveTool,
  storageSearchTool,
  storageDeleteTool,
} from './storage/index.js';

import {
  geminiCliTool,
  claudeCliTool,
} from './cli/index.js';

import {
  createReminderTool,
} from './notifications/index.js';

import {
  credentialsSaveTool,
} from './credentials/index.js';

import { planStepsTool } from './plan/plan-steps.js';
import { askCodingAppTool } from './cli/ask-coding-app.js';
import { boardSuggestCardTool } from './board/board-suggest.js';
import { handoffReadTool, handoffSaveTool } from './handoff/handoff.js';
import { boardCheckTool, boardChecklistTool, boardCommentTool, boardMoveTool, boardMyCardsTool } from './board/board-tools.js';

import {
  skillInstallTool,
} from './skill-install.js';
import { discoveryTool, discoveryApplyTool } from './discovery.js';

import { getMcpTools, getMcpToolsSync, isMcpToolName } from '../mcp-client/index.js';

// Global registry of extension-provided tools (registered at extension startup)
import type { Tool } from './types.js';

const extensionTools: Tool[] = [];

/** Built-in tools, in registration order. */
const CORE_TOOLS: Tool[] = [
  execTool, readTool, writeTool, webFetchTool, executeCodeTool,
  browserNavigateTool, browserScreenshotTool, browserExtractTool, browserInteractTool,
  memorySaveTool, memorySearchTool, memoryReflectTool, memoryStatsTool, memoryEditTool, memoryDeleteTool, memoryForgetTool, memoryGraphTool,
  memoryDoctorTool, memoryDoctorFixTool, memoryMoveTool,
  memoryScopesTool, memoryScopeApplyTool, memoryAccessApplyTool, memoryScopeForgetTool,
  memoryBridgeTool, memoryBridgeApplyTool, // MEM-BRIDGE-01: owner-only; apply needs owner approval
  discoveryTool, discoveryApplyTool, // DISCOVER-01: what coding agents left on this computer; owner-only; apply needs owner approval
  memoryReviewTool, memoryReviewDecideTool, memoryReviewRoutineTool, memoryGraphReviewTool, memoryGraphTopicTool, memoryGraphSyncTool, memoryRecallTool, // owner's review inbox, topics + reply trace; decisions need owner approval
  desktopControlTool,
  storageSaveTool, storageSearchTool, storageDeleteTool,
  createReminderTool,
  credentialsSaveTool,
  skillInstallTool,
  boardMyCardsTool, boardCommentTool, boardMoveTool, boardChecklistTool, boardCheckTool, // BOARD-02/03: only the agent's own board cards
  planStepsTool, // CHAT-PRO-02 H: the agent's own live task plan (self-only, no grant)
  boardSuggestCardTool, // CHAT-PRO-02 I step 2: suggests a board card; only the owner creates it (self-only, no grant)
  handoffSaveTool, handoffReadTool, // CORE-MEM-HANDOFF: the agent's own done/left/next note for its next session (self-only, no grant)
  askCodingAppTool, // CORE-ROUTE-01: ask the owner's Claude Code / Codex (granted per agent, approved per call, desktop app only)
];

/**
 * Names an extension tool may not use: built-in tools (and the CLI bridges),
 * so an extension cannot replace a core tool or inherit its policy.
 */
export function isReservedToolName(name: string): boolean {
  return CORE_TOOLS.some((t) => t.name === name) || name === geminiCliTool.name || name === claudeCliTool.name;
}

/**
 * Register an extension tool globally (used by Extension SDK)
 */
export function registerExtensionTool(tool: Tool): void {
  if (isReservedToolName(tool.name)) {
    throw new Error(`Extension tool name "${tool.name}" is reserved for a built-in tool`);
  }
  if (isMcpToolName(tool.name)) {
    throw new Error(`Extension tool name "${tool.name}" uses the reserved MCP prefix "mcp__"`);
  }
  // Remove if already exists
  const existingIndex = extensionTools.findIndex((t) => t.name === tool.name);
  if (existingIndex !== -1) {
    extensionTools.splice(existingIndex, 1);
  }
  extensionTools.push(tool);
}

/**
 * Unregister an extension tool globally (used by Extension SDK)
 */
export function unregisterExtensionTool(name: string): void {
  const index = extensionTools.findIndex((t) => t.name === name);
  if (index !== -1) {
    extensionTools.splice(index, 1);
  }
}

/**
 * Get all extension tools (optionally filtered by extensionId)
 */
export function getExtensionTools(extensionId?: string): Tool[] {
  if (extensionId) {
    return extensionTools.filter((t) => t.extensionId === extensionId);
  }
  return [...extensionTools];
}

/** MEM-SCALE-01: the run's user and project (its open project drawer) for the owner's access policies. */
function runScope(context: ToolExecutionContext): RunScope {
  return { userId: context.accessOwnerId ?? context.userId ?? null, project: context.memoryDrawers?.find((d) => d.kind === 'project')?.key ?? null };
}

/**
 * Create a tools registry with all tools registered
 */
/**
 * The tools registry for a context. When the context has no `grants`, the
 * agent's grants are loaded synchronously: SQLite only (on PostgreSQL this
 * throws when an agentId is given; use createAgentToolsRegistry).
 */
export function createToolsRegistry(context: ToolExecutionContext): ToolsRegistry {
  // MCP tools: the cache or a synchronous SQLite read; on PostgreSQL the
  // cache only (B2.2c; use createAgentToolsRegistry to get them for sure).
  const registry = buildToolsRegistry(context, getMcpToolsSync());
  // SECURITY (S1.2): the agent's grants (∩ parents / delegating agents).
  // No agent -> minimal default set (fail closed).
  if (!context.grants) {
    registry.updateContext({
      grants: context.agentId
        ? loadAgentGrantsSync(context.agentId, registry.listRegistered(), context.delegatedFrom || [])
        : defaultGrants(),
    });
  }
  // CORE-PERMS-01: the agent's memory scope and off / ask / allow modes,
  // narrowed by every agent this run was delegated from.
  if (!context.permissions && context.agentId) registry.updateContext({ permissions: loadRunPermissionsSync(context.agentId, context.delegatedFrom || [], runScope(context)) });
  return registry;
}

/**
 * createToolsRegistry with the agent's grants loaded asynchronously (both
 * drivers; B2.2b-3). Use it wherever the caller can await.
 */
export async function createAgentToolsRegistry(context: ToolExecutionContext): Promise<ToolsRegistry> {
  const registry = buildToolsRegistry(context, await getMcpTools());
  if (!context.grants) {
    registry.updateContext({
      grants: context.agentId
        ? await loadAgentGrants(context.agentId, registry.listRegistered(), context.delegatedFrom || [])
        : defaultGrants(),
    });
  }
  // CORE-PERMS-01: the agent's memory scope and off / ask / allow modes,
  // narrowed by every agent this run was delegated from.
  if (!context.permissions && context.agentId) registry.updateContext({ permissions: await loadRunPermissions(context.agentId, context.delegatedFrom || [], runScope(context)) });
  return registry;
}

function buildToolsRegistry(context: ToolExecutionContext, mcpTools: Tool[]): ToolsRegistry {
  const registry = new ToolsRegistry(context);

  // Register core tools (CLI bridges gemini_cli/claude_cli stay unregistered)
  for (const tool of CORE_TOOLS) {
    registry.register(tool);
  }

  // Register extension-provided tools
  for (const tool of extensionTools) {
    registry.register(tool);
  }

  // M1: tools of active owner-registered MCP servers (never granted by default)
  for (const tool of mcpTools) {
    registry.register(tool);
  }

  const coreToolsCount = 19;  // Increased from 18 (added execute_code)
  const totalToolsCount = coreToolsCount + extensionTools.length;

  console.log(`[Tools] 🔧 Tools registry created with ${totalToolsCount} tools`);
  console.log('  ├── Core: 5 tools (exec, read, write, web_fetch, execute_code)');
  console.log('  ├── Browser: 4 tools (navigate, screenshot, extract, interact)');
  console.log('  ├── Memory: 4 tools (save, search, reflect, stats)');
  console.log('  ├── Desktop: 1 tool (desktop_control)');
  console.log('  ├── Storage: 3 tools (storage_save, storage_search, storage_delete)');
  console.log('  ├── Credentials: 1 tool (credentials_save)');
  console.log('  ├── Notifications: 1 tool (create_reminder)');
  if (extensionTools.length > 0) {
    console.log(`  └── Extensions: ${extensionTools.length} tools (${extensionTools.map(t => t.name).join(', ')})`);
  }

  return registry;
}
