import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { desktopArgsFile } from '../src/tools/desktop/args-file.ts';

test('desktop IPC gets a private unique directory and owner-only arguments, then removes both', () => {
  const first = desktopArgsFile({ action: 'type_text', text: 'synthetic private text' });
  const second = desktopArgsFile({ action: 'wait', seconds: 0 });
  try {
    assert.notEqual(dirname(first.file), dirname(second.file));
    assert.deepEqual(JSON.parse(readFileSync(first.file, 'utf8')), { action: 'type_text', text: 'synthetic private text' });
    if (process.platform !== 'win32') {
      assert.equal(statSync(dirname(first.file)).mode & 0o777, 0o700);
      assert.equal(statSync(first.file).mode & 0o777, 0o600);
    }
  } finally {
    first.cleanup(); second.cleanup();
  }
  assert.equal(existsSync(dirname(first.file)), false);
  assert.equal(existsSync(dirname(second.file)), false);
});
