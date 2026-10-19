import { safeConsole } from '../services/safe-error-log.js';
/**
 * Plugin Manager
 * Manages plugin lifecycle and orchestration
 */

import EventEmitter from 'events';
import type {
  Plugin,
  PluginType,
  IPluginManager,
  PluginMessage,
} from './types.js';
import { PluginEvent } from './types.js';
import { getPluginRegistry } from './registry.js';
import { getPluginLoader } from './loader.js';

export class PluginManager extends EventEmitter implements IPluginManager {
  private registry = getPluginRegistry();
  private loader = getPluginLoader();
  private initialized = false;

  constructor() {
    super();

    // Forward registry events
    this.registry.on('plugin:registered', (plugin) =>
      this.emit(PluginEvent.LOADED, plugin)
    );
    this.registry.on('plugin:unregistered', (plugin) =>
      this.emit(PluginEvent.UNLOADED, plugin)
    );
    this.registry.on('plugin:enabled', (plugin) =>
      this.emit(PluginEvent.ENABLED, plugin)
    );
    this.registry.on('plugin:disabled', (plugin) =>
      this.emit(PluginEvent.DISABLED, plugin)
    );
  }

  /**
   * Initialize plugin system
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('[PluginManager] Already initialized');
      return;
    }

    console.log('[PluginManager] 🚀 Initializing plugin system...');

    try {
      // Load plugins from directories
      const pluginDirs = [
        './plugins', // Bundled plugins
        './extensions', // User extensions
      ];

      for (const dir of pluginDirs) {
        const plugins = await this.loader.loadFromDirectory(dir);

        for (const plugin of plugins) {
          await this.registerAndLoadPlugin(plugin);
        }
      }

      this.initialized = true;
      console.log('[PluginManager] ✅ Plugin system initialized');
    } catch (error) {
      console.error('[PluginManager] ❌ Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Shutdown plugin system
   */
  async shutdown(): Promise<void> {
    console.log('[PluginManager] 🛑 Shutting down plugin system...');

    const plugins = this.registry.getAll();

    for (const plugin of plugins) {
      try {
        await this.unloadPlugin(plugin.id);
      } catch (error) {
        console.error(`[PluginManager] Error unloading ${plugin.name}:`, error);
      }
    }

    this.registry.clear();
    this.loader.clear();
    this.initialized = false;

    console.log('[PluginManager] ✅ Plugin system shut down');
  }

  /**
   * Load a plugin
   */
  async loadPlugin(pluginId: string): Promise<void> {
    safeConsole.log(`[PluginManager] 📥 Loading plugin: ${pluginId}`);

    const plugin = this.loader.getLoadedPlugin(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found in loader`);
    }

    await this.registerAndLoadPlugin(plugin);
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(pluginId: string): Promise<void> {
    safeConsole.log(`[PluginManager] 📤 Unloading plugin: ${pluginId}`);

    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      safeConsole.warn(`[PluginManager] Plugin ${pluginId} not registered`);
      return;
    }

    try {
      // Call onUnload hook
      if (plugin.onUnload) {
        await plugin.onUnload();
      }

      // Unregister from registry
      this.registry.unregister(pluginId);

      // Uninstall from loader
      await this.loader.uninstall(pluginId);

      console.log(`[PluginManager] ✅ Unloaded: ${plugin.name}`);
    } catch (error) {
      safeConsole.error(`[PluginManager] ❌ Failed to unload ${plugin.name}:`, error);
      throw error;
    }
  }

  /**
   * Reload a plugin
   */
  async reloadPlugin(pluginId: string): Promise<void> {
    safeConsole.log(`[PluginManager] 🔄 Reloading plugin: ${pluginId}`);

    await this.unloadPlugin(pluginId);
    await this.loadPlugin(pluginId);

    safeConsole.log(`[PluginManager] ✅ Reloaded plugin: ${pluginId}`);
  }

  /**
   * Enable a plugin
   */
  async enablePlugin(pluginId: string): Promise<void> {
    await this.registry.enable(pluginId);
  }

  /**
   * Disable a plugin
   */
  async disablePlugin(pluginId: string): Promise<void> {
    await this.registry.disable(pluginId);
  }

  /**
   * Get a plugin
   */
  getPlugin(pluginId: string): Plugin | undefined {
    return this.registry.get(pluginId);
  }

  /**
   * Get all plugins
   */
  getAllPlugins(): Plugin[] {
    return this.registry.getAll();
  }

  /**
   * Get plugins by type
   */
  getPluginsByType(type: PluginType): Plugin[] {
    return this.registry.getByType(type);
  }

  /**
   * Broadcast message to all plugins
   */
  async broadcastMessage(message: PluginMessage): Promise<void> {
    const plugins = this.registry.getEnabled();

    for (const plugin of plugins) {
      if (plugin.onMessage) {
        try {
          await plugin.onMessage(message);
        } catch (error) {
          console.error(
            `[PluginManager] ❌ Plugin ${plugin.name} failed to handle message:`,
            error
          );
          this.emit(PluginEvent.ERROR, plugin, error);
        }
      }
    }
  }

  /**
   * Execute command on plugin
   */
  async executeCommand(
    pluginId: string,
    command: string,
    args: string[]
  ): Promise<any> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    if (!plugin.enabled) {
      throw new Error(`Plugin ${plugin.name} is disabled`);
    }

    if (!plugin.onCommand) {
      throw new Error(`Plugin ${plugin.name} does not support commands`);
    }

    try {
      const result = await plugin.onCommand(command, args);
      this.emit(PluginEvent.COMMAND, plugin, command, result);
      return result;
    } catch (error) {
      console.error(
        `[PluginManager] ❌ Command failed for ${plugin.name}:`,
        error
      );
      this.emit(PluginEvent.ERROR, plugin, error);
      throw error;
    }
  }

  /**
   * Private helper: Register and load a plugin
   */
  private async registerAndLoadPlugin(plugin: Plugin): Promise<void> {
    // Validate plugin
    const isValid = await this.loader.validate(plugin);
    if (!isValid) {
      console.warn(`[PluginManager] ⚠️  Skipping invalid plugin: ${plugin.name}`);
      return;
    }

    // Register plugin
    this.registry.register(plugin);

    try {
      // Call onLoad hook
      if (plugin.onLoad) {
        await plugin.onLoad();
      }

      console.log(`[PluginManager] ✅ Loaded and registered: ${plugin.name}`);
    } catch (error) {
      console.error(
        `[PluginManager] ❌ Failed to load ${plugin.name}:`,
        error
      );

      // Unregister on failure
      this.registry.unregister(plugin.id);
      this.emit(PluginEvent.ERROR, plugin, error);

      throw error;
    }
  }

  /**
   * Get plugin statistics
   */
  getStats() {
    const all = this.registry.getAll();
    const enabled = this.registry.getEnabled();

    const byType: Record<PluginType, number> = {
      channel: 0,
      skill: 0,
      tool: 0,
      integration: 0,
      custom: 0,
    };

    for (const plugin of all) {
      byType[plugin.type]++;
    }

    return {
      total: all.length,
      enabled: enabled.length,
      disabled: all.length - enabled.length,
      byType,
    };
  }

  /**
   * Check if system is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
let managerInstance: PluginManager | null = null;

export function getPluginManager(): PluginManager {
  if (!managerInstance) {
    managerInstance = new PluginManager();
  }
  return managerInstance;
}
