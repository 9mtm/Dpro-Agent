'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { remoteOrigin, loadSettings, saveSettings, FILE } = require('../src/settings.cjs');

test('remote address: https anywhere, http only on this computer', () => {
  assert.equal(remoteOrigin('https://dpro.example.com'), 'https://dpro.example.com');
  assert.equal(remoteOrigin('https://dpro.example.com:8443/'), 'https://dpro.example.com:8443');
  assert.equal(remoteOrigin('http://127.0.0.1:42522'), 'http://127.0.0.1:42522');
  assert.equal(remoteOrigin('http://localhost:42522/'), 'http://localhost:42522');
  assert.equal(remoteOrigin('http://192.168.1.5:42522'), null);
  assert.equal(remoteOrigin('http://dpro.example.com'), null);
  assert.equal(remoteOrigin('https://user:pw@dpro.example.com'), null);
  assert.equal(remoteOrigin('https://dpro.example.com/?x=1'), null);
  assert.equal(remoteOrigin('https://dpro.example.com/#a'), null);
  assert.equal(remoteOrigin('https://dpro.example.com/path'), null);
  assert.equal(remoteOrigin('file:///etc/passwd'), null);
  assert.equal(remoteOrigin('javascript:alert(1)'), null);
  assert.equal(remoteOrigin(42), null);
});

test('settings: default local, saved 0600, bad file falls back to local', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-settings-'));
  assert.deepEqual(loadSettings(dir), { mode: 'local', remoteUrl: null });
  saveSettings(dir, { mode: 'remote', remoteUrl: 'https://dpro.example.com/' });
  assert.deepEqual(loadSettings(dir), { mode: 'remote', remoteUrl: 'https://dpro.example.com' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, FILE)).mode & 0o777, 0o600);
  saveSettings(dir, { mode: 'remote', remoteUrl: 'http://evil.example.com' });
  assert.deepEqual(loadSettings(dir), { mode: 'local', remoteUrl: null });
  fs.writeFileSync(path.join(dir, FILE), '{not json');
  assert.deepEqual(loadSettings(dir), { mode: 'local', remoteUrl: null });
});
