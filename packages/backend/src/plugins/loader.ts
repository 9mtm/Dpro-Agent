import { safeConsole } from '../services/safe-error-log.js';
/**
 * Plugin Loader
 * Loads and validates plugins from directories and manifests
 */

import fs from 'fs/promises';
import path from 'path';
import type {
  Plugin,
  PluginManifest,
  IPluginLoader,
  PluginError,
} from './types.js';

export class PluginLoader implements IPluginLoader {
  private loadedPlugins: Map<string, Plugin> = new Map();

  /**
   * Load all plugins from a directory
   */
  async loadFromDirectory(dir: string): Promise<Plugin[]> {
    console.log(`[PluginLoader] 📂 Loading plugins from: ${dir}`);

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const plugins: Plugin[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(dir, entry.name);
        const manifestPath = path.join(pluginDir, 'agentplayer.plugin.json');

        try {
          // Check if manifest exists
          await fs.access(manifestPath);

          // Load plugin from manifest
          const plugin = await this.loadFromManifest(manifestPath);
          plugins.push(plugin);

          console.log(`[PluginLoader] ✅ Loaded: ${plugin.name} v${plugin.version}`);
        } catch (error) {
          console.warn(
            `[PluginLoader] ⚠️  Skipping ${entry.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      console.log(`[PluginLoader] 📦 Loaded ${plugins.length} plugins`);
      return plugins;
    } catch (error) {
      console.error(`[PluginLoader] ❌ Failed to load directory: ${error}`);
      return [];
    }
  }

  /**
   * Load a plugin from manifest file
   */
  async loadFromManifest(manifestPath: string): Promise<Plugin> {
    console.log(`[PluginLoader] 📄 Reading manifest: ${manifestPath}`);

    // Read and parse manifest
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest: PluginManifest = JSON.parse(manifestContent);

    // Validate manifest
    if (!this.validateManifest(manifest)) {
      throw new Error('Invalid plugin manifest');
    }

    // Get plugin directory
    const pluginDir = path.dirname(manifestPath);

    // Load plugin main file
    const mainPath = path.join(pluginDir, manifest.main);

    try {
      // Dynamic import
      const pluginModule = await import(mainPath);

      // Get plugin instance (default export or named export)
      const PluginClass = pluginModule.default || pluginModule.Plugin;

      if (!PluginClass) {
        throw new Error('Plugin must export a default class or named Plugin class');
      }

      // Create plugin instance
      const plugin: Plugin = new PluginClass();

      // Set metadata from manifest
      plugin.id = manifest.id;
      plugin.name = manifest.name;
      plugin.version = manifest.version;
      plugin.type = manifest.type;
      plugin.enabled = true;

      // Set settings schema if available
      if (manifest.settings) {
        plugin.settingsSchema = manifest.settings;
      }

      // Store loaded plugin
      this.loadedPlugins.set(plugin.id, plugin);

      return plugin;
    } catch (error) {
      throw new Error(
        `Failed to load plugin from ${mainPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Install a plugin from source
   * @param source - Local path or URL
   */
  async install(source: string): Promise<Plugin> {
    console.log(`[PluginLoader] 📥 Installing plugin from: ${source}`);

    // For now, only support local paths
    // TODO: Add support for URLs (npm packages, git repos, etc.)

    if (!source.startsWith('http')) {
      // Local path
      const manifestPath = path.join(source, 'agentplayer.plugin.json');
      return await this.loadFromManifest(manifestPath);
    }

    throw new Error('URL installation not yet implemented');
  }

  /**
   * Uninstall a plugin
   */
  async uninstall(pluginId: string): Promise<void> {
    safeConsole.log(`[PluginLoader] 🗑️  Uninstalling plugin: ${pluginId}`);

    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    // Call onUnload hook
    if (plugin.onUnload) {
      await plugin.onUnload();
    }

    // Remove from loaded plugins
    this.loadedPlugins.delete(pluginId);

    console.log(`[PluginLoader] ✅ Uninstalled: ${plugin.name}`);
  }

  /**
   * Validate a plugin
   */
  async validate(plugin: Plugin): Promise<boolean> {
    // Check required fields
    if (!plugin.id || !plugin.name || !plugin.version || !plugin.type) {
      console.error('[PluginLoader] ❌ Plugin missing required fields');
      return false;
    }

    // Check if lifecycle hooks are functions
    if (plugin.onLoad && typeof plugin.onLoad !== 'function') {
      console.error('[PluginLoader] ❌ onLoad must be a function');
      return false;
    }

    if (plugin.onUnload && typeof plugin.onUnload !== 'function') {
      console.error('[PluginLoader] ❌ onUnload must be a function');
      return false;
    }

    // Run health check if available
    if (plugin.healthCheck) {
      const healthy = await plugin.healthCheck();
      if (!healthy) {
        console.warn(`[PluginLoader] ⚠️  Plugin ${plugin.name} failed health check`);
        return false;
      }
    }

    return true;
  }

  /**
   * Validate plugin manifest
   */
  validateManifest(manifest: PluginManifest): boolean {
    // Required fields
    const requiredFields = ['id', 'name', 'version', 'type', 'main'];

    for (const field of requiredFields) {
      if (!(field in manifest)) {
        console.error(`[PluginLoader] ❌ Manifest missing required field: ${field}`);
        return false;
      }
    }

    // Validate ID format (alphanumeric, hyphens, underscores)
    if (!/^[a-z0-9-_]+$/.test(manifest.id)) {
      console.error('[PluginLoader] ❌ Invalid plugin ID format');
      return false;
    }

    // Validate version format (semver)
    if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
      console.error('[PluginLoader] ❌ Invalid version format (expected semver)');
      return false;
    }

    // Validate type
    const validTypes = ['channel', 'skill', 'tool', 'integration', 'custom'];
    if (!validTypes.includes(manifest.type)) {
      console.error(`[PluginLoader] ❌ Invalid plugin type: ${manifest.type}`);
      return false;
    }

    return true;
  }

  /**
   * Get all loaded plugins
   */
  getLoadedPlugins(): Plugin[] {
    return Array.from(this.loadedPlugins.values());
  }

  /**
   * Get loaded plugin by ID
   */
  getLoadedPlugin(pluginId: string): Plugin | undefined {
    return this.loadedPlugins.get(pluginId);
  }

  /**
   * Clear all loaded plugins
   */
  clear(): void {
    this.loadedPlugins.clear();
    console.log('[PluginLoader] 🗑️  Cleared all loaded plugins');
  }
}

// Singleton instance
let loaderInstance: PluginLoader | null = null;

export function getPluginLoader(): PluginLoader {
  if (!loaderInstance) {
    loaderInstance = new PluginLoader();
  }
  return loaderInstance;
}
