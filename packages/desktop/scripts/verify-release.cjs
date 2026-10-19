'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verifyBundle } = require('./verify-bundle.cjs');
const root = path.resolve(__dirname, '..', 'release');
const apps = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const folder = path.join(root, entry.name);
  if (process.platform === 'darwin') {
    for (const name of fs.readdirSync(folder)) if (name.endsWith('.app')) apps.push(path.join(folder, name));
  } else if (fs.existsSync(path.join(folder, 'resources', 'payload'))) apps.push(folder);
}
if (apps.length !== 1) throw new Error('Expected exactly one unpacked desktop application');
console.log(verifyBundle(apps[0]));
