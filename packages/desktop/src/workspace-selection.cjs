'use strict';
const fs = require('node:fs');
const path = require('node:path');
const INVALID_SELECTION = '<invalid-saved-workspace>';
function readSelection(settingsDir) {
  const file = path.join(settingsDir, 'workspace.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.dir !== 'string' || !path.isAbsolute(value.dir)) return INVALID_SELECTION;
    try { return fs.realpathSync(value.dir); } catch { return value.dir; }
  } catch (error) { return error.code === 'ENOENT' ? null : INVALID_SELECTION; }
}
module.exports = { readSelection, INVALID_SELECTION };
