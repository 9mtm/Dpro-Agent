import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'dpro-property-map-'));
const oldData = process.env.AGENT_PLAYER_DATA_DIR;
process.env.AGENT_PLAYER_DATA_DIR = root;
test.after(() => {
  if (oldData === undefined) delete process.env.AGENT_PLAYER_DATA_DIR; else process.env.AGENT_PLAYER_DATA_DIR = oldData;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const { minimalChildEnv } = await import('../src/tools/exec-policy.ts');
const { checkSecretMap } = await import('../src/mcp-client/config.ts');
const { validateContract, schemaErrors } = await import('../src/services/task-contracts.ts');
const { maskSecretFields, restoreMaskedFields, SECRET_PLACEHOLDER } = await import('../src/credentials/secret-mask.ts');

test('literal environment names cannot mutate dictionary prototypes', () => {
  const literal = JSON.parse('{"__proto__":"literal","constructor":"literal","SAFE":"1"}');
  for (const result of [minimalChildEnv(literal), checkSecretMap(literal, 'env')]) {
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.__proto__, 'literal');
    assert.equal(result.SAFE, '1');
  }
  const hostile = minimalChildEnv(JSON.parse('{"__proto__":{"polluted":true},"SAFE":"1"}'));
  assert.equal(Object.getPrototypeOf(hostile), Object.prototype);
  assert.equal(hostile.polluted, undefined);
  assert.equal(hostile.SAFE, '1');
});

test('task property dictionaries preserve literal keys and inherited fields cannot satisfy JSON requirements', () => {
  const contract = validateContract({
    goal: 'Synthetic schema check',
    output: { format: 'json', schema: { type: 'object', required: ['__proto__', 'toString'], properties: JSON.parse('{"__proto__":{"type":"string"},"toString":{"type":"string"}}') } },
  }, { grants: null, maxSteps: 60, maxDurationMs: 60000 });
  const schema = contract.output.schema;
  assert.equal(Object.getPrototypeOf(schema.properties), Object.prototype);
  assert.equal(Object.hasOwn(schema.properties, '__proto__'), true);
  assert.deepEqual(schemaErrors(JSON.parse('{"__proto__":"safe","toString":"safe"}'), schema), []);
  assert.ok(schemaErrors({}, schema).some(error => error.includes('toString is required')));
  assert.ok(schemaErrors(Object.create({ title: 'inherited' }), { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }).length);
});

test('secret-field masking preserves own JSON keys without changing object prototypes', () => {
  const config = JSON.parse('{"__proto__":{"polluted":true},"password":"fixture"}');
  const masked = maskSecretFields(config);
  assert.equal(masked.password, SECRET_PLACEHOLDER);
  assert.equal(Object.getPrototypeOf(masked), Object.prototype);
  assert.equal(masked.polluted, undefined);
  const incoming = JSON.parse('{"__proto__":{"polluted":true}}'); incoming.password = SECRET_PLACEHOLDER;
  const restored = restoreMaskedFields(incoming, config);
  assert.equal(restored.password, 'fixture');
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(restored.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
