require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');

test('specialty hire entry preserves review-only controls and cannot create a template',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{SpecialtyLibrary}=require('../src/SpecialtyLibrary.tsx');
 const hire=renderToStaticMarkup(React.createElement(SpecialtyLibrary,{client:{},hire:true}));
 assert.match(hire,/Choose specialty template/);assert.match(hire,/Review a saved template/);assert.doesNotMatch(hire,/>New specialty</);assert.match(hire,/Find a specialty/);assert.match(hire,/All departments/);
 const library=renderToStaticMarkup(React.createElement(SpecialtyLibrary,{client:{}}));assert.match(library,/>New specialty</);assert.match(library,/Existing agents keep their configuration/);assert.doesNotMatch(library,/Run exam|Give specialty|changes [0-9]+ agents/i);
});
