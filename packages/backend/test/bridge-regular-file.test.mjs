import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile } from '../src/memory/bridge/regular-file.ts';

test('descriptor reads reject links, directories, oversize files and swaps between inspection and open', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-regular-file-'));
 const file=path.join(root,'config'),other=path.join(root,'other');
 const open=fs.openSync;
 try {
  fs.writeFileSync(file,'original',{mode:0o600});fs.writeFileSync(other,'private');
  assert.equal(readRegularFile(file,32).bytes.toString(),'original');
  assert.throws(()=>readRegularFile(file,2),{code:'EFBIG'});
  assert.throws(()=>readRegularFile(root,32),{code:'ENOTREG'});
  fs.symlinkSync(other,path.join(root,'link'));
  assert.throws(()=>readRegularFile(path.join(root,'link'),32),{code:'ENOTREG'});
  fs.openSync=function(target,...args){
   if(target===file){fs.renameSync(file,file+'.old');fs.symlinkSync(other,file);}
   return open.call(fs,target,...args);
  };
  assert.throws(()=>readRegularFile(file,32));
 } finally {fs.openSync=open;fs.rmSync(root,{recursive:true,force:true});}
});
