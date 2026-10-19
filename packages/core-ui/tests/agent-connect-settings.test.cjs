require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const React=require('../node_modules/react');const {renderToStaticMarkup}=require('../node_modules/react-dom/server');
const {allowedChannel,channelResponse}=require('../src/agent-connect-contract.js');const {allowed}=require('../scripts/application-server.cjs');const {allowedRequest}=require('../src/session.ts');const {ChannelCatalogSelect}=require('../src/AgentConnectSettings.tsx');
const {CHANNEL_CATALOG}=require(path.resolve(__dirname,'../../backend/node_modules/agent-connect-dpro/dist/catalog.js'));
const channels=CHANNEL_CATALOG.map(c=>({...c,runtime:['telegram','discord'].includes(c.id)?'node':'python',allowedUsers:[],allowedChannels:[],enabled:false,configured:false,hasSecrets:false,environment:{TOKEN:'must-never-return'},settings:{token:'must-never-return'},owner_user_id:'private-owner'}));
test('all33 canonical adapters survive both strict boundaries and appear in the actual settings picker',()=>{
 const route='/api/agent-connect/catalog';assert.ok(allowedChannel('GET',route));assert.ok(allowed('GET',route));assert.ok(allowedRequest('GET',route));
 const once=channelResponse(route,200,{channels,configurable:true});const twice=channelResponse(route,200,once);assert.deepEqual(once,twice);assert.equal(twice.channels.length,33);assert.ok(!JSON.stringify(twice).includes('must-never-return'));assert.ok(!JSON.stringify(twice).includes('private-owner'));
 const html=renderToStaticMarkup(React.createElement(ChannelCatalogSelect,{channels:twice.channels,selected:'',busy:false,onSelect:()=>{}}));assert.equal((html.match(/<option /g)||[]).length,34);
 for(const c of CHANNEL_CATALOG)assert.ok(html.includes('value="'+c.id+'"'),c.id);
});
test('configuration only accepts bounded save requests and rejects provider activation routes',()=>{
 for(const c of CHANNEL_CATALOG){const route='/api/agent-connect/'+c.id+'/config';const b={allowedUsers:['person'],allowedChannels:['room'],environment:{}};assert.ok(allowedChannel('PUT',route,b));assert.ok(allowed('PUT',route,b));assert.ok(allowedRequest('PUT',route,b));assert.equal(allowedChannel('PUT',route,{...b,auto_reply:true}),false);}
 for(const route of ['/api/agent-connect/ntfy/connect','/api/agent-connect/../config','/api/agent-connect/catalog?token=value']){assert.equal(allowed('POST',route),false);assert.equal(allowedRequest('POST',route),false);}
 const route='/api/agent-connect/ntfy/config';const body={saved:true,channel:channels.find(c=>c.id==='ntfy')};const projected=channelResponse(route,200,body);assert.ok(!JSON.stringify(projected).includes('must-never-return'));assert.deepEqual(channelResponse(route,200,projected),projected);
 assert.throws(()=>channelResponse(route,200,{...body,channel:{...body.channel,id:'telegram'}}),/protocol/);
});

test('activation accepts only an explicit boolean and projects safe runtime state',()=>{
 const route='/api/agent-connect/slack/activation';
 for(const enabled of [true,false]){assert.ok(allowed('PUT',route,{enabled}));assert.ok(allowedRequest('PUT',route,{enabled}));}
 for(const body of [{enabled:'true'},{enabled:true,token:'secret'},{}])assert.equal(allowed('PUT',route,body),false);
 const channel={...channels.find(c=>c.id==='slack'),state:'connected',enabled:true};
 const result=channelResponse(route,200,{saved:true,channel});assert.equal(result.channel.state,'connected');assert.ok(!JSON.stringify(result).includes('must-never-return'));
});
