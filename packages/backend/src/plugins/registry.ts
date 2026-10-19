import { safeConsole } from '../services/safe-error-log.js';
/**
 * Plugin Registry
 * Manages registered plugins
 */

import EventEmitter from 'events';
import type {
  Plugin,
  PluginType,
  IPluginRegistry,
  PluginEvent,
  PluginError,
} from './types.js';

export class PluginRegistry extends EventEmitter implements IPluginRegistry {
  private plugins: Map<string, Plugin> = new Map();

  constructor() {
    super();
  }

  /**
   * Register a plugin
   */
  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin ${plugin.id} is already registered`);
    }

    this.plugins.set(plugin.id, plugin);
    console.log(`[PluginRegistry] ✅ Registered plugin: ${plugin.name} (${plugin.id})`);

    this.emit('plugin:registered', plugin);
  }

  /**
   * Unregister a plugin
   */
  unregister(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      safeConsole.warn(`[PluginRegistry] Plugin ${pluginId} not found`);
      return;
    }

    this.plugins.delete(pluginId);
    console.log(`[PluginRegistry] ❌ Unregistered plugin: ${plugin.name}`);

    this.emit('plugin:unregistered', plugin);
  }

  /**
   * Get a plugin by ID
   */
  get(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all plugins
   */
  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugins by type
   */
  getByType(type: PluginType): Plugin[] {
    return this.getAll().filter((p) => p.type === type);
  }

  /**
   * Get enabled plugins only
   */
  getEnabled(): Plugin[] {
    return this.getAll().filter((p) => p.enabled);
  }

  /**
   * Enable a plugin
   */
  async enable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    if (plugin.enabled) {
      console.log(`[PluginRegistry] Plugin ${plugin.name} is already enabled`);
      return;
    }

    try {
      // Call onEnable hook if exists
      if (plugin.onEnable) {
        await plugin.onEnable();
      }

      plugin.enabled = true;
      console.log(`[PluginRegistry] ✅ Enabled plugin: ${plugin.name}`);

      this.emit('plugin:enabled', plugin);
    } catch (error) {
      console.error(`[PluginRegistry] ❌ Failed to enable ${plugin.name}:`, error);
      throw error;
    }
  }

  /**
   * Disable a plugin
   */
  async disable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    if (!plugin.enabled) {
      console.log(`[PluginRegistry] Plugin ${plugin.name} is already disabled`);
      return;
    }

    try {
      // Call onDisable hook if exists
      if (plugin.onDisable) {
        await plugin.onDisable();
      }

      plugin.enabled = false;
      console.log(`[PluginRegistry] 🔴 Disabled plugin: ${plugin.name}`);

      this.emit('plugin:disabled', plugin);
    } catch (error) {
      console.error(`[PluginRegistry] ❌ Failed to disable ${plugin.name}:`, error);
      throw error;
    }
  }

  /**
   * Check if plugin exists
   */
  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /**
   * Get plugin count
   */
  count(): number {
    return this.plugins.size;
  }

  /**
   * Get enabled plugin count
   */
  countEnabled(): number {
    return this.getEnabled().length;
  }

  /**
   * Clear all plugins
   */
  clear(): void {
    this.plugins.clear();
    console.log('[PluginRegistry] 🗑️  Cleared all plugins');
  }

  /**
   * Get plugins as array for serialization
   */
  toJSON() {
    return {
      total: this.count(),
      enabled: this.countEnabled(),
      plugins: this.getAll().map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        type: p.type,
        enabled: p.enabled,
      })),
    };
  }
}

// Singleton instance
let registryInstance: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry {
  if (!registryInstance) {
    registryInstance = new PluginRegistry();
  }
  return registryInstance;
}
