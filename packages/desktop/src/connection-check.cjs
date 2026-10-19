'use strict';
const http = require('node:http');
const https = require('node:https');
function checkConnection(origin) {
  return new Promise((resolve, reject) => {
    const req = (origin.startsWith('https:') ? https : http).get(origin + '/api/setup/status', { headers: { Accept: 'application/json' } }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 4096) req.destroy(new Error('The server returned an unexpected response.')); });
      res.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (res.statusCode !== 200 || typeof value.setupComplete !== 'boolean' || value.setupRequired !== !value.setupComplete) throw new Error();
          resolve();
        } catch { reject(new Error('This address did not return a Dpro setup response. Check its address and connection.')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(8000, () => req.destroy(new Error('Connection timed out. Check the address and try again.')));
    req.on('error', () => reject(new Error('Could not verify the Dpro connection. Your current workspace was not changed.')));
  });
}
module.exports = { checkConnection };
