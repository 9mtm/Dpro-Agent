import test from 'node:test';
import assert from 'node:assert/strict';
import {envDatabase} from '../src/discovery/project-tech.ts';
test('database URL metadata keeps authority and database without user or password',()=>{
 const result=envDatabase('DATABASE_URL=postgres://sample:PRIVATE_PASSWORD@database.example:5432/application');
 assert.deepEqual(result,{engine:'postgres',host:'database.example',port:'5432',database:'application'});
 assert.ok(!JSON.stringify(result).includes('PRIVATE_PASSWORD'));
});
test('opaque and hostless database URLs cannot project credentials as database names',()=>{
 for(const value of ['postgres:sample:PRIVATE_PASSWORD@host/db','postgres:/sample:PRIVATE_PASSWORD@host/db','postgres:///sample:PRIVATE_PASSWORD@host/db','jdbc:postgres:sample:PRIVATE_PASSWORD@host/db'])assert.equal(envDatabase('DATABASE_URL='+value),null);
 const result=envDatabase('DATABASE_URL=postgres://database.example/sample:PRIVATE_PASSWORD@other/application');
 assert.equal(result.database,null);assert.ok(!JSON.stringify(result).includes('PRIVATE_PASSWORD'));
});
test('JDBC authority URLs are reparsed before any public fields are returned',()=>{
 assert.deepEqual(envDatabase('DATABASE_URL=jdbc:mysql://sample:PRIVATE_PASSWORD@database.example:3306/application'),{engine:'mysql',host:'database.example',port:'3306',database:'application'});
});
test('path userinfo fragments are removed even when authority credentials exist',()=>{
 const result=envDatabase('DATABASE_URL=postgres://sample:PRIVATE_PASSWORD@database.example/path:PRIVATE_SECOND@application');
 assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(result.database,'application');
});
