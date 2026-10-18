import { centralSkills, SkillLibraryError } from '../../skills/central-store.js';
/**
 * Skills API Routes
 * Manage skills installation, settings, and execution
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSkillsRegistry } from '../../skills/registry.js';
import { getSkillsExecutor } from '../../skills/executor.js';
import { handleError } from '../error-handler.js';
import { anthropicSkillsService } from '../../services/anthropic-skills-service.js';
import { q } from '../../repositories/sql-steps.js';
import {
  authenticateActiveUser,
  authorizeActiveRole,
  OWNER_OR_ADMIN,
} from '../../auth/route-guards.js';
import {
  isValidInstalledSkillId,
  isValidSkillName,
  isValidSkillSourcePath,
} from '../../skills/skill-ids.js';

/**
 * SECURITY (S0-Q.19): every /api/skills* route needs a verified token of an
 * active user. Read-only listing is open to any such user; anything that
 * changes state, writes or deletes files, or runs a skill needs owner/admin.
 */
function requireUser(request: FastifyRequest, reply: FastifyReply): string | null {
  const user = authenticateActiveUser(request);
  if (!user) {
    reply.code(401).send({ success: false, error: 'Authentication required' });
    return null;
  }
  return user.id;
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): string | null {
  return authorizeActiveRole(request, reply, OWNER_OR_ADMIN);
}

function badId(reply: FastifyReply) {
  return reply.status(400).send({ success: false, error: 'Invalid skill id' });
}

export async function skillsRoutes(fastify: FastifyInstance) {
  const skillsRegistry = getSkillsRegistry();
  const skillsExecutor = getSkillsExecutor();

  // POST /api/skills/reload - Reload all skills from disk (F-07)
  // SECURITY: active owner/admin only.
  fastify.post('/api/skills/reload', async (request, reply) => {
    if (authorizeActiveRole(request, reply, OWNER_OR_ADMIN) === null) return reply;
    try {
      await skillsRegistry.reload();
      return { success: true, count: skillsRegistry.getAll().length };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Skills] Reload failed');
    }
  });

  // GET /api/skills - List all skills
  fastify.get('/api/skills', async (request, reply) => {
    if (requireUser(request, reply) === null) return reply;
    try {
      const skills = skillsRegistry.getAll();

      return {
        success: true,
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          source: skill.source,
          description: skill.metadata.description,
          version: skill.metadata.version,
          enabled: skill.enabled,
          triggers: skill.metadata.triggers,
          settings: skill.settingsSchema,
        })),
        stats: {
          total: skills.length,
          enabled: skills.filter((s) => s.enabled).length,
          bundled: skills.filter((s) => s.source === 'bundled').length,
          managed: skills.filter((s) => s.source === 'managed').length,
          workspace: skills.filter((s) => s.source === 'workspace').length,
        },
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ List failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] List failed');
    }
  });

  // GET /api/skills/:id - Get skill details
  fastify.get<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    if (requireUser(request, reply) === null) return reply;
    try {
      const { id } = request.params;
      if (!isValidSkillName(id)) return badId(reply);
      const skill = skillsRegistry.get(id);

      if (!skill) {
        return reply.status(404).send({
          success: false,
          error: 'Skill not found',
        });
      }

      return {
        success: true,
        skill: {
          id: skill.id,
          name: skill.name,
          source: skill.source,
          enabled: skill.enabled,
          metadata: skill.metadata,
          instructions: skill.instructions,
          settingsSchema: skill.settingsSchema,
        },
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ Get failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] Get failed');
    }
  });

  // POST /api/skills/install - Install new skill from file
  fastify.post<{ Body: { content: string; name: string; source: 'managed' | 'workspace' } }>(
    '/api/skills/install',
    async (request, reply) => {
      if (requireAdmin(request, reply) === null) return reply;
      try {
        const { content, name, source } = request.body || ({} as any);
        if (!isValidSkillName(name)) return badId(reply);
        if (source !== 'managed' && source !== 'workspace') {
          return reply.status(400).send({ success: false, error: 'Invalid source' });
        }
        if (typeof content !== 'string' || content.length === 0 || content.length > 200_000) {
          return reply.status(400).send({ success: false, error: 'Invalid content' });
        }

        const result=await centralSkills().installMarkdown(content,name,source);
        return {success:true,message:result.duplicate?'Skill already installed':`Skill "${name}" saved to central library`,source,skill:result.skill,duplicate:result.duplicate};
      } catch (error: any) {
        if(error instanceof SkillLibraryError)return reply.code(error.status).send({success:false,code:error.code});
        console.error('[Skills API] Install failed');
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Skills] Install failed');
      }
    }
  );

  // PUT /api/skills/:id/settings - Update skill settings
  fastify.put<{
    Params: { id: string };
    Body: { settings: Record<string, any> };
  }>('/api/skills/:id/settings', async (request, reply) => {
    if (requireAdmin(request, reply) === null) return reply;
    try {
      const { id } = request.params;
      if (!isValidSkillName(id)) return badId(reply);

      const skill = skillsRegistry.get(id);

      if (!skill) {
        return reply.status(404).send({
          success: false,
          error: 'Skill not found',
        });
      }

      // TODO: Validate settings against schema
      // TODO: Encrypt secrets if any
      // TODO: Save to database

      return {
        success: true,
        message: `Settings for "${skill.name}" updated`,
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ Settings update failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] Settings update failed');
    }
  });

  // POST /api/skills/:id/enable - Enable skill
  fastify.post<{ Params: { id: string } }>('/api/skills/:id/enable', async (request, reply) => {
    if (requireAdmin(request, reply) === null) return reply;
    try {
      const { id } = request.params;
      if (!isValidSkillName(id)) return badId(reply);
      if (!skillsRegistry.get(id)) {
        return reply.status(404).send({ success: false, error: 'Skill not found' });
      }

      skillsRegistry.enable(id);

      return {
        success: true,
        message: `Skill enabled`,
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ Enable failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] Enable failed');
    }
  });

  // POST /api/skills/:id/disable - Disable skill
  fastify.post<{ Params: { id: string } }>('/api/skills/:id/disable', async (request, reply) => {
    if (requireAdmin(request, reply) === null) return reply;
    try {
      const { id } = request.params;
      if (!isValidSkillName(id)) return badId(reply);
      if (!skillsRegistry.get(id)) {
        return reply.status(404).send({ success: false, error: 'Skill not found' });
      }

      skillsRegistry.disable(id);

      return {
        success: true,
        message: `Skill disabled`,
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ Disable failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] Disable failed');
    }
  });

  // DELETE /api/skills/:id - Uninstall skill
  fastify.delete<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    if (requireAdmin(request, reply) === null) return reply;
    try {
      const { id } = request.params;
      if (!isValidSkillName(id)) return badId(reply);

      const skill = skillsRegistry.get(id);

      if (!skill) {
        return reply.status(404).send({
          success: false,
          error: 'Skill not found',
        });
      }

      if (skill.source === 'bundled') {
        return reply.status(400).send({
          success: false,
          error: 'Cannot uninstall bundled skills',
        });
      }

      // TODO: Delete skill file
      // TODO: Registry will auto-reload via file watcher

      return {
        success: true,
        message: `Skill "${skill.name}" uninstalled`,
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ Uninstall failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] Uninstall failed');
    }
  });

  // POST /api/skills/:id/execute - Execute skill (for testing)
  fastify.post<{
    Params: { id: string };
    Body: { message: string; settings?: Record<string, any> };
  }>('/api/skills/:id/execute', async (request, reply) => {
    const userId = requireAdmin(request, reply);
    if (userId === null) return reply;
    try {
      const { id } = request.params;
      if (!isValidSkillName(id)) return badId(reply);
      const { message, settings } = request.body || ({} as any);
      if (typeof message !== 'string' || message.length === 0) {
        return reply.status(400).send({ success: false, error: 'message is required' });
      }

      const result = await skillsExecutor.execute(id, {
        message,
        settings: settings && typeof settings === 'object' ? settings : {},
        userId,
        channelId: 'test-channel',
      });

      return {
        success: result.success,
        output: result.output,
        data: result.data,
        error: result.error,
      };
    } catch (error: any) {
      console.error('[Skills API] ❌ Execute failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Skills] Execute failed');
    }
  });

  // GET /api/skills/match - Find skills matching message
  fastify.get<{ Querystring: { message: string } }>(
    '/api/skills/match',
    async (request, reply) => {
      if (requireUser(request, reply) === null) return reply;
      try {
        const { message } = request.query;

        if (!message) {
          return reply.status(400).send({
            success: false,
            error: 'Message parameter required',
          });
        }

        const matchingSkills = skillsExecutor.findMatchingSkills(message);

        return {
          success: true,
          matches: matchingSkills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.metadata.description,
            triggers: skill.metadata.triggers,
          })),
        };
      } catch (error: any) {
        console.error('[Skills API] ❌ Match failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Skills] Match failed');
      }
    }
  );

  // ========================================
  // MARKETPLACE ROUTES - Anthropic Skills
  // ========================================

  // GET /api/skills/marketplace/sources - List skill sources
  fastify.get('/api/skills/marketplace/sources', async (request, reply) => {
    if (requireUser(request, reply) === null) return reply;
    try {
      const sources = await q.all(`
        SELECT * FROM skill_sources
        WHERE is_enabled = 1
        ORDER BY priority DESC, name`);

      return { success: true, sources };
    } catch (error: any) {
      console.error('[Skills Marketplace] ❌ Sources failed:', error);
      return handleError(reply, error, 'internal', '[Skills Marketplace] Sources failed');
    }
  });

  // GET /api/skills/marketplace/available - Fetch available skills from Anthropic
  fastify.get('/api/skills/marketplace/available', async (request, reply) => {
    if (requireUser(request, reply) === null) return reply;
    try {
      console.log('[Skills Marketplace] 📥 Fetching available skills from Anthropic...');
      const skills = await anthropicSkillsService.fetchAvailableSkills();
      console.log(`[Skills Marketplace] ✅ Fetched ${skills.length} skills`);

      return { success: true, skills, count: skills.length };
    } catch (error: any) {
      // SECURITY: never echo error.message (H-09); details stay in the server log.
      return handleError(reply, error, 'internal', '[Skills Marketplace] Fetch available failed');
    }
  });

  // GET /api/skills/marketplace/installed - List installed marketplace skills
  fastify.get('/api/skills/marketplace/installed', async (request, reply) => {
    if (requireUser(request, reply) === null) return reply;
    try {
      const skills = await anthropicSkillsService.getInstalledSkills();

      return { success: true, skills, count: skills.length };
    } catch (error: any) {
      console.error('[Skills Marketplace] ❌ List installed failed:', error);
      return handleError(
        reply,
        error,
        'internal',
        '[Skills Marketplace] List installed failed'
      );
    }
  });

  // POST /api/skills/marketplace/install - Install skill from Anthropic
  fastify.post<{ Body: { skillName: string; skillPath: string } }>(
    '/api/skills/marketplace/install',
    async (request, reply) => {
      if (requireAdmin(request, reply) === null) return reply;
      try {
        const { skillName, skillPath } = request.body || ({} as any);

        console.log('[Skills Marketplace] 📥 Install request:', { skillName, skillPath });

        if (!skillName || !skillPath) {
          console.error('[Skills Marketplace] ❌ Missing parameters:', { skillName, skillPath });
          return reply.status(400).send({
            success: false,
            error: 'skillName and skillPath are required',
          });
        }
        // SECURITY: the name becomes a local file name and the path a repo path.
        if (!isValidSkillName(skillName) || !isValidSkillSourcePath(skillPath)) {
          return reply.status(400).send({ success: false, error: 'Invalid skillName or skillPath' });
        }

        const localPath = await anthropicSkillsService.installSkill(skillName, skillPath);

        console.log('[Skills Marketplace] ✅ Skill installed:', { skillName, localPath });

        return {
          success: true,
          message: `Skill "${skillName}" installed successfully`,
          localPath,
        };
      } catch (error: any) {
        // SECURITY: never echo error.message (H-09); details stay in the server log.
        return handleError(reply, error, 'internal', '[Skills Marketplace] Install failed');
      }
    }
  );

  // DELETE /api/skills/marketplace/:skillId - Uninstall marketplace skill
  fastify.delete<{ Params: { skillId: string } }>(
    '/api/skills/marketplace/:skillId',
    async (request, reply) => {
      if (requireAdmin(request, reply) === null) return reply;
      try {
        const { skillId } = request.params;
        if (!isValidInstalledSkillId(skillId)) return badId(reply);

        await anthropicSkillsService.uninstallSkill(skillId);

        return {
          success: true,
          message: 'Skill uninstalled successfully',
        };
      } catch (error: any) {
        console.error('[Skills Marketplace] ❌ Uninstall failed:', error);
        return handleError(reply, error, 'internal', '[Skills Marketplace] Uninstall failed');
      }
    }
  );

  // GET /api/skills/marketplace/search - Search marketplace skills
  fastify.get<{ Querystring: { q: string } }>(
    '/api/skills/marketplace/search',
    async (request, reply) => {
      if (requireUser(request, reply) === null) return reply;
      try {
        const { q } = request.query;

        if (!q) {
          return reply.status(400).send({
            success: false,
            error: 'Query parameter "q" is required',
          });
        }

        const skills = await anthropicSkillsService.searchSkills(q);

        return { success: true, skills, count: skills.length };
      } catch (error: any) {
        console.error('[Skills Marketplace] ❌ Search failed:', error);
        return handleError(reply, error, 'internal', '[Skills Marketplace] Search failed');
      }
    }
  );

  // GET /api/skills/marketplace/stats - Get marketplace statistics
  fastify.get('/api/skills/marketplace/stats', async (request, reply) => {
    if (requireUser(request, reply) === null) return reply;
    try {
      const stats = {
        totalInstalled: await q.one<{ count: number }>(`SELECT COUNT(*) as count FROM installed_skills`),
        enabled: await q.one<{ count: number }>(`SELECT COUNT(*) as count FROM installed_skills WHERE is_enabled = 1`),
        byCategory: await q.all(`
          SELECT category, COUNT(*) as count
          FROM installed_skills
          GROUP BY category
          ORDER BY count DESC`),
        mostUsed: await q.all(`
          SELECT skill_name, display_name, usage_count
          FROM installed_skills
          ORDER BY usage_count DESC
          LIMIT 5`),
      };

      return { success: true, stats };
    } catch (error: any) {
      console.error('[Skills Marketplace] ❌ Stats failed:', error);
      return handleError(reply, error, 'internal', '[Skills Marketplace] Stats failed');
    }
  });

  // PUT /api/skills/marketplace/:skillId/toggle - Enable/disable marketplace skill
  fastify.put<{ Params: { skillId: string } }>(
    '/api/skills/marketplace/:skillId/toggle',
    async (request, reply) => {
      if (requireAdmin(request, reply) === null) return reply;
      try {
        const { skillId } = request.params;
        if (!isValidInstalledSkillId(skillId)) return badId(reply);
        // Toggle is_enabled and read the new value in one statement (no
        // read-after-write race between two concurrent toggles).
        const skill = await q.one<{ is_enabled: number }>(`
        UPDATE installed_skills
        SET is_enabled = CASE WHEN is_enabled = 1 THEN 0 ELSE 1 END
        WHERE id = ?
        RETURNING is_enabled`,
          skillId);

        return {
          success: true,
          enabled: skill?.is_enabled === 1,
        };
      } catch (error: any) {
        console.error('[Skills Marketplace] ❌ Toggle failed:', error);
        return handleError(reply, error, 'internal', '[Skills Marketplace] Toggle failed');
      }
    }
  );

  console.log('[Skills API] ✅ Routes registered (including Marketplace)');
}
