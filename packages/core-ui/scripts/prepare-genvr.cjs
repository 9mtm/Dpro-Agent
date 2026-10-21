'use strict';
/** Materialize the pinned public SDK archive without changing shared node_modules. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const VERSION='0.3.0-preview.16',SHA256='a9d1bc26389fdd0ff6c4ef5d55de54b761ffd57545e09f7b706a3c0cf7e24a97';
function prepare(archive,root=path.resolve(__dirname,'..')){
 const bytes=fs.readFileSync(archive);if(crypto.createHash('sha256').update(bytes).digest('hex')!==SHA256)throw Error('GenVR archive checksum mismatch');
 const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:8*1024*1024}).split('\n').filter(Boolean);
 if(names.some(n=>!n.startsWith('package/')||n.split('/').includes('..')||n.includes('\\')))throw Error('Invalid GenVR archive paths');
 const out=path.join(root,'vendor','genvr');fs.mkdirSync(out,{recursive:true});execFileSync('tar',['-xzf',archive,'-C',out]);
 const pkg=JSON.parse(fs.readFileSync(path.join(out,'package/package.json')));if(pkg.name!=='3d-world-sdk'||pkg.version!==VERSION)throw Error('Wrong GenVR package');
 const files={};function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isSymbolicLink())throw Error('GenVR links are not allowed');if(item.isDirectory())walk(file);else if(item.isFile())files[path.relative(path.join(out,'package'),file).split(path.sep).join('/')]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
 walk(path.join(out,'package/dist'));for(const file of ['LICENSE','README.md'])files[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'package',file))).digest('hex');
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({package:'3d-world-sdk',version:VERSION,archiveSha256:SHA256,files},null,2));return out;
}
module.exports={prepare,VERSION,SHA256};if(require.main===module){try{if(process.argv.length!==3)throw Error('Pass the verified GitHub release archive path');console.log('Prepared GenVR:',prepare(path.resolve(process.argv[2])));}catch(e){console.error(e.message);process.exitCode=1;}}
