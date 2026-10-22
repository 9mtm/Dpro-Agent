require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');const React=require('../node_modules/react');const {renderToStaticMarkup}=require('../node_modules/react-dom/server');const {StaffDirectory}=require('../src/StaffDirectory.tsx');
const state={phase:'ready',agents:[{id:'one',name:'Nora',department:'education',role:'specialist',description:'Private responsibilities'},{id:'two',name:'Ellis',department:'legal',role:'manager'}]};
const controller={subscribe:()=>()=>{},getSnapshot:()=>state};
const render=props=>renderToStaticMarkup(React.createElement(StaffDirectory,{controller,department:'all',onDepartment(){},onOpen(){},...props}));
test('staff directory keeps details out of list and privileged commands out of member view',()=>{const html=render();assert.match(html,/role="listbox"/);assert.doesNotMatch(html,/Private responsibilities|Hire agent|Build your company/);assert.match(html,/Select a staff member/);});
test('department place filters staff while owner commands remain available',()=>{const html=render({department:'education',onHire(){},onCompany(){}});assert.match(html,/Nora/);assert.doesNotMatch(html,/Ellis/);assert.match(html,/Hire agent|Build your company/);});
