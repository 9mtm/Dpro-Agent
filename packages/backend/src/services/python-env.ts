/**
 * Python Environment Manager
 *
 * Centralized module for resolving and spawning the correct Python executable.
 * Checks for an embedded portable Python first (in .data/python/),
 * then falls back to a system-installed Python.
 *
 * This replaces the duplicated getPythonCommand() functions that were
 * scattered across audio-service.ts and desktop.ts.
 */

import { dataPath } from '../config/data-root.js';
import path from 'path';
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from 'child_process';

// ─── Constants ───────────────────────────────────────────────────────────────

// Bundled scripts are independent of the selected writable data workspace.
export const PYTHON_SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'python-scripts');
const DATA_DIR = dataPath('python');
const SETUP_FLAG = path.join(DATA_DIR, '.setup-complete');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PythonEnvStatus {
  installed: boolean;
  version: string | null;
  pythonPath: string | null;
  source: 'embedded' | 'venv' | 'system' | 'none';
  setupComplete: boolean;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let _resolvedPythonPath: string | null = null;
let _resolvedPlatformDir: string | null = null;
let _resolvedSource: PythonEnvStatus['source'] = 'none';

// ─── Path Resolution ─────────────────────────────────────────────────────────

/**
 * Find the embedded Python directory for Windows.
 * Scans .data/python/win32/ for extracted embeddable distributions.
 */
function findEmbeddedWindows(): string | null {
  const win32Dir = path.join(DATA_DIR, 'win32');
  if (!fs.existsSync(win32Dir)) return null;

  try {
    const entries = fs.readdirSync(win32Dir);
    // Look for directories like "python-3.12.8-embed-amd64"
    const pythonDir = entries.find(
      (e) => e.startsWith('python-') && e.includes('embed') &&
             fs.statSync(path.join(win32Dir, e)).isDirectory()
    );
    if (pythonDir) {
      const exe = path.join(win32Dir, pythonDir, 'python.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // Directory read failed — skip
  }
  return null;
}

/**
 * Find the venv Python for Linux/Mac.
 */
function findVenvUnix(): string | null {
  const platKey = process.platform === 'darwin' ? 'darwin' : 'linux';
  const venvPython = path.join(DATA_DIR, platKey, 'venv', 'bin', 'python3');
  return fs.existsSync(venvPython) ? venvPython : null;
}

/**
 * Find a working system Python as fallback.
 * Tries full paths first (avoids py launcher shebang issues on Windows).
 */
function findSystemPython(): string | null {
  if (process.platform !== 'win32') {
    // Linux/Mac: just try python3
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore', timeout: 2000 });
      return 'python3';
    } catch {
      return null;
    }
  }

  // Windows: try full paths first, then generic commands
  const localApp = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    path.join(localApp, 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(localApp, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localApp, 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(localApp, 'Programs', 'Python', 'Python310', 'python.exe'),
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
    'C:\\Python310\\python.exe',
    'python',
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return candidate;
    } catch {
      // Try next
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the best available Python executable.
 * Priority: embedded/venv > system Python.
 * Result is cached after first resolution.
 */
export function getPythonPath(): string {
  if (_resolvedPythonPath) return _resolvedPythonPath;

  // 1. Check embedded / venv
  if (process.platform === 'win32') {
    const embedded = findEmbeddedWindows();
    if (embedded) {
      _resolvedPythonPath = embedded;
      _resolvedPlatformDir = path.dirname(embedded);
      _resolvedSource = 'embedded';
      return embedded;
    }
  } else {
    const venv = findVenvUnix();
    if (venv) {
      _resolvedPythonPath = venv;
      _resolvedPlatformDir = path.resolve(path.dirname(venv), '..');
      _resolvedSource = 'venv';
      return venv;
    }
  }

  // 2. Fall back to system Python
  const system = findSystemPython();
  if (system) {
    _resolvedPythonPath = system;
    _resolvedPlatformDir = null;
    _resolvedSource = 'system';
    return system;
  }

  // 3. Last resort
  _resolvedPythonPath = 'python';
  _resolvedSource = 'none';
  return 'python';
}

/**
 * Returns environment variables for spawning Python processes.
 * Sets PYTHONIOENCODING and adjusts PATH for embedded/venv.
 */
export function getPythonSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Ensure path is resolved
  getPythonPath();

  const env: NodeJS.ProcessEnv = { ...baseEnv, PYTHONIOENCODING: 'utf-8' };

  if (process.platform === 'win32' && _resolvedSource === 'embedded' && _resolvedPlatformDir) {
    // For embeddable: add python dir and Scripts to PATH
    const scriptsDir = path.join(_resolvedPlatformDir, 'Scripts');
    env.PATH = `${_resolvedPlatformDir};${scriptsDir};${env.PATH || ''}`;
    // Do NOT set PYTHONHOME — the ._pth file handles path resolution
  } else if (_resolvedSource === 'venv' && _resolvedPlatformDir) {
    // For venv: set VIRTUAL_ENV and adjust PATH
    env.VIRTUAL_ENV = _resolvedPlatformDir;
    const binDir = path.join(_resolvedPlatformDir, 'bin');
    env.PATH = `${binDir}:${env.PATH || ''}`;
  }

  return env;
}

/**
 * Spawn a Python script with the correct executable and environment.
 * Drop-in replacement for child_process.spawn().
 *
 * `baseEnv` replaces process.env as the starting environment; agent tools
 * pass minimalChildEnv() so the child never sees server secrets.
 */
export function spawnPython(
  scriptPath: string,
  args: string[] = [],
  extraOptions?: SpawnOptions & { baseEnv?: NodeJS.ProcessEnv }
): ChildProcess {
  const pythonPath = getPythonPath();
  const { baseEnv, ...spawnOptions } = extraOptions ?? {};
  const env = getPythonSpawnEnv(baseEnv);

  return spawn(pythonPath, [scriptPath, ...args], {
    env,
    ...spawnOptions,
  });
}

/**
 * Check if the portable Python setup has been completed.
 */
export function isSetupComplete(): boolean {
  return fs.existsSync(SETUP_FLAG);
}

/**
 * Get the current Python environment status.
 */
export function getStatus(): PythonEnvStatus {
  const pythonPath = getPythonPath();

  let version: string | null = null;
  try {
    version = execFileSync(pythonPath, ['--version'], { timeout: 3000 })
      .toString()
      .trim()
      .replace('Python ', '');
  } catch {
    // Could not get version
  }

  return {
    installed: _resolvedSource !== 'none',
    version,
    pythonPath: _resolvedPythonPath,
    source: _resolvedSource,
    setupComplete: isSetupComplete(),
  };
}

/**
 * Clear the cached Python path (useful after running setup).
 */
export function clearCache(): void {
  _resolvedPythonPath = null;
  _resolvedPlatformDir = null;
  _resolvedSource = 'none';
}
