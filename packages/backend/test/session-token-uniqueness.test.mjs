import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import jwt from 'jsonwebtoken';
process.env.JWT_SECRET=randomBytes(64).toString('hex');const {generateToken}=await import('../src/auth/jwt.ts');
test('same-account same-second sign-ins have distinct signed sessions with equal lifetime',()=>{
 const clock=Date.now,fixed=clock();let tokens;
 try{Date.now=()=>fixed;tokens=Array.from({length:8},()=>generateToken('temporary-session-owner',2));}finally{Date.now=clock;}
 assert.equal(new Set(tokens).size,tokens.length);const claims=tokens.map(token=>jwt.verify(token,process.env.JWT_SECRET));assert.equal(new Set(claims.map(c=>c.iat)).size,1);assert.equal(new Set(claims.map(c=>c.exp)).size,1);assert.ok(claims.every(c=>c.userId==='temporary-session-owner'&&c.tokenVersion===2));
});
