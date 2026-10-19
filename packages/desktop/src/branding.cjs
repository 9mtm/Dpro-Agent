'use strict';
const path = require('node:path');
const PRODUCT_NAME = 'Dpro Agent';
const LEGACY_PROFILE = 'Dpro';
function configureBranding(app) {
  app.setPath('userData', path.join(app.getPath('appData'), LEGACY_PROFILE));
  app.setName(PRODUCT_NAME);
}
module.exports = { PRODUCT_NAME, LEGACY_PROFILE, configureBranding };
