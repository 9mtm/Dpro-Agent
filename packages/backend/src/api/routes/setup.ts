import { dataPath, dataRoot } from '../../config/data-root.js';
import { validSetupEmail } from '../../auth/setup-input.js';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { lockName, one, q, run, sql } from '../../repositories/sql-steps.js';
import { nowTs } from '../../db/pg/dialect.js';
import bcrypt from 'bcryptjs';
import { OWNER_EXISTS_SQL, isPublishedDefaultPassword } from '../../auth/default-accounts.js';
import { sendInternalError } from '../error-handler.js';
import { safeErrorFields } from '../../services/safe-error-log.js';
import { checkSetupToken, consumeSetupToken, isLoopbackPeer } from '../../auth/setup-token.js';

const execAsync = promisify(exec);

const SETUP_FLAG_FILE = dataPath('.setup_complete');

/** True once a real owner/admin account exists (system accounts excluded). B2.2c: process driver. */
async function ownerExists(): Promise<boolean> {
  return Boolean(await q.one(OWNER_EXISTS_SQL));
}

/** Like ownerExists(), but false when the database is not usable yet. */
async function ownerExistsSafe(): Promise<boolean> {
  try {
    return await ownerExists();
  } catch {
    return false;
  }
}

/**
 * F-01: setup counts as done once the flag file exists OR an owner account
 * exists. Installs created by older code have an owner but never wrote the
 * flag; they must go to login, not to a wizard that can no longer create one.
 */
async function isSetupDone(): Promise<boolean> {
  return existsSync(SETUP_FLAG_FILE) || (await ownerExistsSafe());
}

/**
 * First-run state for the read-only stage (api/read-only-stage.ts). Rejects
 * when the database is unusable; the stage then fails closed.
 */
export async function setupStateForReadOnlyStage(): Promise<{ ownerExists: boolean; setupComplete: boolean }> {
  return { ownerExists: await ownerExists(), setupComplete: existsSync(SETUP_FLAG_FILE) };
}

// SECURITY (S0-Q.2): setup steps that change the system only run before setup is complete.
const SETUP_ONLY_ROUTES = new Set(['/api/setup/check', '/api/setup/database', '/api/setup/python', '/api/setup/complete']);

export default async function setupRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions?.url;
    if (!route || !SETUP_ONLY_ROUTES.has(route)) return;
    // /complete only needs the flag check: it is the step right after the owner
    // is created (and refuses without an owner). The other steps also lock as
    // soon as an owner exists.
    const locked = route === '/api/setup/complete' ? existsSync(SETUP_FLAG_FILE) : await isSetupDone();
    if (locked) {
      return reply.status(403).send({ error: 'Setup already completed' });
    }
  });

  // Check if setup is already complete
  fastify.get('/api/setup/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const isSetupComplete = await isSetupDone();

    return reply.send({
      setupComplete: isSetupComplete,
      setupRequired: !isSetupComplete,
      message: isSetupComplete ? 'Setup already completed' : 'Setup required'
    });
  });

  // Check system requirements
  fastify.get('/api/setup/check', async (request: FastifyRequest, reply: FastifyReply) => {
    const checks = {
      node: false,
      python: false,
      ports: false,
      directories: false
    };

    try {
      // Check Node.js
      try {
        const { stdout } = await execAsync('node --version');
        checks.node = stdout.trim().length > 0;
      } catch (error) {
        console.error('[Setup] Node.js check failed', safeErrorFields(error));
      }

      // Check Python (uses centralized python-env for portable/system detection)
      try {
        const { getStatus } = await import('../../services/python-env.js');
        const pyStatus = getStatus();
        checks.python = pyStatus.installed;
        (checks as any).pythonVersion = pyStatus.version;
        (checks as any).pythonSource = pyStatus.source;
        (checks as any).pythonSetupComplete = pyStatus.setupComplete;
      } catch (error) {
        console.error('[Setup] Python check failed', safeErrorFields(error));
        checks.python = false;
      }

      // Check ports (assume available - actual port binding will fail if not)
      checks.ports = true;

      // Check/create required directories
      try {
        const dataDir = dataRoot();
        if (!existsSync(dataDir)) {
          mkdirSync(dataDir, { recursive: true });
        }

        const requiredDirs = [
          'storage',
          'storage/cache',
          'storage/cdn',
          'backups',
          'agents',
          'audit',
          'encryption',
          'multi-agent',
          'webhooks'
        ];

        for (const dir of requiredDirs) {
          const fullPath = join(dataDir, dir);
          if (!existsSync(fullPath)) {
            mkdirSync(fullPath, { recursive: true });
          }
        }

        checks.directories = true;
      } catch (error) {
        console.error('[Setup] directory creation failed', safeErrorFields(error));
      }

      return reply.send(checks);
    } catch (error: any) {
      return sendInternalError(reply, '[Setup] GET /api/setup/check', error);
    }
  });

  // Initialize database and run migrations
  fastify.post('/api/setup/database', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dataDir = dataRoot();

      // Ensure .data directory exists
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      // Verify the database is working (process driver; migrations ran at startup)
      const result = await q.one<{ test: number }>('SELECT 1 as test');

      if (!result || result.test !== 1) {
        throw new Error('Database initialization failed');
      }

      return reply.send({
        success: true,
        message: 'Database initialized successfully'
      });
    } catch (error: any) {
      return sendInternalError(reply, '[Setup] POST /api/setup/database', error);
    }
  });

  // Create the first owner (INSTALLER-07): only from this machine and only
  // with the one-time setup token from `agent-player setup` / `start`.
  fastify.post<{
    Body: {
      name: string;
      email: string;
      password: string;
      setupToken?: string;
    };
  }>('/api/setup/admin', async (request: FastifyRequest<{
    Body: {
      name: string;
      email: string;
      password: string;
      setupToken?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      // The socket peer, never X-Forwarded-For: a reverse proxy on this
      // machine would still count as loopback, so the token stays required.
      if (!isLoopbackPeer(request.raw.socket?.remoteAddress)) {
        return reply.status(403).send({
          error: 'Forbidden',
          code: 'setup_not_local',
          message: 'The owner can only be created on the installation computer'
        });
      }

      // SECURITY (S0-Q.2): only the very first owner can be created here
      if (await ownerExists()) {
        return reply.status(403).send({
          error: 'Setup already completed',
          code: 'setup_complete',
          message: 'An owner account already exists'
        });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const token = checkSetupToken(body.setupToken);
      if (token !== 'ok') {
        return reply.status(403).send({
          error: 'Forbidden',
          code: token === 'missing' ? 'setup_token_missing' : token === 'expired' ? 'setup_token_expired' : 'setup_token_invalid',
          message: 'A valid setup code from `agent-player setup` on this computer is required'
        });
      }

      const { name, email, password } = body;

      // Validate input
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' || !name.trim() || !email || !password) {
        return reply.status(400).send({
          error: 'Missing required fields',
          code: 'missing_fields',
          message: 'Name, email, and password are required'
        });
      }

      if (password.length < 12 || isPublishedDefaultPassword(password)) {
        return reply.status(400).send({
          error: 'Invalid password',
          code: 'weak_password',
          message: 'Password must be at least 12 characters long (include uppercase, lowercase, number, special character)'
        });
      }

      // Email validation
      if (!validSetupEmail(email)) {
        return reply.status(400).send({
          error: 'Invalid email',
          code: 'invalid_email',
          message: 'Please provide a valid email address'
        });
      }

      // Check if user already exists
      const existingUser = await q.one('SELECT id FROM users WHERE email = ?', email);
      if (existingUser) {
        return reply.status(409).send({
          error: 'User exists',
          code: 'user_exists',
          message: 'An account with this email already exists'
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Generate user ID
      const userId = Date.now().toString();

      // Create username from email
      const username = email.split('@')[0];

      // Create the owner with active status and verified email.
      // Re-check inside one transaction so two parallel requests cannot both
      // create an owner (PostgreSQL: under a transaction-scoped lock on the name).
      const created = await sql().tx(function* () {
        yield* lockName('setup:first-owner');
        if (yield* one(OWNER_EXISTS_SQL)) return false;
        // users.created_at / updated_at are DATETIME columns: CURRENT_TIMESTAMP
        // gives the same 'YYYY-MM-DD HH:MM:SS' (UTC) value as datetime('now').
        yield* run(`
          INSERT INTO users (id, email, username, password_hash, full_name, role, status, email_verified, created_at, updated_at, token_version)
          VALUES (?, ?, ?, ?, ?, 'owner', 'active', 1, ${nowTs(sql().dialect)}, ${nowTs(sql().dialect)}, 1)
        `, userId, email, username, passwordHash, name);
        return true;
      }, { immediate: true });

      if (!created) {
        return reply.status(403).send({
          error: 'Setup already completed',
          code: 'setup_complete',
          message: 'An owner account already exists'
        });
      }

      // One use only: the owner exists now, so the token is gone.
      try {
        consumeSetupToken();
      } catch (error) {
        console.error('[Setup] could not remove the used setup token', safeErrorFields(error));
      }

      return reply.send({
        success: true,
        message: 'Owner account created successfully',
        user: {
          id: userId,
          name,
          email
        }
      });
    } catch (error: any) {
      return sendInternalError(reply, '[Setup] POST /api/setup/admin', error);
    }
  });

  // Mark setup as complete
  fastify.post('/api/setup/complete', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dataDir = dataRoot();

      // Ensure .data directory exists
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      if (!(await ownerExists())) {
        return reply.status(400).send({
          error: 'Owner account required',
          message: 'Create the owner account before completing setup'
        });
      }

      // Create setup complete flag file
      const setupData = {
        completedAt: new Date().toISOString(),
        version: '1.3.0'
      };

      writeFileSync(SETUP_FLAG_FILE, JSON.stringify(setupData, null, 2));

      return reply.send({
        success: true,
        message: 'Setup completed successfully'
      });
    } catch (error: any) {
      return sendInternalError(reply, '[Setup] POST /api/setup/complete', error);
    }
  });

  // Install portable Python environment
  fastify.post('/api/setup/python', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { setupPythonEnvironment } = await import('../../services/python-setup.js');
      await setupPythonEnvironment();
      return reply.send({
        success: true,
        message: 'Python environment installed successfully'
      });
    } catch (error: any) {
      return sendInternalError(reply, '[Setup] POST /api/setup/python', error);
    }
  });
}
