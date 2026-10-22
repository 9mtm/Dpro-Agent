import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {PinnedSkillSource,PinnedSkillSourceError} from '../src/plugins/pinned-skill-source.ts';
const input={commit:'a'.repeat(40),sourcePath:'skills/example'},raw='---\nname: example\ndescription: Fictional source\n---\nBody\n',digest=b=>createHash('sha256').update(b).digest('hex');
const response=(body=raw,options={})=>new Response(body,{status:200,...options});
test('fixed official endpoint pins full commit and derives exact immutable UTF8 artifact without credentials',async()=>{
 let request;const source=new PinnedSkillSource(async(url,options)=>{request={url,options};return response(raw);});const result=await source.fetch(input);
 assert.equal(request.url,'https://api.github.com/repos/anthropics/skills/contents/skills/example/SKILL.md?ref='+input.commit);assert.equal(request.options.redirect,'error');assert.equal(request.options.credentials,'omit');assert.equal(request.options.headers.Authorization,undefined);assert.equal(result.contentHash,digest(raw));assert.equal(result.byteLength,Buffer.byteLength(raw));assert.ok(Object.isFrozen(result));assert.equal(Object.hasOwn(result,'receipt'),false);
});
test('caller URLs, mutable refs, paths, accessors and proxies refuse before transport',async()=>{
 let calls=0;const source=new PinnedSkillSource(async()=>{calls++;return response();});for(const value of [{...input,url:'https://example.invalid'},{...input,commit:'main'},{...input,commit:'0'.repeat(40)},{...input,sourcePath:'skills/../outside'},{...input,sourcePath:'skills/%2e%2e/x'},Object.assign(Object.create({inherited:true}),input)])await assert.rejects(source.fetch(value),PinnedSkillSourceError);
 let traps=0;const accessor={...input};Object.defineProperty(accessor,'commit',{get(){traps++;return input.commit;}});await assert.rejects(source.fetch(accessor));await assert.rejects(source.fetch(new Proxy(input,{get(){traps++;throw Error();}})));assert.equal(traps,0);assert.equal(calls,0);
});
test('HTTP failure, redirects, advertised oversize, empty/binary/invalid UTF8 refuse with generic error',async()=>{
 for(const res of [response(raw,{status:302,headers:{location:'https://example.invalid'}}),response('Fictional private error',{status:500}),response(raw,{headers:{'content-length':'200001'}}),response(''),response(new Uint8Array([0xff,0xfe])),response('Bad\0text'),response('Bad\u202etext')]){const source=new PinnedSkillSource(async()=>res);await assert.rejects(source.fetch(input),e=>e instanceof PinnedSkillSourceError&&!e.message.includes('Fictional private error'));}
});
test('stream limit is actual bytes and cancels excess even without content-length',async()=>{
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(100000));c.enqueue(new Uint8Array(100001));},cancel(){cancelled=true;}});await assert.rejects(new PinnedSkillSource(async()=>response(stream)).fetch(input));assert.equal(cancelled,true);
 const maximum=await new PinnedSkillSource(async()=>response('a'.repeat(200000))).fetch(input);assert.equal(maximum.byteLength,200000);
 const rawBytes=Buffer.from('界'.repeat(1000));const result=await new PinnedSkillSource(async()=>response(rawBytes)).fetch(input);assert.equal(result.byteLength,3000);assert.equal(result.contentHash,digest(rawBytes));
});
test('deadline covers response headers and body; explicit cancellation refuses before fetching',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(new PinnedSkillSource(async()=>{calls++;return response();}).fetch(input,controller.signal));assert.equal(calls,0);
 await assert.rejects(new PinnedSkillSource(()=>new Promise(()=>{}),5).fetch(input));let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});await assert.rejects(new PinnedSkillSource(async()=>response(stream),5).fetch(input));assert.equal(cancelled,true);
});
test('BOM and split UTF8 chunks retain exact source identity',async()=>{
 const bytes=Buffer.from('\ufeff'+raw+'界');const stream=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,bytes.length-1));c.enqueue(bytes.subarray(bytes.length-1));c.close();}});const value=await new PinnedSkillSource(async()=>response(stream)).fetch(input);assert.equal(value.contentHash,digest(bytes));assert.equal(value.content,'\ufeff'+raw+'界');
});
