import test from 'node:test';
import assert from 'node:assert/strict';
import { validSetupEmail, trimTrailingSlashes } from '../src/auth/setup-input.ts';

test('setup email accepts existing valid forms and refuses malformed or oversized submissions', () => {
  for (const email of ['owner@example.invalid', 'owner+tag@sub.example.invalid', 'مستخدم@example.invalid']) assert.equal(validSetupEmail(email), true);
  for (const email of ['', null, 'owner', '@example.invalid', 'owner@@example.invalid', 'owner@.invalid', 'owner@example.', 'owner @example.invalid', 'owner@example.invalid\n', 'owner@'+('a.'.repeat(200000))+' ']) assert.equal(validSetupEmail(email), false);
});

test('trailing slash normalization preserves other URL characters with bounded linear traversal', () => {
  assert.equal(trimTrailingSlashes('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(trimTrailingSlashes('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(trimTrailingSlashes('http://localhost/'+('/'.repeat(200000))), 'http://localhost');
  const unchanged = 'http://localhost/'+('/'.repeat(200000))+'x';
  assert.equal(trimTrailingSlashes(unchanged), unchanged);
});
