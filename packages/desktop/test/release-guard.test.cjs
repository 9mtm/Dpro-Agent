'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuseDevAccounts } = require('../scripts/stage-payload.cjs');
test('release packaging refuses test login builds even after their private account config is removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-release-guard-'));
  try {
    for (const content of ['enabled', '']) {
      fs.writeFileSync(path.join(root, 'index.html'), `<meta name="core-ui-dev-quick-login" content="${content}">`);
      assert.throws(() => refuseDevAccounts(root, root), /disabled dev quick-login provenance/);
    }
    fs.writeFileSync(path.join(root, 'index.html'), '<meta name="core-ui-dev-quick-login" content="disabled">');
    assert.doesNotThrow(() => refuseDevAccounts(root, root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
