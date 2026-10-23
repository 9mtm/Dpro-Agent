// S0-Q.5: exec-class tools are off by default; agent child processes get a
// minimal environment without server secrets and never run inside .data/.
// Run: node --import tsx --test test/exec-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-exec-policy-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');

// Fake secrets (test only) that must never reach a child process.
const FAKE = {
  ENCRYPTION_KEY: 'fake-enc-' + randomBytes(8).toString('hex'),
  JWT_SECRET: 'fake-jwt-' + randomBytes(8).toString('hex'),
  ANTHROPIC_API_KEY: 'fake-ant-' + randomBytes(8).toString('hex'),
  SOME_TOKEN: 'fake-tok-' + randomBytes(8).toString('hex'),
};
Object.assign(process.env, FAKE);

const policy = await import('../src/tools/exec-policy.ts');
const { createToolsRegistry, staticGrants } = await import('../src/tools/index.ts');
const { SandboxExecutor } = await import('../src/sandbox/executor.ts');

const EXEC_TOOLS = ['exec', 'execute_code', 'desktop_control'];

const withFlag = async (value, fn) => {
  const saved = process.env.AGENT_EXEC_TOOLS;
  if (value === undefined) delete process.env.AGENT_EXEC_TOOLS;
  else process.env.AGENT_EXEC_TOOLS = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.AGENT_EXEC_TOOLS;
    else process.env.AGENT_EXEC_TOOLS = saved;
  }
};

// S1.2: these tests check the exec gate, so the agent is granted every tool
// (grants and the exec gate are intersected; grants alone never enable exec).
const ALL = staticGrants(['exec', 'execute_code', 'desktop_control', 'claude_cli', 'gemini_cli', 'read', 'write', 'web_fetch']);
const registry = () => createToolsRegistry({ userId: 'u1', sessionId: 's1', workspaceDir: dir, grants: ALL });

test.after(() => {
  process.chdir(tmpdir());
  rmSync(dir, { recursive: true, force: true });
});

test('exec-class tools are hidden from the model by default', async () => {
  await withFlag(undefined, () => {
    const names = registry().getToolsForAPI().map((t) => t.name);
    for (const name of EXEC_TOOLS) assert.ok(!names.includes(name), `${name} offered`);
    assert.ok(names.includes('read'), 'non-exec tools stay available');
  });
  for (const v of ['1', 'yes', 'TRUE', '']) {
    await withFlag(v, () => {
      const names = registry().getToolsForAPI().map((t) => t.name);
      assert.ok(!names.includes('exec'), `exec offered with AGENT_EXEC_TOOLS=${v}`);
    });
  }
});

test('exec-class tools are refused when called anyway', async () => {
  await withFlag(undefined, async () => {
    const reg = registry();
    for (const name of EXEC_TOOLS) {
      const result = await reg.execute(name, { command: 'echo pwned', code: 'return 1', action: 'screenshot' });
      assert.ok(result.error, `${name} not refused`);
      assert.match(result.content[0].text, /AGENT_EXEC_TOOLS=true/);
    }
    // Direct calls (bypassing the registry) are refused too.
    const { execTool, executeCodeTool, desktopControlTool, claudeCliTool, geminiCliTool } =
      await import('../src/tools/index.ts');
    for (const tool of [execTool, executeCodeTool, desktopControlTool, claudeCliTool, geminiCliTool]) {
      const result = await tool.execute({ command: 'echo pwned', code: 'return 1', prompt: 'x', action: 'screenshot' },
        { workspaceDir: dir });
      assert.match(result.content[0].text, /is disabled/, `${tool.name} direct call not refused`);
    }
  });
});

test('exec tools are offered and run only with AGENT_EXEC_TOOLS=true', async () => {
  await withFlag('true', async () => {
    const reg = registry();
    const names = reg.getToolsForAPI().map((t) => t.name);
    for (const name of EXEC_TOOLS) assert.ok(names.includes(name), `${name} missing when enabled`);
    // Runner-level check; registry approval is covered by exec-approval-floor.test.mjs.
    const {execTool}=await import('../src/tools/core/exec.ts');
    const result = await execTool.execute({ command: 'echo exec-ok' },{workspaceDir:dir});
    assert.equal(result.error, undefined);
    assert.equal(result.content[0].text, 'exec-ok');
  });
});

test('minimalChildEnv keeps basics and drops every secret', () => {
  const env = policy.minimalChildEnv({ NO_COLOR: '1' });
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.NO_COLOR, '1');
  for (const key of [...Object.keys(FAKE), 'DATABASE_PATH']) {
    assert.equal(env[key], undefined, `${key} leaked`);
  }
});

test('minimal child environment passed to a harmless child does not contain server secrets', async () => {
  await withFlag('true', async () => {
    // Prints the child's full environment as JSON.
    const {execFile}=await import('node:child_process');
    const {promisify}=await import('node:util');
    const result=await promisify(execFile)(process.execPath,['-p','JSON.stringify(process.env)'],{env:policy.minimalChildEnv(),cwd:dir});
    const childEnv = JSON.parse(result.stdout);
    for (const [key, value] of Object.entries(FAKE)) {
      assert.equal(childEnv[key], undefined, `${key} leaked to child`);
      assert.ok(!result.stdout.includes(value), `${key} value leaked to child`);
    }
    assert.equal(childEnv.DATABASE_PATH, undefined);
    assert.ok(childEnv.PATH, 'PATH kept');
  });
});

test('sandbox host exec child does not see server secrets', async () => {
  const saved = process.env.SANDBOX_ALLOW_HOST_EXEC;
  process.env.SANDBOX_ALLOW_HOST_EXEC = 'true';
  try {
    const executor = new SandboxExecutor({ mode: 'off' });
    const result = await executor.execute({ command: 'env', env: { EXTRA_OK: 'yes' } });
    assert.equal(result.blocked, undefined);
    for (const value of Object.values(FAKE)) assert.ok(!result.stdout.includes(value), 'secret leaked');
    assert.match(result.stdout, /EXTRA_OK=yes/);
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_ALLOW_HOST_EXEC;
    else process.env.SANDBOX_ALLOW_HOST_EXEC = saved;
  }
});

test('child processes never get a cwd inside .data/', async () => {
  assert.throws(() => policy.safeChildCwd(join(dir, '.data')), /data directory/);
  assert.throws(() => policy.safeChildCwd(join(dir, '.data', 'encryption')), /data directory/);
  assert.equal(policy.safeChildCwd(dir), dir);
  await withFlag('true', async () => {
    const reg = createToolsRegistry({ userId: 'u1', sessionId: 's1', workspaceDir: join(dir, '.data'), grants: ALL });
    const result = await reg.execute('exec', { command: 'pwd' });
    assert.ok(result.error, 'exec ran inside .data');
  });
  const saved = process.env.SANDBOX_ALLOW_HOST_EXEC;
  process.env.SANDBOX_ALLOW_HOST_EXEC = 'true';
  try {
    const result = await new SandboxExecutor({ mode: 'off' }).execute({ command: 'pwd', cwd: join(dir, '.data') });
    assert.equal(result.blocked, true);
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_ALLOW_HOST_EXEC;
    else process.env.SANDBOX_ALLOW_HOST_EXEC = saved;
  }
});
