import { safeConsole } from './safe-error-log.js';
/**
 * CLI entry point for Python environment setup.
 * Run via: npm run setup:python
 */

import { setupPythonEnvironment } from './python-setup.js';

setupPythonEnvironment()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    safeConsole.error('\nSetup failed:', err.message);
    process.exit(1);
  });
