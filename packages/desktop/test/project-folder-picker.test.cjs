'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('project-folder picker accepts only the main local workspace and explicit dialog selections',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
 const start=source.indexOf('// Only the active local workspace'),end=source.indexOf('const fromWelcome =',start);
 let handler,calls=0,canceled=false;const frame={url:'http://127.0.0.1:42522/'},contents={mainFrame:frame};
 const context={runtime:{},mainWindow:{webContents:contents},appOrigin:'http://127.0.0.1:42522',URL,ipcMain:{handle(name,fn){assert.equal(name,'dpro:choose-project-folders');handler=fn;}},dialog:{async showOpenDialog(_window,options){calls++;assert.deepEqual(Array.from(options.properties),['openDirectory','multiSelections']);return {canceled,filePaths:Array.from({length:10},(_,i)=>'/project/'+i)};}}};
 vm.runInNewContext(source.slice(start,end),context);
 assert.equal((await handler({sender:{},senderFrame:frame})).length,0);
 assert.equal((await handler({sender:contents,senderFrame:{url:frame.url}})).length,0);
 frame.url='https://remote.example/';assert.equal((await handler({sender:contents,senderFrame:frame})).length,0);assert.equal(calls,0);
 frame.url=context.appOrigin+'/';const result=await handler({sender:contents,senderFrame:frame});assert.equal(result.length,8);assert.equal(calls,1);
 canceled=true;assert.equal((await handler({sender:contents,senderFrame:frame})).length,0);
 context.runtime=null;assert.equal((await handler({sender:contents,senderFrame:frame})).length,0);assert.equal(calls,2);
});
