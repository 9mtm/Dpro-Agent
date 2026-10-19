import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliInvocation } from '../src/tools/cli/process-invocation.ts';

test('Windows batch shims never interpret shell metacharacters in prompts or models', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dpro-cli-contract-'));
  try {
    const script = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const marker = path.join(root, 'unexpected-shell-output');
    const prompt = `quoted " value & echo injected > "${marker}" | %COMSPEC% $(whoami)\nsecond line`;
    const args = ['-p', prompt, '--model', 'model&echo injected'];
    const invocation = await cliInvocation(path.join(root, 'claude.cmd'), args, 'win32');
    assert.equal(invocation.file, process.execPath);
    const { stdout } = await promisify(execFile)(invocation.file, invocation.args, { cwd: root });
    assert.deepEqual(JSON.parse(stdout), args);
    await assert.rejects(access(marker));
    await assert.rejects(cliInvocation(path.join(root, 'missing', 'claude.cmd'), args, 'win32'), { code: 'ENOENT' });
    assert.deepEqual(await cliInvocation('native.exe', args, 'win32'), { file: 'native.exe', args });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
