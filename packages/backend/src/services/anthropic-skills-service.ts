import { safeConsole } from './safe-error-log.js';
/**
 * Anthropic Skills Service
 *
 * Integrates with Anthropic's official skills repository on GitHub
 * to browse, search, and install Claude Skills.
 */

import { dataPathOr } from '../config/data-root.js';
import { Octokit } from '@octokit/rest';
import { nowText } from '../db/pg/dialect.js';
import { q } from '../repositories/sql-steps.js';
import fs from 'fs/promises';
import path from 'path';
import { isValidSkillName, isValidSkillSourcePath } from '../skills/skill-ids.js';

const ANTHROPIC_REPO_OWNER = 'anthropics';
const ANTHROPIC_REPO_NAME = 'skills';
const SKILLS_BASE_PATH = 'skills';
const LOCAL_SKILLS_DIR = dataPathOr('.data/skills', 'skills');

/** True when `filePath` resolves to a file directly inside the local skills directory. */
function isInsideLocalSkillsDir(filePath: string): boolean {
  const base = path.resolve(LOCAL_SKILLS_DIR);
  const resolved = path.resolve(filePath);
  return path.dirname(resolved) === base && resolved.endsWith('.md');
}

interface AnthropicSkill {
  name: string;
  path: string;
  category: string;
  description?: string;
  sha: string;
}

interface SkillMetadata {
  name: string;
  description: string;
  author?: string;
  version?: string;
  tags?: string[];
}

export class AnthropicSkillsService {
  private octokit: Octokit;

  constructor() {
    const githubToken = process.env.GITHUB_TOKEN;

    this.octokit = new Octokit({
      auth: githubToken,
      // Using token increases rate limit from 60/hour to 5000/hour
    });

    if (!githubToken) {
      console.warn('⚠️  GITHUB_TOKEN not found. Rate limit: 60 requests/hour.');
      console.warn('ℹ️  Add GITHUB_TOKEN to .env for 5000 requests/hour.');
    } else {
      console.log('✅ GitHub authenticated. Rate limit: 5000 requests/hour.');
    }
  }

  /**
   * Fetch all available skills from Anthropic's GitHub repo
   */
  async fetchAvailableSkills(): Promise<AnthropicSkill[]> {
    try {
      const skills: AnthropicSkill[] = [];

      // Fetch skills directory structure
      const { data: contents } = await this.octokit.repos.getContent({
        owner: ANTHROPIC_REPO_OWNER,
        repo: ANTHROPIC_REPO_NAME,
        path: SKILLS_BASE_PATH,
      });

      if (!Array.isArray(contents)) {
        throw new Error('Expected directory listing');
      }

      // Iterate through categories (Creative & Design, Development, etc.)
      for (const category of contents) {
        if (category.type === 'dir') {
          const categorySkills = await this.fetchCategorySkills(category.name);
          skills.push(...categorySkills);
        }
      }

      return skills;
    } catch (error: any) {
      console.error('Error fetching Anthropic skills:', error);

      // Check if it's a rate limit error
      if (error.status === 403 && error.message?.includes('rate limit')) {
        const resetTime = error.response?.headers?.['x-ratelimit-reset'];
        const resetDate = resetTime ? new Date(resetTime * 1000) : null;
        const waitMinutes = resetDate
          ? Math.ceil((resetDate.getTime() - Date.now()) / 60000)
          : 'unknown';

        throw new Error(
          `GitHub API rate limit exceeded. Please add GITHUB_TOKEN to .env or wait ${waitMinutes} minutes.`
        );
      }

      throw new Error('Failed to fetch skills from Anthropic repository');
    }
  }

  /**
   * Fetch skills from a specific category
   */
  private async fetchCategorySkills(categoryName: string): Promise<AnthropicSkill[]> {
    const skills: AnthropicSkill[] = [];

    try {
      const { data: categoryContents } = await this.octokit.repos.getContent({
        owner: ANTHROPIC_REPO_OWNER,
        repo: ANTHROPIC_REPO_NAME,
        path: `${SKILLS_BASE_PATH}/${categoryName}`,
      });

      if (!Array.isArray(categoryContents)) {
        return skills;
      }

      for (const item of categoryContents) {
        if (item.type === 'dir') {
          // Check if this directory contains SKILL.md
          const hasSkillFile = await this.checkForSkillFile(item.path);

          if (hasSkillFile) {
            // Use formatted folder name for display
            const displayName = this.formatSkillName(categoryName, item.name);

            skills.push({
              name: displayName,
              path: item.path,
              category: this.normalizeCategoryName(categoryName),
              sha: item.sha,
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching category ${categoryName}:`, error);
    }

    return skills;
  }

  /**
   * Check if a directory contains SKILL.md
   */
  private async checkForSkillFile(skillPath: string): Promise<boolean> {
    try {
      await this.octokit.repos.getContent({
        owner: ANTHROPIC_REPO_OWNER,
        repo: ANTHROPIC_REPO_NAME,
        path: `${skillPath}/SKILL.md`,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Format skill name from category and folder name
   */
  private formatSkillName(category: string, folderName: string): string {
    // Convert kebab-case to Title Case
    const formatted = folderName
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    return formatted;
  }

  /**
   * Fetch SKILL.md content for a specific skill
   */
  async fetchSkillContent(skillPath: string): Promise<string> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: ANTHROPIC_REPO_OWNER,
        repo: ANTHROPIC_REPO_NAME,
        path: `${skillPath}/SKILL.md`,
      });

      if ('content' in data && data.content) {
        // Decode base64 content
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }

      throw new Error('SKILL.md not found or empty');
    } catch (error) {
      safeConsole.error(`Error fetching skill content for ${skillPath}:`, error);
      throw new Error('Failed to fetch skill content');
    }
  }

  /**
   * Parse SKILL.md frontmatter and extract metadata
   */
  parseSkillMetadata(content: string): SkillMetadata {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      return {
        name: 'unknown',
        description: 'No description available',
      };
    }

    const frontmatter = frontmatterMatch[1];
    const metadata: any = {};

    // Parse YAML-like frontmatter
    const lines = frontmatter.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        metadata[key] = value.trim();
      }
    }

    return {
      name: metadata.name || 'unknown',
      description: metadata.description || 'No description available',
      author: metadata.author,
      version: metadata.version,
      tags: metadata.tags ? metadata.tags.split(',').map((t: string) => t.trim()) : [],
    };
  }

  /**
   * Install a skill locally
   */
  async installSkill(skillName: string, skillPath: string): Promise<string> {

    // SECURITY (S0-Q.19): the name becomes a local file name, the path a repo path.
    if (!isValidSkillName(skillName) || !isValidSkillSourcePath(skillPath)) {
      throw new Error('Invalid skill name or path');
    }

    try {
      safeConsole.log(`[AnthropicSkills] 📦 Installing skill: ${skillName} from path: ${skillPath}`);

      // 1. Fetch skill content from GitHub
      console.log(`[AnthropicSkills] 📥 Fetching content from GitHub...`);
      const content = await this.fetchSkillContent(skillPath);
      console.log(`[AnthropicSkills] ✅ Content fetched, size: ${content.length} bytes`);

      // 2. Parse metadata
      console.log(`[AnthropicSkills] 📋 Parsing metadata...`);
      const metadata = this.parseSkillMetadata(content);
      console.log(`[AnthropicSkills] ✅ Metadata parsed:`, metadata);

      // 3. Ensure local skills directory exists
      await fs.mkdir(LOCAL_SKILLS_DIR, { recursive: true });

      // 4. Save SKILL.md locally
      const fileName = `${skillName}.md`;
      const localPath = path.join(LOCAL_SKILLS_DIR, fileName);
      if (!isInsideLocalSkillsDir(localPath)) {
        throw new Error('Invalid skill name');
      }
      await fs.writeFile(localPath, content, 'utf-8');
      console.log(`[AnthropicSkills] ✅ File saved to: ${localPath}`);

      // 5. Get Anthropic source ID
      const source = await q.one<{ id: string }>(`SELECT id FROM skill_sources WHERE name = 'Anthropic Official'`);

      if (!source) {
        throw new Error('Anthropic source not found in database');
      }
      console.log(`[AnthropicSkills] ✅ Source ID: ${source.id}`);

      // 6. Insert into database
      const category = this.extractCategoryFromPath(skillPath);
      safeConsole.log(`[AnthropicSkills] 💾 Saving to database with category: ${category}`);

      await q.run(`
        INSERT INTO installed_skills (
          source_id, skill_name, display_name, description,
          category, file_path, metadata, is_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(source_id, skill_name)
        DO UPDATE SET
          file_path = excluded.file_path,
          metadata = excluded.metadata`,
        source.id,
        skillName,
        metadata.name,
        metadata.description,
        category,
        localPath,
        JSON.stringify(metadata)
      );

      console.log(`[AnthropicSkills] ✅ Skill installed successfully!`);
      return localPath;
    } catch (error) {
      console.error(`[AnthropicSkills] ❌ Error installing skill ${skillName}:`, error);
      throw error;
    }
  }

  /**
   * Search skills by query
   */
  async searchSkills(query: string): Promise<any[]> {
    // SQLite LIKE ignores ASCII case; ILIKE gives the same match on PostgreSQL.
    const like = q.dialect === 'postgres' ? 'ILIKE' : 'LIKE';
    const skills = await q.all(`
      SELECT * FROM installed_skills
      WHERE skill_name ${like} ?
         OR display_name ${like} ?
         OR description ${like} ?
         OR category ${like} ?
      ORDER BY usage_count DESC, install_date DESC`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`
    );

    return skills;
  }

  /**
   * Get all installed skills
   */
  getInstalledSkills(): Promise<any[]> {
    return q.all(`
      SELECT
        s.*,
        src.name as source_name,
        src.type as source_type
      FROM installed_skills s
      JOIN skill_sources src ON s.source_id = src.id
      WHERE s.is_enabled = 1
      ORDER BY s.category, s.skill_name`);
  }

  /**
   * Uninstall a skill
   */
  async uninstallSkill(skillId: string): Promise<void> {
    // Get skill info
    const skill = await q.one<{ file_path: string }>('SELECT file_path FROM installed_skills WHERE id = ?', skillId);

    if (!skill) {
      throw new Error('Skill not found');
    }

    // Delete local file (only ever inside the local skills directory)
    try {
      if (!isInsideLocalSkillsDir(skill.file_path)) {
        throw new Error('skill file is outside the skills directory');
      }
      await fs.unlink(skill.file_path);
    } catch (error) {
      console.warn(`Failed to delete skill file: ${skill.file_path}`);
    }

    // Delete from database
    await q.run('DELETE FROM installed_skills WHERE id = ?', skillId);
  }

  /**
   * Log skill usage
   */
  async logSkillUsage(skillId: string, userId?: string, agentId?: string, success: boolean = true): Promise<void> {
    await q.run(`
      INSERT INTO skill_usage_log (skill_id, user_id, agent_id, success)
      VALUES (?, ?, ?, ?)`,
      skillId, userId || null, agentId || null, success ? 1 : 0);

    // Increment usage count (last_used is TEXT 'YYYY-MM-DD HH:MM:SS' on both drivers)
    await q.run(`
      UPDATE installed_skills
      SET usage_count = usage_count + 1, last_used = ${nowText(q.dialect)}
      WHERE id = ?`,
      skillId);
  }

  // Helper methods

  private normalizeCategoryName(category: string): string {
    return category.toLowerCase()
      .replace(/[&\s]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private extractCategoryFromPath(skillPath: string): string {
    const parts = skillPath.split('/');
    return parts[1] || 'general';
  }

  /**
   * Get all enabled skills' content for chat system prompt
   */
  async getEnabledSkillsContent(): Promise<string> {
    const enabledSkills = await q.all<{
      skill_name: string;
      display_name: string;
      file_path: string;
      description: string;
    }>(`
      SELECT skill_name, display_name, file_path, description
      FROM installed_skills
      WHERE is_enabled = 1
      ORDER BY category, skill_name`);

    if (enabledSkills.length === 0) {
      return '';
    }

    const skillsContent: string[] = [];

    for (const skill of enabledSkills) {
      try {
        const content = await fs.readFile(skill.file_path, 'utf-8');
        skillsContent.push(`\n# Skill: ${skill.display_name || skill.skill_name}\n${content}\n`);
      } catch (error) {
        console.warn(`Failed to read skill file: ${skill.file_path}`);
      }
    }

    if (skillsContent.length === 0) {
      return '';
    }

    return `\n\n## Available Skills\n\nYou have access to the following specialized skills. Use them when appropriate:\n${skillsContent.join('\n---\n')}`;
  }
}

export const anthropicSkillsService = new AnthropicSkillsService();
