import { safeConsole } from './safe-error-log.js';
/**
 * Python Environment Setup
 *
 * Downloads and configures a portable Python environment for Agent Player.
 * - Windows: Downloads Python embeddable ZIP from python.org (no install needed)
 * - Linux/Mac: Creates a venv from system python3
 *
 * Usage: npm run setup:python
 */

import { dataPath } from '../config/data-root.js';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { extractPythonArchive } from './python-archive.js';
import { clearCache, PYTHON_SCRIPTS_DIR } from './python-env.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const PYTHON_VERSION = process.env.PYTHON_EMBED_VERSION || '3.12.8';

const DATA_DIR = dataPath('python');
const SETUP_FLAG = path.join(DATA_DIR, '.setup-complete');
const REQUIREMENTS_PATH = path.join(PYTHON_SCRIPTS_DIR, 'requirements.txt');

// Python embeddable ZIP URLs by platform/arch
function getEmbeddableUrl(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${arch}.zip`;
}

function getEmbeddableDirName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `python-${PYTHON_VERSION}-embed-${arch}`;
}

const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

// ─── Download Helper ─────────────────────────────────────────────────────────

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const doRequest = (currentUrl: string, redirects = 0) => {
      if (redirects > 5) {
        fs.unlinkSync(dest);
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = currentUrl.startsWith('https') ? https : http;

      protocol.get(currentUrl, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
          const location = response.headers.location;
          if (!location) {
            reject(new Error('Redirect without location header'));
            return;
          }
          doRequest(location, redirects + 1);
          return;
        }

        if (response.statusCode !== 200) {
          fs.unlinkSync(dest);
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;
        let lastPercent = -1;

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            const pct = Math.round((downloaded / totalSize) * 100);
            if (pct !== lastPercent) {
              lastPercent = pct;
              const mb = (downloaded / 1024 / 1024).toFixed(1);
              const totalMb = (totalSize / 1024 / 1024).toFixed(1);
              process.stdout.write(`\r  Downloading... ${pct}% (${mb}/${totalMb} MB)`);
            }
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          if (totalSize > 0) process.stdout.write('\n');
          resolve();
        });

        file.on('error', (err) => {
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
      }).on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    };

    doRequest(url);
  });
}

// ─── Windows Setup ───────────────────────────────────────────────────────────

async function setupWindows(): Promise<void> {
  const targetDir = path.join(DATA_DIR, 'win32');
  fs.mkdirSync(targetDir, { recursive: true });

  const zipName = `python-${PYTHON_VERSION}-embed.zip`;
  const zipPath = path.join(targetDir, zipName);
  const extractDir = path.join(targetDir, getEmbeddableDirName());
  const pythonExe = path.join(extractDir, 'python.exe');

  // Step 1: Download embeddable ZIP
  if (!fs.existsSync(pythonExe)) {
    if (!fs.existsSync(zipPath)) {
      console.log(`\n[Setup] Downloading Python ${PYTHON_VERSION} embeddable (${process.arch})...`);
      const url = getEmbeddableUrl();
      console.log(`  URL: ${url}`);
      await downloadFile(url, zipPath);
      console.log('  Download complete.');
    }

    // Step 2: Extract using PowerShell (built into Windows 10+)
    console.log('\n[Setup] Extracting Python...');
    fs.mkdirSync(extractDir, { recursive: true });
    extractPythonArchive(zipPath, extractDir);
    console.log('  Extraction complete.');

    // Clean up ZIP to save space
    try { fs.unlinkSync(zipPath); } catch {}
  } else {
    console.log(`\n[Setup] Python ${PYTHON_VERSION} already extracted.`);
  }

  // Step 3: Modify ._pth file to enable import site
  const pthFiles = fs.readdirSync(extractDir).filter((f) => f.endsWith('._pth'));
  for (const pthFile of pthFiles) {
    const pthPath = path.join(extractDir, pthFile);
    let content = fs.readFileSync(pthPath, 'utf-8');
    if (content.includes('#import site')) {
      content = content.replace('#import site', 'import site');
      fs.writeFileSync(pthPath, content, 'utf-8');
      console.log(`  Enabled 'import site' in ${pthFile}`);
    }
  }

  // Step 4: Install pip
  const pipExe = path.join(extractDir, 'Scripts', 'pip.exe');
  if (!fs.existsSync(pipExe)) {
    const getPipPath = path.join(targetDir, 'get-pip.py');
    if (!fs.existsSync(getPipPath)) {
      console.log('\n[Setup] Downloading get-pip.py...');
      await downloadFile(GET_PIP_URL, getPipPath);
    }

    console.log('\n[Setup] Installing pip...');
    execFileSync(pythonExe, [getPipPath, '--no-warn-script-location'], {
      stdio: 'inherit',
      timeout: 300_000,
    });
  } else {
    console.log('\n[Setup] pip already installed.');
  }

  // Step 5: Install Python packages
  console.log('\n[Setup] Installing Python packages from requirements.txt...');
  execFileSync(
    pythonExe, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH, '--no-warn-script-location', '-q'],
    { stdio: 'inherit', timeout: 600_000 }
  );

  // Step 6: Install desktop control packages (Windows-specific)
  console.log('\n[Setup] Installing desktop control packages...');
  execFileSync(
    pythonExe, ['-m', 'pip', 'install', 'pyautogui', 'pywin32', '--no-warn-script-location', '-q'],
    { stdio: 'inherit', timeout: 300_000 }
  );

  // Step 7: Install gTTS (reliable TTS fallback)
  console.log('\n[Setup] Installing TTS packages...');
  execFileSync(
    pythonExe, ['-m', 'pip', 'install', 'gTTS', '--no-warn-script-location', '-q'],
    { stdio: 'inherit', timeout: 120_000 }
  );

  console.log(`\n[Setup] Windows Python ${PYTHON_VERSION} ready at: ${pythonExe}`);
}

// ─── Linux / Mac Setup ──────────────────────────────────────────────────────

async function setupUnix(): Promise<void> {
  const platKey = process.platform === 'darwin' ? 'darwin' : 'linux';
  const targetDir = path.join(DATA_DIR, platKey);
  const venvDir = path.join(targetDir, 'venv');
  const venvPython = path.join(venvDir, 'bin', 'python3');

  fs.mkdirSync(targetDir, { recursive: true });

  // Step 1: Find system python3
  let systemPython = 'python3';
  try {
    execFileSync(systemPython, ['--version'], { stdio: 'ignore', timeout: 2000 });
  } catch {
    // Try 'python' as fallback
    try {
      execFileSync('python', ['--version'], { stdio: 'ignore', timeout: 2000 });
      systemPython = 'python';
    } catch {
      throw new Error(
        'Python 3 is not installed on this system.\n' +
        'Please install Python 3.10+ first:\n' +
        '  - Ubuntu/Debian: sudo apt install python3 python3-venv python3-pip\n' +
        '  - macOS: brew install python3\n' +
        '  - Fedora: sudo dnf install python3'
      );
    }
  }

  // Step 2: Check version >= 3.10
  const versionOutput = execFileSync(systemPython, ['--version'], { timeout: 2000 })
    .toString().trim();
  console.log(`\n[Setup] Found: ${versionOutput}`);

  const match = versionOutput.match(/(\d+)\.(\d+)/);
  if (match) {
    const major = parseInt(match[1]);
    const minor = parseInt(match[2]);
    if (major < 3 || (major === 3 && minor < 10)) {
      throw new Error(
        `Python ${major}.${minor} is too old. Please install Python 3.10 or newer.`
      );
    }
  }

  // Step 3: Create venv
  if (!fs.existsSync(venvPython)) {
    console.log('\n[Setup] Creating virtual environment...');
    execFileSync(systemPython, ['-m', 'venv', venvDir], {
      stdio: 'inherit',
      timeout: 120_000,
    });
    console.log('  venv created.');
  } else {
    console.log('\n[Setup] Virtual environment already exists.');
  }

  // Step 4: Upgrade pip
  console.log('\n[Setup] Upgrading pip...');
  execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q'], {
    stdio: 'inherit',
    timeout: 120_000,
  });

  // Step 5: Install packages
  console.log('\n[Setup] Installing Python packages from requirements.txt...');
  execFileSync(venvPython, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH, '-q'], {
    stdio: 'inherit',
    timeout: 600_000,
  });

  // Step 6: Install desktop control packages (no pywin32 on Unix)
  console.log('\n[Setup] Installing desktop control packages...');
  execFileSync(venvPython, ['-m', 'pip', 'install', 'pyautogui', 'gTTS', '-q'], {
    stdio: 'inherit',
    timeout: 300_000,
  });

  console.log(`\n[Setup] Python venv ready at: ${venvDir}`);
}

// ─── Main Setup Function ─────────────────────────────────────────────────────

export async function setupPythonEnvironment(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Agent Player — Python Environment Setup       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Platform : ${process.platform} (${process.arch})`);
  console.log(`  Target   : ${DATA_DIR}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  try {
    if (process.platform === 'win32') {
      await setupWindows();
    } else {
      await setupUnix();
    }

    // Write setup-complete flag
    const flag = {
      platform: process.platform,
      arch: process.arch,
      pythonVersion: PYTHON_VERSION,
      installedAt: new Date().toISOString(),
      requirementsHash: getFileHash(REQUIREMENTS_PATH),
    };

    fs.writeFileSync(SETUP_FLAG, JSON.stringify(flag, null, 2), 'utf-8');

    // Clear cached Python path so it re-resolves to the new embedded one
    clearCache();

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║              Setup Complete!                         ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('  You can now run: npm run dev');
    console.log('');
  } catch (err: any) {
    safeConsole.error(`\n[Setup] FAILED: ${err.message}`);
    throw err;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function getFileHash(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Simple hash: length + first 100 chars checksum
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  } catch {
    return 'unknown';
  }
}
