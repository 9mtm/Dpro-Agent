import { safeConsole } from '../services/safe-error-log.js';
import { extensionResourcePath } from '../plugins/resource-path.js';
/**
 * Extension Permissions Middleware
 * Validates extension capabilities before allowing API access
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { logSecurityEvent } from '../services/audit-logger.js';

/**
 * Supported permission types
 */
export type PermissionType =
  | 'network'     // HTTP requests, web APIs
  | 'database'    // Direct database access
  | 'filesystem'  // Read/write files
  | 'tools'       // Register AI tools
  | 'cron'        // Schedule background jobs
  | 'storage'     // Extension storage API (always granted)
  | 'process';    // Execute shell commands

/**
 * Permission metadata with risk levels
 */
const PERMISSION_METADATA: Record<PermissionType, { risk: 'low' | 'medium' | 'high'; description: string }> = {
  storage: { risk: 'low', description: 'Access extension-specific storage' },
  tools: { risk: 'medium', description: 'Register AI tools for agent use' },
  cron: { risk: 'medium', description: 'Schedule background tasks' },
  network: { risk: 'medium', description: 'Make HTTP requests' },
  filesystem: { risk: 'high', description: 'Read/write files on disk' },
  database: { risk: 'high', description: 'Direct database access' },
  process: { risk: 'high', description: 'Execute shell commands' },
};

/**
 * Read extension manifest and extract permissions
 */
export function getExtensionPermissions(extensionId: string): PermissionType[] {
  if (typeof extensionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(extensionId) || extensionId.includes('..')) return [];
  const extensionsDir = resolve('./extensions');
  let manifestPath: string;
  try {
    manifestPath = extensionResourcePath(extensionsDir, join(extensionId, 'agentplayer.plugin.json'));
    if (!existsSync(manifestPath)) {
      manifestPath = extensionResourcePath(extensionsDir, join(extensionId, 'agent-player.plugin.json'));
    }
  } catch {
    return [];
  }

  if (!existsSync(manifestPath)) {
    safeConsole.warn(`[Permissions] ⚠️  Manifest not found for extension: ${extensionId}`);
    return [];
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // Legacy format: manifest.channels (Discord/Slack/etc.)
    if (manifest.channels && Array.isArray(manifest.channels)) {
      // Channel extensions implicitly need network + database
      return ['network', 'database', 'storage'];
    }

    // Modern format: manifest.permissions or manifest.capabilities
    const rawPermissions = manifest.permissions ?? manifest.capabilities ?? [];
    if (!Array.isArray(rawPermissions) || rawPermissions.some(value => typeof value !== 'string')) return [];
    const permissions = [...rawPermissions];

    // Always grant storage permission (sandboxed)
    if (!permissions.includes('storage')) {
      permissions.push('storage');
    }

    return permissions;
  } catch (error) {
    safeConsole.error(`[Permissions] ❌ Failed to read manifest for ${extensionId}:`, error);
    return [];
  }
}

/**
 * Check if extension has required permissions
 * @returns { granted: true } if all permissions granted, { granted: false, missing: [...] } otherwise
 */
export function checkPermissions(
  extensionId: string,
  required: PermissionType[]
): { granted: boolean; missing?: PermissionType[] } {
  const granted = getExtensionPermissions(extensionId);

  const missing = required.filter((perm) => !granted.includes(perm));

  if (missing.length > 0) {
    return { granted: false, missing };
  }

  return { granted: true };
}

/**
 * Fastify preHandler hook to enforce permissions
 * Usage: fastify.get('/route', { preHandler: requirePermissions(['database', 'network']) }, handler)
 */
export function requirePermissions(required: PermissionType[]) {
  return async (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
    // Extract extension ID from route path (/api/ext/:extensionId/...)
    const pathSegments = request.url.split('/');
    const extIndex = pathSegments.indexOf('ext');

    if (extIndex === -1 || !pathSegments[extIndex + 1]) {
      console.error('[Permissions] ❌ Cannot extract extension ID from route:', request.url);
      return reply.status(500).send({
        success: false,
        error: 'Internal error: extension ID not found in route',
      });
    }

    const extensionId = pathSegments[extIndex + 1];

    // Check permissions
    const result = checkPermissions(extensionId, required);

    if (!result.granted) {
      // Log security event
      await logSecurityEvent({
        event_type: 'extension.permission.denied',
        severity: 'medium',
        user_id: null, // Extension operations may not have user context
        ip_address: request.ip,
        user_agent: request.headers['user-agent'] || null,
        resource_type: 'extension',
        resource_id: extensionId,
        action: 'api_call',
        status: 'blocked',
        metadata: {
          required_permissions: required,
          missing_permissions: result.missing,
          route: request.url,
          method: request.method,
        },
      });

      console.warn(
        `[Permissions] 🚫 Extension "${extensionId}" denied access to ${request.url} - Missing permissions: ${result.missing?.join(', ')}`
      );

      return reply.status(403).send({
        success: false,
        error: 'Permission denied',
        details: `Extension "${extensionId}" requires permissions: ${result.missing?.join(', ')}`,
      });
    }

    // Log successful access
    await logSecurityEvent({
      event_type: 'extension.permission.granted',
      severity: 'info',
      user_id: null,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'] || null,
      resource_type: 'extension',
      resource_id: extensionId,
      action: 'api_call',
      status: 'success',
      metadata: {
        required_permissions: required,
        route: request.url,
        method: request.method,
      },
    });

    done();
  };
}

/**
 * Get permission metadata (risk level, description)
 */
export function getPermissionMetadata(permission: PermissionType) {
  return PERMISSION_METADATA[permission];
}

/**
 * Get all permissions with their metadata
 */
export function getAllPermissions() {
  return Object.entries(PERMISSION_METADATA).map(([type, meta]) => ({
    type: type as PermissionType,
    ...meta,
  }));
}
