import { pathToFileURL } from 'node:url';

/** Verify the very source bytes returned to Node's ESM loader, not an earlier path read. */
export function pinnedEntryArgs(file: string, sha256: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid entry fingerprint');
  const target = pathToFileURL(file).href;
  const loader = `import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
export async function resolve(specifier,context,next){
 if(!context.parentURL)return {url:${JSON.stringify(target)},shortCircuit:true};
 return next(specifier,context);
}
export async function load(url,context,next){
 if(url!==${JSON.stringify(target)})return next(url,context);
 const handle=await fs.open(new URL(url),constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>16777216)throw Error('Pinned entry unavailable');
  const buffer=Buffer.alloc(16777217);let used=0;
  while(used<buffer.length){const r=await handle.read(buffer,used,buffer.length-used,null);if(!r.bytesRead)break;used+=r.bytesRead;}
  const source=buffer.subarray(0,used);
  if(used>16777216||createHash('sha256').update(source).digest('hex')!==${JSON.stringify(sha256)})throw Error('Pinned entry changed');
  return {format:'module',source,shortCircuit:true};
 }finally{await handle.close();}
}`;
  return ['--loader', `data:text/javascript,${encodeURIComponent(loader)}`, file];
}
