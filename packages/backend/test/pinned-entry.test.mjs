import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkCommand} from '../src/mcp-client/config.ts';
import {pinnedEntryArgs} from '../src/mcp-client/pinned-entry.ts';

test('execution verifies the loaded entry bytes after registration and rejects tampering',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dpro-pinned-entry-'));
 try{
  const file=path.join(root,'entry.mjs'),source="import {basename} from 'node:path';process.stdout.write(basename('verified'));";
  await fs.writeFile(file,source);
  const args=pinnedEntryArgs(file,createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(checkCommand(process.execPath,args).args,args);
  assert.equal((await promisify(execFile)(process.execPath,args)).stdout,'verified');
  const marker=path.join(root,'executed');
  await fs.writeFile(file,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');`);
  await assert.rejects(promisify(execFile)(process.execPath,args));
  await assert.rejects(fs.access(marker));
  await fs.rename(file,file+'.saved');await fs.symlink(file+'.saved',file);
  await assert.rejects(promisify(execFile)(process.execPath,args));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
