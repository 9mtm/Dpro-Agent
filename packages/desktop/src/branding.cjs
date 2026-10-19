'use strict';
const path = require('node:path');
const PRODUCT_NAME = 'Dpro Agent';
const LEGACY_PROFILE = 'Dpro';
function configureBranding(app, env = process.env) {
  // DPRO_DESKTOP_PROFILE_DIR: a separate profile (settings, browser storage, logs) for tests and trial runs.
  app.setPath('userData', env.DPRO_DESKTOP_PROFILE_DIR ? path.resolve(env.DPRO_DESKTOP_PROFILE_DIR) : path.join(app.getPath('appData'), LEGACY_PROFILE));
  app.setName(PRODUCT_NAME);
}
module.exports = { PRODUCT_NAME, LEGACY_PROFILE, configureBranding };
