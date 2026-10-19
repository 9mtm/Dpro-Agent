import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerManager } from '../src/sandbox/docker-manager.ts';

test('Docker image and lifecycle operations keep untrusted values in individual arguments', async () => {
  const calls = [];
  const id = 'a'.repeat(64);
  const manager = new DockerManager(async (args, options) => {
    calls.push({ args, options });
    return { stdout: args[0] === 'create' ? id : '', stderr: '' };
  });
  for (const image of ['', '--help', 'image; echo injected', 'image\nnext', '$(echo injected)']) {
    assert.equal(await manager.ensureImage(image), false);
  }
  assert.equal(calls.length, 0, 'invalid image text never reaches a process');
  assert.equal(await manager.ensureImage('registry.example:5000/team/image:v1'), true);
  assert.deepEqual(calls[0].args, ['images', '-q', '--', 'registry.example:5000/team/image:v1']);
  assert.deepEqual(calls[1].args, ['pull', '--', 'registry.example:5000/team/image:v1']);

  const config = {
    mode: 'all', scope: 'session', workspaceAccess: 'ro', timeout: 1000, maxMemory: 128, maxCpu: 1,
    docker: { image: 'node:22', network: 'none', workDir: '/work spaced', binds: ['/fixture/dir with spaces:/work:ro'], env: { FIXTURE: 'a" & echo injected | ignored' }, user: '1000:1000' },
  };
  const session = await manager.createSession(config);
  const created = calls.find(c => c.args[0] === 'create').args;
  assert.equal(created[created.indexOf('-w') + 1], '/work spaced');
  assert.equal(created[created.indexOf('-v') + 1], config.docker.binds[0]);
  assert.equal(created[created.indexOf('-e') + 1], 'FIXTURE='+config.docker.env.FIXTURE);
  assert.deepEqual(created.slice(-5), ['--', 'node:22', 'tail', '-f', '/dev/null']);
  assert.deepEqual(calls.find(c => c.args[0] === 'start').args, ['start', '--', id]);
  await manager.destroySession(session.id);
  assert.deepEqual(calls.find(c => c.args[0] === 'stop').args, ['stop', '--', id]);
  assert.deepEqual(calls.find(c => c.args[0] === 'rm').args, ['rm', '-f', '--', id]);
  assert.equal(manager.getActiveSessions().length, 0);
  await assert.rejects(manager.createSession({ ...config, docker: { ...config.docker, image: '--privileged' } }), /Invalid Docker image/);
});

test('a malformed container identifier is refused before start', async () => {
  const calls = [];
  const manager = new DockerManager(async args => { calls.push(args); return { stdout: 'bad; echo injected', stderr: '' }; });
  await assert.rejects(manager.createSession({ docker: { image: 'node:22', network: 'none', workDir: '/work' } }), /Invalid Docker container identifier/);
  assert.deepEqual(calls.map(args => args[0]), ['create']);
});
