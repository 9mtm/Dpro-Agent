import { safeConsole } from '../services/safe-error-log.js';
/**
 * Extension Runner
 * Loads, initializes, and manages extensions at runtime
 */

import type { FastifyInstance } from 'fastify';
import type { PluginManifest } from './types.js';
import { createExtensionApi } from './sdk.js';
import { createExtensionRouteGuard } from './extension-route-access.js';
import { createExtensionErrorSanitizer } from './extension-error-sanitizer.js';
import { getDatabase } from '../db/index.js';
import { nowText } from '../db/pg/dialect.js';
import { q } from '../repositories/sql-steps.js';
import { dbDriver } from '../db/pg/config.js';
import { readdirSync, existsSync, readFileSync, watch } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extension with register() hook
 */
interface Extension {
  id: string;
  name: string;
  version: string;

  // Lifecycle hooks
  register?(api: any): Promise<void>;
  onEnable?(api: any): Promise<void>;
  onDisable?(api: any): Promise<void>;
}

/**
 * Extension Runner
 * Scans extensions directory, loads enabled extensions, calls register() hooks
 */
/**
 * Q-33 (Mohamed, 2026-10-15): extensions are SQLite-only. Their SDK hands
 * them the SQLite handle and they ship SQLite migrations, so on PostgreSQL no
 * extension is loaded, enabled or installed.
 */
export function extensionsAvailable(): boolean {
  return dbDriver() !== 'postgres';
}

/** The refusal the extension and marketplace routes answer on PostgreSQL (HTTP 409). */
export const EXTENSIONS_SQLITE_ONLY = Object.freeze({
  error: 'Extensions run only on the SQLite database; they are off on PostgreSQL',
  code: 'extensions_sqlite_only',
});

export class ExtensionRunner {
  private loadedExtensions = new Map<string, Extension>();
  private extensionsDir: string;

  constructor(extensionsDir: string = './extensions') {
    this.extensionsDir = resolve(extensionsDir);
  }

  /**
   * Initialize all enabled extensions
   * Called at server startup before fastify.listen()
   */
  async initialize(fastify: FastifyInstance, cronEngine: any) {
    // Q-33 (Mohamed, 2026-10-15): extensions keep their own SQLite tables, so
    // they run only on the SQLite database and stay off on PostgreSQL.
    if (!extensionsAvailable()) {
      console.log('[ExtensionRunner] ⏭️  Extensions are off: they run only on the SQLite database (AGENT_PLAYER_DB=postgres)\n');
      return;
    }

    console.log('[ExtensionRunner] 🔌 Loading extensions...\n');

    // Emergency shutdown: disable all extensions via env variable
    if (process.env.EXTENSIONS_DISABLED === 'true') {
      console.log('[ExtensionRunner] 🚨 EMERGENCY SHUTDOWN: All extensions disabled via EXTENSIONS_DISABLED env variable\n');
      console.log('[ExtensionRunner] ℹ️  To re-enable extensions, remove or set EXTENSIONS_DISABLED=false in .env file\n');
      return;
    }

    // Ensure extensions directory exists
    if (!existsSync(this.extensionsDir)) {
      console.log('[ExtensionRunner] ℹ️  No extensions directory found, skipping...\n');
      return;
    }

    // Scan for extension directories
    const extensionDirs = readdirSync(this.extensionsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    console.log(`[ExtensionRunner] Found ${extensionDirs.length} extension(s): ${extensionDirs.join(', ')}\n`);

    for (const dirName of extensionDirs) {
      try {
        await this.loadExtension(dirName, fastify, cronEngine);
      } catch (error: any) {
        console.error(`[ExtensionRunner] ❌ Failed to load extension "${dirName}":`, error.message);
      }
    }

    console.log(`[ExtensionRunner] ✅ Loaded ${this.loadedExtensions.size} extension(s)\n`);
  }

  /**
   * Load a single extension
   */
  private async loadExtension(
    dirName: string,
    fastify: FastifyInstance,
    cronEngine: any
  ) {
    const extensionPath = join(this.extensionsDir, dirName);

    // Try both manifest filename formats (new and old)
    let manifestPath = join(extensionPath, 'agentplayer.plugin.json');
    if (!existsSync(manifestPath)) {
      manifestPath = join(extensionPath, 'agent-player.plugin.json');
    }

    // Read manifest
    if (!existsSync(manifestPath)) {
      console.warn(`[ExtensionRunner] ⚠️  No manifest found for "${dirName}", skipping...`);
      return;
    }

    const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const { id, name, version, main } = manifest;

    // Check if enabled (extension_configs is on the process driver, B2.2c)
    const configRow = await q.one<{ enabled: number }>('SELECT enabled FROM extension_configs WHERE extension_id = ?', id);

    const isEnabled = configRow?.enabled === 1;

    if (!isEnabled) {
      console.log(`[ExtensionRunner] ⏭️  Extension "${name}" (${id}) is disabled, skipping...`);
      return;
    }

    // Load extension module
    const entryPath = join(extensionPath, main);
    if (!existsSync(entryPath)) {
      throw new Error(`Entry point not found: ${entryPath}`);
    }

    // Dynamic import (ESM)
    const extensionModule = await import(pathToFileURL(entryPath).href);
    const extension: Extension = extensionModule.default || extensionModule;

    // Create Extension API (SECURITY: pass extensionPath for path validation - H-04)
    // The extension SDK still gets the SQLite handle (its own B2.2d slice).
    const api = createExtensionApi(id, fastify, getDatabase().getDb(), cronEngine, extensionPath) as any;

    // Call register() hook
    if (extension.register) {
      console.log(`[ExtensionRunner] 🔧 Registering extension: ${name} (${id})`);
      await extension.register(api);
    }

    // Auto-load i18n translations if i18n directory exists
    const i18nDir = manifest.i18n?.dir || 'i18n';
    api.registerTranslations(i18nDir);

    // Register routes (collected during register() call)
    // SECURITY (S0-Q.18): deny by default — owner/admin only unless the
    // manifest declares routeAccess / publicRoutes (see extension-route-access.ts).
    const routesToRegister = api.__getRoutesToRegister();
    for (const { fn, prefix } of routesToRegister) {
      const fullPrefix = `/api/ext/${id}${prefix || ''}`;
      const guard = createExtensionRouteGuard(manifest, `/api/ext/${id}`);
      await fastify.register(async (scope) => {
        scope.addHook('onRequest', guard);
        // F-08: 5xx responses never echo internal error text.
        scope.addHook('onSend', createExtensionErrorSanitizer(id));
        await fn(scope);
      }, { prefix: fullPrefix });
      console.log(`[ExtensionRunner] ✅ Routes registered under: ${fullPrefix}`);
    }

    // Store loaded extension
    this.loadedExtensions.set(id, extension);
    console.log(`[ExtensionRunner] ✅ Extension loaded: ${name} v${version}\n`);
  }

  /**
   * Enable an extension at runtime (requires restart for routes)
   */
  async enableExtension(extensionId: string) {
    // updated_at is TEXT 'YYYY-MM-DD HH:MM:SS' on both drivers.
    const now = nowText(q.dialect);
    await q.run(
      `INSERT INTO extension_configs (extension_id, enabled, updated_at)
       VALUES (?, 1, ${now})
       ON CONFLICT(extension_id) DO UPDATE SET
         enabled = 1,
         updated_at = ${now}`,
      extensionId);

    safeConsole.log(`[ExtensionRunner] ✅ Extension "${extensionId}" enabled (restart required for routes)`);
  }

  /**
   * Disable an extension at runtime
   */
  async disableExtension(extensionId: string) {
    await q.run(
      `UPDATE extension_configs
       SET enabled = 0, updated_at = ${nowText(q.dialect)}
       WHERE extension_id = ?`,
      extensionId);

    // Call onDisable() hook if extension is loaded
    const extension = this.loadedExtensions.get(extensionId);
    if (extension?.onDisable) {
      const api = createExtensionApi(extensionId, {} as any, getDatabase().getDb(), {} as any, join(this.extensionsDir, extensionId));
      await extension.onDisable(api);
    }

    this.loadedExtensions.delete(extensionId);

    safeConsole.log(`[ExtensionRunner] ❌ Extension "${extensionId}" disabled`);
  }

  /**
   * Enable hot reload - watch extension files for changes
   * NOTE: This requires server restart for route changes to take effect
   */
  enableHotReload() {
    if (!extensionsAvailable()) return; // Q-33: off on PostgreSQL
    if (!existsSync(this.extensionsDir)) {
      console.log('[ExtensionRunner] ⚠️  Hot reload disabled - no extensions directory');
      return;
    }

    console.log('[ExtensionRunner] 🔥 Hot reload enabled - watching for changes...\n');

    watch(this.extensionsDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Only watch .js and .json files
      if (!filename.endsWith('.js') && !filename.endsWith('.json')) return;

      // Extract extension ID from path
      const parts = filename.split(/[/\\]/);
      const extensionId = parts[0];

      // Debounce rapid changes
      clearTimeout((this as any)[`_hotReload_${extensionId}`]);
      (this as any)[`_hotReload_${extensionId}`] = setTimeout(() => {
        console.log(`[ExtensionRunner] 🔄 File changed: ${filename} - restart required for changes`);
        console.log(`[ExtensionRunner] 💡 Run: npm run restart:backend`);
      }, 1000);
    });
  }

  /**
   * Get all loaded extensions
   */
  getLoadedExtensions(): Map<string, Extension> {
    return this.loadedExtensions;
  }
}

// Singleton instance
let extensionRunner: ExtensionRunner | null = null;

export function getExtensionRunner(): ExtensionRunner {
  if (!extensionRunner) {
    extensionRunner = new ExtensionRunner();
  }
  return extensionRunner;
}
