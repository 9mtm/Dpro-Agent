/**
 * Skill Install Tool
 *
 * Allows agents to search skills and list existing installations
 */

import type { ToolResult } from './types.js';
import { anthropicSkillsService } from '../services/anthropic-skills-service.js';

export const skillInstallTool = {
  name: 'skill_install',
  description: `Search available skills and list existing installed skills.
Installation requires a separate exact content review and owner verification.
The legacy install action returns reviewed_install_required and never downloads or installs a skill.`,

  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'install', 'list_installed'],
        description: `Action to perform:
- "search": Search for skills matching a query
- "install": Report the required reviewed installation workflow
- "list_installed": List all currently installed skills`,
      },
      query: {
        type: 'string',
        description:
          'Search query or skill name (required for "search" and "install" actions)',
      },
      skillPath: {
        type: 'string',
        description:
          'GitHub path to the skill (required for "install" action, e.g., "skills/document-skills/pdf")',
      },
    },
    required: ['action'],
  },

  /**
   * Execute the skill install tool
   */
  /**
   * Tool entry point: the registry and its callers read `content` (a
   * ToolResult); the JSON text used to be returned bare, so callers saw no
   * result at all.
   */
  async execute(raw: Record<string, any>): Promise<ToolResult> {
    const text = await this.run(raw as { action: string; query?: string; skillPath?: string });
    let failed: string | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.success === false) failed = String(parsed.error || 'skill_install failed');
    } catch {
      // Not JSON: plain text result.
    }
    return { content: [{ type: 'text', text }], ...(failed ? { error: failed } : {}) };
  },

  /** The tool's work; returns its JSON result as text. */
  async run(input: {
    action: string;
    query?: string;
    skillPath?: string;
  }): Promise<string> {
    try {
      const { action, query, skillPath } = input;

      // 1. SEARCH for skills
      if (action === 'search') {
        if (!query) {
          return JSON.stringify({
            success: false,
            error: 'Query parameter is required for search action',
          });
        }

        // Search in installed skills first
        const installedMatches = await anthropicSkillsService.searchSkills(query);

        if (installedMatches.length > 0) {
          return JSON.stringify({
            success: true,
            action: 'search',
            found: 'installed',
            skills: installedMatches.map((s: any) => ({
              id: s.id,
              name: s.skill_name,
              displayName: s.display_name,
              description: s.description,
              category: s.category,
              alreadyInstalled: true,
            })),
            message: `Found ${installedMatches.length} installed skill(s) matching "${query}"`,
          });
        }

        // Search in Anthropic repository
        const availableSkills = await anthropicSkillsService.fetchAvailableSkills();
        const matches = availableSkills.filter(
          (skill) =>
            skill.name.toLowerCase().includes(query.toLowerCase()) ||
            skill.category.toLowerCase().includes(query.toLowerCase())
        );

        if (matches.length === 0) {
          return JSON.stringify({
            success: false,
            action: 'search',
            message: `No skills found matching "${query}". Try broader search terms.`,
          });
        }

        return JSON.stringify({
          success: true,
          action: 'search',
          found: 'available',
          skills: matches.slice(0, 10).map((s) => ({
            name: s.name,
            category: s.category,
            path: s.path,
            alreadyInstalled: false,
          })),
          message: `Found ${matches.length} available skill(s) matching "${query}". Showing top 10.`,
          hint: 'Installation requires an exact content review and owner verification.',
        });
      }

      // 2. INSTALL a skill
      if (action === 'install') {
        if (!query || !skillPath) {
          return JSON.stringify({
            success: false,
            error: 'Both query (skill name) and skillPath are required for install action',
          });
        }

        return JSON.stringify({
          success: false,
          action: 'install',
          code: 'reviewed_install_required',
          error: 'Skill installation requires an exact content review and owner verification.',
        });
      }

      // 3. LIST installed skills
      if (action === 'list_installed') {
        const installed = await anthropicSkillsService.getInstalledSkills();

        if (installed.length === 0) {
          return JSON.stringify({
            success: true,
            action: 'list_installed',
            skills: [],
            message: 'No skills installed yet. Use action="search" to find skills to install.',
          });
        }

        return JSON.stringify({
          success: true,
          action: 'list_installed',
          skills: installed.map((s: any) => ({
            id: s.id,
            name: s.skill_name,
            displayName: s.display_name,
            description: s.description,
            category: s.category,
            enabled: s.is_enabled === 1,
            usageCount: s.usage_count,
            source: s.source_name,
          })),
          total: installed.length,
          message: `You have ${installed.length} skill(s) installed.`,
        });
      }

      return JSON.stringify({
        success: false,
        error: `Unknown action: ${action}. Valid actions: search, install, list_installed`,
      });
    } catch (error: any) {
      console.error('[skill_install tool] Error:', error);

      return JSON.stringify({
        success: false,
        error: error.message || 'Failed to execute skill_install tool',
      });
    }
  },
};
