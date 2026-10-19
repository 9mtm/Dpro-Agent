/**
 * Skills Registry
 * Manages skills with precedence system (workspace > managed > bundled)
 */

import EventEmitter from 'events';
import { dirname } from 'path';
import chokidar from 'chokidar';
import type { Skill, SkillSource, ISkillsRegistry } from './types.js';
import { getSkillsParser } from './parser.js';

export class SkillsRegistry extends EventEmitter implements ISkillsRegistry {
  private skills: Map<string, Skill> = new Map();
  private parser = getSkillsParser();
  private watcher: any = null;
  /** Directories passed to load(), so reload() also rescans ones that were empty. */
  private loadedDirectories = new Set<string>();

  // Precedence (higher = more priority)
  private readonly precedence: Record<SkillSource, number> = {
    workspace: 3,
    managed: 2,
    bundled: 1,
  };

  constructor() {
    super();
  }

  /**
   * Load skills from directories
   */
  async load(directories: string[]): Promise<void> {
    console.log('[SkillsRegistry] 📂 Loading skills from directories...');

    for (const dir of directories) {
      this.loadedDirectories.add(dir);
      await this.loadDirectory(dir);
    }

    console.log(`[SkillsRegistry] ✅ Loaded ${this.skills.size} skills`);
  }

  /**
   * Load skills from a single directory
   */
  private async loadDirectory(dir: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Find all .md files
      const files = await this.findSkillFiles(dir);

      for (const file of files) {
        try {
          const skill = await this.parser.parse(file);

          // Check precedence before adding
          const existing = this.skills.get(skill.name);
          if (!existing || this.shouldOverride(existing, skill)) {
            this.skills.set(skill.name, skill);
            console.log(
              `[SkillsRegistry] ✅ ${skill.name} (${skill.source}, v${skill.version})`
            );
          } else {
            console.log(
              `[SkillsRegistry] ⏭️  Skipped ${skill.name} (${skill.source}) - lower precedence than ${existing.source}`
            );
          }
        } catch (error) {
          console.error(`[SkillsRegistry] ❌ Failed to load ${file}:`, error);
        }
      }
    } catch (error) {
      console.error(`[SkillsRegistry] ❌ Failed to load directory ${dir}:`, error);
    }
  }

  /**
   * Find all SKILL.md files in directory (recursive)
   */
  private async findSkillFiles(dir: string): Promise<string[]> {
    const fs = await import('fs/promises');
    const path = await import('path');

    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recurse into subdirectories
          const subFiles = await this.findSkillFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          // Only SKILL.md is a skill; READMEs and reference files beside it are not.
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory doesn't exist or not accessible
      console.warn(`[SkillsRegistry] ⚠️  Cannot access directory: ${dir}`);
    }

    return files;
  }

  /**
   * Check if new skill should override existing one based on precedence
   */
  private shouldOverride(existing: Skill, newSkill: Skill): boolean {
    return this.precedence[newSkill.source] > this.precedence[existing.source];
  }

  /**
   * Get skill by name
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get all skills
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get enabled skills only
   */
  getEnabled(): Skill[] {
    return this.getAll().filter((s) => s.enabled);
  }

  /**
   * Get skills by source
   */
  getBySource(source: SkillSource): Skill[] {
    return this.getAll().filter((s) => s.source === source);
  }

  /**
   * Add skill manually
   */
  add(skill: Skill): void {
    const existing = this.skills.get(skill.name);

    if (existing && !this.shouldOverride(existing, skill)) {
      console.warn(
        `[SkillsRegistry] Cannot add ${skill.name} - lower precedence than existing`
      );
      return;
    }

    this.skills.set(skill.name, skill);
    console.log(`[SkillsRegistry] ✅ Added: ${skill.name}`);

    this.emit('skill:added', skill);
  }

  /**
   * Remove skill
   */
  remove(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) {
      console.warn(`[SkillsRegistry] Skill ${name} not found`);
      return;
    }

    this.skills.delete(name);
    console.log(`[SkillsRegistry] ❌ Removed: ${name}`);

    this.emit('skill:removed', skill);
  }

  /**
   * Enable skill
   */
  enable(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill ${name} not found`);
    }

    skill.enabled = true;
    console.log(`[SkillsRegistry] ✅ Enabled: ${name}`);

    this.emit('skill:enabled', skill);
  }

  /**
   * Disable skill
   */
  disable(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill ${name} not found`);
    }

    skill.enabled = false;
    console.log(`[SkillsRegistry] 🔴 Disabled: ${name}`);

    this.emit('skill:disabled', skill);
  }

  /**
   * Reload all skills
   */
  async reload(): Promise<void> {
    console.log('[SkillsRegistry] 🔄 Reloading all skills...');

    // Directories given to load() plus those of the current skills.
    // (Used `require('path')`, which does not exist in this ES module.)
    const directories = [
      ...new Set([...this.loadedDirectories, ...this.getAll().map((s) => dirname(s.filePath))]),
    ];

    // Clear and reload
    this.skills.clear();
    await this.load(directories);

    this.emit('skills:reloaded');
  }

  /**
   * Watch for file changes and hot reload
   */
  watch(): void {
    if (this.watcher) {
      console.warn('[SkillsRegistry] Already watching for changes');
      return;
    }

    // Get all skill file paths
    const filePaths = this.getAll().map((s) => s.filePath);

    if (filePaths.length === 0) {
      console.warn('[SkillsRegistry] No skills to watch');
      return;
    }

    this.watcher = chokidar.watch(filePaths, {
      ignored: /node_modules/,
      persistent: true,
    });

    this.watcher.on('change', async (filePath: string) => {
      console.log(`[SkillsRegistry] 🔄 File changed: ${filePath}`);

      try {
        // Re-parse the changed skill
        const skill = await this.parser.parse(filePath);

        // Update in registry
        this.skills.set(skill.name, skill);

        console.log(`[SkillsRegistry] ✅ Reloaded: ${skill.name}`);
        this.emit('skill:updated', skill);
      } catch (error) {
        console.error(`[SkillsRegistry] ❌ Failed to reload ${filePath}:`, error);
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      console.log(`[SkillsRegistry] 🗑️  File removed: ${filePath}`);

      // Find and remove skill
      const skill = this.getAll().find((s) => s.filePath === filePath);
      if (skill) {
        this.remove(skill.name);
      }
    });

    console.log(`[SkillsRegistry] 👀 Watching ${filePaths.length} skill files for changes`);
  }

  /**
   * Stop watching
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[SkillsRegistry] 🛑 Stopped watching');
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    const all = this.getAll();
    const enabled = this.getEnabled();

    const bySource: Record<SkillSource, number> = {
      bundled: 0,
      managed: 0,
      workspace: 0,
    };

    for (const skill of all) {
      bySource[skill.source]++;
    }

    return {
      total: all.length,
      enabled: enabled.length,
      disabled: all.length - enabled.length,
      bySource,
    };
  }
}

// Singleton instance
let registryInstance: SkillsRegistry | null = null;

export function getSkillsRegistry(): SkillsRegistry {
  if (!registryInstance) {
    registryInstance = new SkillsRegistry();
  }
  return registryInstance;
}
