const { test } = require('node:test'); const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
test('generator uses cryptographic bytes, provides long unique passwords, strength is conservative', async () => {
  const { generatePassword, passwordStrength } = await import('../src/password-tools.js');
  const values = new Set(Array.from({length: 64}, () => generatePassword(webcrypto)));
  assert.equal(values.size,64); for(const value of values) assert.match(value,/^[A-Za-z0-9_-]{24}$/);
  assert.equal(passwordStrength('').value,0);
  assert.equal(passwordStrength('password123456789012345').value,1);
  assert.equal(passwordStrength('aaaaaaaaaaaaaaaaaaaaaaaa').value,1);
  assert.equal(passwordStrength('This-is-Unique-48_Orchid').value,3);
});
