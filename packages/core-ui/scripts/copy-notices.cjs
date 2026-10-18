const { copyFileSync, existsSync, readFileSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function copyNotices(output) {
  copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(output, 'THIRD_PARTY_NOTICES.txt'));
  const license = path.join(root, 'vendor/genvr/package/LICENSE');
  if (existsSync(license)) appendFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), '\n\n3d-world-sdk 0.3.0-preview.1 — AGPL-3.0-only\nSource: https://github.com/Dpro-at/genvr-world-sdk/tree/v0.3.0-preview.1\n' + readFileSync(license, 'utf8'));
}
module.exports = { copyNotices };
