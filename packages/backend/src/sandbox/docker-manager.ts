import { safeConsole } from '../services/safe-error-log.js';
/**
 * Docker Manager
 * Manages Docker containers for sandboxed execution
 */

import { execFile, spawn, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import type { DockerConfig, SandboxSession, SandboxConfig } from './types.js';

const execFileAsync = promisify(execFile);
type DockerCommand = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
const runDockerCommand: DockerCommand = (args, options = {}) => execFileAsync('docker', args, { ...options, encoding: 'utf8' });
const validImage = (image: string) => typeof image === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/.test(image);

export class DockerManager {
  constructor(private readonly runCommand: DockerCommand = runDockerCommand) {}

  private sessions: Map<string, SandboxSession> = new Map();
  private dockerAvailable: boolean | null = null;

  /**
   * Check if Docker is available
   */
  async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) {
      return this.dockerAvailable;
    }

    try {
      await this.runCommand(['--version']);
      await this.runCommand(['info']);
      this.dockerAvailable = true;
      console.log('[Sandbox] Docker is available');
      return true;
    } catch (error) {
      this.dockerAvailable = false;
      console.warn('[Sandbox] Docker is not available, sandboxing disabled');
      return false;
    }
  }

  /**
   * Pull Docker image if not exists
   */
  async ensureImage(image: string): Promise<boolean> {
    if (!validImage(image)) return false;
    try {
      // Check if image exists locally
      const { stdout } = await this.runCommand(['images', '-q', '--', image]);
      if (stdout.trim()) {
        return true;
      }

      // Pull image
      safeConsole.log(`[Sandbox] Pulling image: ${image}`);
      await this.runCommand(['pull', '--', image], { timeout: 300000 }); // 5 min timeout
      safeConsole.log(`[Sandbox] Image pulled: ${image}`);
      return true;
    } catch (error) {
      safeConsole.error(`[Sandbox] Failed to pull image ${image}:`, error);
      return false;
    }
  }

  /**
   * Create a new sandbox session (container)
   */
  async createSession(config: SandboxConfig, agentId?: string): Promise<SandboxSession> {
    if (!validImage(config.docker.image)) throw new Error('Invalid Docker image reference');
    const sessionId = uuid();
    const containerName = `sandbox-${sessionId.slice(0, 8)}`;

    // Build docker run command
    const dockerArgs = this.buildDockerArgs(config.docker, containerName);

    try {
      // Create container (don't start yet)
      const { stdout } = await this.runCommand(['create', ...dockerArgs, '--', config.docker.image, 'tail', '-f', '/dev/null']);
      const containerId = stdout.trim();
      if (!/^[a-f0-9]{12,64}$/i.test(containerId)) throw new Error('Invalid Docker container identifier');

      // Start container
      await this.runCommand(['start', '--', containerId]);

      const session: SandboxSession = {
        id: sessionId,
        containerId,
        containerName,
        status: 'running',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        agentId,
        config,
      };

      this.sessions.set(sessionId, session);
      console.log(`[Sandbox] Created session: ${sessionId} (container: ${containerId.slice(0, 12)})`);

      return session;
    } catch (error) {
      console.error('[Sandbox] Failed to create session:', error);
      throw new Error(`Failed to create sandbox session: ${error}`);
    }
  }

  /**
   * Build Docker run arguments
   */
  private buildDockerArgs(config: DockerConfig, containerName: string): string[] {
    const args: string[] = [
      '--name', containerName,
      '--rm=false', // Don't auto-remove, we manage lifecycle
    ];

    // Network
    args.push('--network', config.network);

    // Working directory
    args.push('-w', config.workDir);

    // Volume binds
    if (config.binds) {
      for (const bind of config.binds) {
        args.push('-v', bind);
      }
    }

    // Environment variables
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // User
    if (config.user) {
      args.push('-u', config.user);
    }

    // Security options
    args.push('--security-opt', 'no-new-privileges');
    args.push('--cap-drop', 'ALL');

    return args;
  }

  /**
   * Execute command in sandbox
   */
  async execute(
    sessionId: string,
    command: string,
    options: {
      timeout?: number;
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
    } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; duration: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'running') {
      throw new Error(`Session not running: ${sessionId}`);
    }

    const startTime = Date.now();

    // Build exec command
    const execArgs: string[] = ['exec'];

    // Working directory
    if (options.cwd) {
      execArgs.push('-w', options.cwd);
    }

    // Environment
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        execArgs.push('-e', `${key}=${value}`);
      }
    }

    // Interactive if stdin provided
    if (options.stdin) {
      execArgs.push('-i');
    }

    execArgs.push('--', session.containerId);
    execArgs.push('sh', '-c', command);

    return new Promise((resolve, reject) => {
      const timeout = options.timeout || session.config.timeout;
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn('docker', execArgs, {
        timeout,
      });

      // Handle stdin
      if (options.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      }

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;

        // Update session activity
        session.lastActivityAt = new Date();

        if (timedOut) {
          resolve({
            exitCode: 124,
            stdout,
            stderr: stderr + '\n[Sandbox] Command timed out',
            duration,
          });
        } else {
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            duration,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }

  /**
   * Stop and remove a session
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      // Stop container
      await this.runCommand(['stop', '--', session.containerId], { timeout: 10000 });
    } catch {
      // Force kill if stop fails
      try {
        await this.runCommand(['kill', '--', session.containerId]);
      } catch {
        // Ignore
      }
    }

    try {
      // Remove container
      await this.runCommand(['rm', '-f', '--', session.containerId]);
    } catch {
      // Ignore
    }

    session.status = 'stopped';
    this.sessions.delete(sessionId);
    safeConsole.log(`[Sandbox] Destroyed session: ${sessionId}`);
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SandboxSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running');
  }

  /**
   * Cleanup all sessions
   */
  async cleanup(): Promise<void> {
    console.log('[Sandbox] Cleaning up all sessions...');
    const sessions = Array.from(this.sessions.keys());
    for (const sessionId of sessions) {
      await this.destroySession(sessionId);
    }
    console.log('[Sandbox] Cleanup complete');
  }

  /**
   * Cleanup stale sessions (inactive for too long)
   */
  async cleanupStale(maxIdleMs: number = 3600000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      const idle = now - session.lastActivityAt.getTime();
      if (idle > maxIdleMs) {
        await this.destroySession(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Sandbox] Cleaned up ${cleaned} stale sessions`);
    }

    return cleaned;
  }
}

// Singleton instance
let dockerManager: DockerManager | null = null;

export function getDockerManager(): DockerManager {
  if (!dockerManager) {
    dockerManager = new DockerManager();
  }
  return dockerManager;
}
