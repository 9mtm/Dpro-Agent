'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..', 'release');
const platform = process.argv[2];
if (!['mac-arm64', 'mac-x64', 'win-x64', 'linux-x64'].includes(platform)) throw new Error('Invalid release platform');
const extensions = platform.startsWith('mac-') ? ['.dmg', '.zip'] : platform === 'win-x64' ? ['.exe'] : ['.AppImage'];
const version = require('../package.json').version;
const output = path.join(root, 'publish');
fs.mkdirSync(output, { recursive: true });
const sums = [];
for (const extension of extensions) {
  const matches = fs.readdirSync(root).filter(name => name.endsWith(extension));
  if (matches.length !== 1) throw new Error(`Expected one ${extension} installer`);
  const bytes = fs.readFileSync(path.join(root, matches[0]));
  const name = `Dpro-${version}-${platform}${extension}`;
  fs.writeFileSync(path.join(output, name), bytes);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
fs.writeFileSync(path.join(output, `SHA256SUMS-${platform}.txt`), sums.join('\n') + '\n');
