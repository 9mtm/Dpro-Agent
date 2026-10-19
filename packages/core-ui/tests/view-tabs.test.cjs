require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const React=require('../node_modules/react');const {renderToStaticMarkup}=require('../node_modules/react-dom/server');
const {ViewTabs}=require('../src/ViewTabs.tsx');
const tabs=[{value:'conversations',label:'Conversations'},{value:'files',label:'Project files'}];
test('pane tabs link the active panel and use one keyboard tab stop',()=>{
 const html=renderToStaticMarkup(React.createElement(ViewTabs,{id:'import-source',label:'Import source type',value:'files',tabs,onChange:()=>{}}));
 assert.equal((html.match(/tabindex="0"/g)||[]).length,1);assert.match(html,/aria-controls="import-source-panel"/);assert.match(html,/id="import-source-files"[^>]*aria-selected="true"/);assert.ok(!html.includes('import-source-tabs'));
});
test('pane tabs support wrapping arrows, Home, End and RTL without page navigation',()=>{
 for(const direction of ['ltr','rtl']){
  let selected,focused,prevented=0;
  const tree=ViewTabs({id:'import-source',label:'Import source type',value:'conversations',tabs,onChange:v=>selected=v});
  const event=key=>({key,preventDefault:()=>prevented++,currentTarget:{ownerDocument:{defaultView:{getComputedStyle:()=>({direction})}},parentElement:{querySelectorAll:()=>tabs.map((_,i)=>({focus:()=>focused=i}))}}});
  const press=tree.props.children[0].props.onKeyDown;
  for(const key of ['ArrowRight','ArrowLeft','End']){press(event(key));assert.equal(selected,'files');assert.equal(focused,1);}
  press(event('Home'));assert.equal(selected,'conversations');assert.equal(focused,0);assert.equal(prevented,4);
  press(event('Tab'));assert.equal(prevented,4);
 }
});
