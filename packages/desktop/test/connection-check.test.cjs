const { test } = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const { checkConnection } = require('../src/connection-check.cjs');
test('connection is accepted only after a valid Dpro response, redirects/HTML/inconsistent states refused', async () => {
  let mode='valid'; const server=http.createServer((req,res)=>{if(mode==='redirect'){res.writeHead(302,{Location:'/api/setup/status'});return res.end();} res.end(mode==='html'?'<html>Other app</html>':JSON.stringify({setupComplete:true,setupRequired:mode==='bad'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  try{await checkConnection(origin);for(const value of ['redirect','html','bad']){mode=value;await assert.rejects(checkConnection(origin));}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
