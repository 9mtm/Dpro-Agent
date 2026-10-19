'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {configureBranding} = require('../src/branding.cjs');
test('new display name retains legacy profile before the name changes', () => {
  const calls=[];
  configureBranding({getPath: name=>{assert.equal(name,'appData');return '/private/application-data';},setPath:(...args)=>calls.push(['path',...args]),setName:name=>calls.push(['name',name])});
  assert.deepEqual(calls,[['path','userData',path.join('/private/application-data','Dpro')],['name','Dpro Agent']]);
});
