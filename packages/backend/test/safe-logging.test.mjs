import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { format } from 'node:util';
import { logText, safeConsole } from '../src/services/safe-error-log.ts';

test('untrusted log fields cannot forge records or terminal control sequences', () => {
  const result = logText('job\r\nforged\u001b[31m\b\u009b\u2028next\u2029record\u202e');
  assert.doesNotMatch(result, /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
  assert.match(result, /job/);
  assert.match(result, /forged/);
  assert.equal(logText('x'.repeat(10000)).length, 4096);
});

test('log strings redact synthetic provider secrets and errors expose only safe metadata', () => {
  const key = ['sk', 'ant', 'api03', randomBytes(32).toString('hex')].join('-');
  assert.ok(!logText(`request failed: ${key}`).includes(key));
  const error = Object.assign(new Error(`private message ${key}`), { code: 'EPIPE', status: 502 });
  const result = logText(error);
  assert.ok(!result.includes(key));
  assert.ok(!result.includes('private message'));
  assert.deepEqual(JSON.parse(result), { name: 'Error', code: 'EPIPE', status: 502 });
});

test('console format is constant and original log levels are retained', () => {
  for (const level of ['log', 'warn', 'error', 'info']) {
    const original = console[level];
    const captured = [];
    try {
      console[level] = (...args) => captured.push({ args, rendered: format(...args) });
      safeConsole[level]('job %s %o\nforged', 'value\r\nsecond record');
    } finally {
      console[level] = original;
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0].args[0], '%s');
    assert.match(captured[0].rendered, /job %s %o/);
    assert.doesNotMatch(captured[0].rendered, /[\r\n]/);
    assert.match(JSON.parse(captured[0].rendered).message, /job %s %o/);
  }
});

test('a forged JSON record remains one encoded diagnostic entry', () => {
  const original = console.log;
  let output;
  try {
    console.log = (...args) => { output = format(...args); };
    safeConsole.log('job"}\n{"message":"forged"}\r\n');
  } finally { console.log = original; }
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed), ['message']);
  assert.ok(parsed.message.includes('forged'));
  assert.doesNotMatch(output, /[\r\n]/);
});

test('circular diagnostic objects cannot break the caller', () => {
  const circular = {}; circular.self = circular;
  assert.equal(logText(circular), '[unavailable log field]');
});
