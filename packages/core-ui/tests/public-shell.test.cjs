require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');const React=require('../node_modules/react');const {renderToStaticMarkup}=require('../node_modules/react-dom/server');
const {PublicShell}=require('../src/PublicShell.tsx');const {AuthBoundary}=require('../src/AuthBoundary.tsx');const {SessionClient}=require('../src/session.ts');const {AppSettings}=require('../src/AppSettings.tsx');
test('signed-out shell never mounts account form or private children and locks work destinations',()=>{
 let mounted=0;function Private(){mounted++;return React.createElement('div',null,'PRIVATE_HISTORY_SENTINEL')}
 const html=renderToStaticMarkup(React.createElement(PublicShell,{setup:'login'},React.createElement(Private)));
 assert.equal(mounted,0);assert.doesNotMatch(html,/PRIVATE_HISTORY_SENTINEL|Create the owner/);assert.match(html,/Welcome to Dpro/);assert.match(html,/Not signed in/);assert.match(html,/disabled=""[^>]*>Conversations/);assert.match(html,/disabled=""[^>]*>Agents/);
});
test('live signed-out boundary renders immediate welcome without private network requests',()=>{
 const requests=[];const client=new SessionClient({live:async request=>{requests.push(request);throw Error('No private requests expected')}});client.selectMode('live');
 const html=renderToStaticMarkup(React.createElement(AuthBoundary,{client},React.createElement('div',null,'FIXTURE_PRIVATE_SENTINEL')));
 assert.match(html,/Welcome to Dpro/);assert.doesNotMatch(html,/FIXTURE_PRIVATE_SENTINEL|auth-password|Create the owner/);assert.equal(requests.length,0);
});
test('public settings exposes appearance/about and a sign-in gate, never account details or unsupported updater',()=>{
 const html=renderToStaticMarkup(React.createElement(AppSettings,{signedIn:false,preference:'system',onTheme(){},onAccount(){}}));
 assert.match(html,/Use system appearance/);assert.match(html,/Sign in to manage agents/);assert.match(html,/Automatic updates are not available/);assert.doesNotMatch(html,/Google|password_hash|token|Check for Updates/);
});
