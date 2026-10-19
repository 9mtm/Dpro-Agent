import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractPythonArchive } from '../src/services/python-archive.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-python-process-'));
const store = path.join(root, "store & quotes' %DPRO_PYTHON_TEST_MISSING% $(echo injected)");
const oldData = process.env.AGENT_PLAYER_DATA_DIR;
process.env.AGENT_PLAYER_DATA_DIR = store;
test.after(() => {
  if (oldData === undefined) delete process.env.AGENT_PLAYER_DATA_DIR; else process.env.AGENT_PLAYER_DATA_DIR = oldData;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('Python version probing treats punctuation and spaces in executable paths as data', async () => {
  const executable = process.platform === 'win32'
    ? path.join(store, 'python', 'win32', 'python-fixture-embed', 'python.exe')
    : path.join(store, 'python', process.platform === 'darwin' ? 'darwin' : 'linux', 'venv', 'bin', 'python3');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.copyFileSync(process.execPath, executable);
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o700);
  const python = await import('../src/services/python-env.ts');
  const status = python.getStatus();
  assert.equal(status.pythonPath, executable);
  assert.match(status.version, /^v\d+\./, 'a fake Node executable answers the version probe; no Python is installed');
});

test('bundled Python resources stay available when the working directory is the data workspace', async () => {
  const originalCwd = process.cwd();
  fs.mkdirSync(store, { recursive: true });
  process.chdir(store);
  try {
    const { PYTHON_SCRIPTS_DIR } = await import('../src/services/python-env.ts');
    assert.notEqual(PYTHON_SCRIPTS_DIR, path.join(store, 'python-scripts'));
    for (const resource of ['requirements.txt', 'tools/desktop/desktop.py', 'tools/stt/stt.py', 'tools/tts/tts.py', 'tools/tts/qwen-tts.py']) {
      assert.equal(fs.statSync(path.join(PYTHON_SCRIPTS_DIR, resource)).isFile(), true, resource);
    }
  } finally { process.chdir(originalCwd); }
});

test('Windows archive extraction keeps punctuation in source and destination paths literal', { skip: process.platform !== 'win32' }, () => {
  fs.mkdirSync(store, { recursive: true });
  const input = path.join(store, 'fixture.txt');
  const zip = path.join(store, "archive & quote'.zip");
  const destination = path.join(store, "destination & quote'");
  fs.writeFileSync(input, 'synthetic archive fixture');
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:DPRO_FIXTURE_INPUT -DestinationPath $env:DPRO_FIXTURE_ZIP -Force",
  ], { env: { ...process.env, DPRO_FIXTURE_INPUT: input, DPRO_FIXTURE_ZIP: zip }, timeout: 30000 });
  extractPythonArchive(zip, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'fixture.txt'), 'utf8'), 'synthetic archive fixture');
});
