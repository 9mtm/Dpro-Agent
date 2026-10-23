require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const helper=require('../src/trading-account-setup-input.ts');
test('exact cents and maximum money never round binary fractions or accept ambiguous syntax',()=>{
 for(const [text,minor]of [['0.01',1],['0.1',10],['1',100],['1.99',199],['1234567890.12',123456789012],['10000000000.00',1000000000000],[' 12.30 ',1230]])assert.equal(helper.parsePaperMoney(text),minor);
 assert.equal(helper.formatPaperMinor(123456789012,'EUR'),'1234567890.12 EUR');assert.equal(helper.formatPaperMinor(1,'GBP'),'0.01 GBP');
 for(const text of ['', '0','0.00','10000000000.01','0.001','1.999','1e3','+1','-1','1,00','1,000.00','.01','1.','Infinity','9'.repeat(100)])assert.throws(()=>helper.parsePaperMoney(text));assert.throws(()=>helper.formatPaperMinor(1,'JPY'));
});
test('fee percentages require explicit zero and become exact basis points',()=>{
 for(const [text,bps]of [['0',0],['0.00',0],['0.01',1],['12.34',1234],['100.00',10000]])assert.equal(helper.parsePaperPercent(text),bps);assert.equal(helper.formatPaperPercent(1),'0.01%');for(const text of ['', '100.01','0.001','1e1','1,00','-0'])assert.throws(()=>helper.parsePaperPercent(text));
 assert.equal(helper.parsePaperWhole('0',0,86400,'seconds'),0);assert.equal(helper.parsePaperWhole('300',1,300,'seconds'),300);for(const text of ['', '1.0','1e2','-1'])assert.throws(()=>helper.parsePaperWhole(text,0,86400,'seconds'));
});
test('symbols preserve exact case and reject duplicate/widened identifiers',()=>{
 assert.deepEqual(helper.parsePaperSymbols(' AAA, bbb\tCCC '),['AAA','bbb','CCC']);for(const text of ['', 'AAA AAA','A/B','a'.repeat(129),Array.from({length:101},(_,i)=>'S'+i).join(',')])assert.throws(()=>helper.parsePaperSymbols(text));
});
test('local expiry rejects calendar normalization and nonexistent DST time in a real timezone process',()=>{
 const script=`require('./tests/load.cjs');const h=require('./src/trading-account-setup-input.ts'),assert=require('node:assert/strict');const now=new Date(2026,2,20).getTime();assert.throws(()=>h.parsePaperLocalExpiry('2026-03-29T02:30',now));assert.throws(()=>h.parsePaperLocalExpiry('2026-02-30T12:00',now));const valid=h.parsePaperLocalExpiry('2026-03-29T03:30',now);assert.equal(new Date(valid).getHours(),3);assert.match(h.paperLocalTime(valid),/2026/);`;
 execFileSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,TZ:'Europe/Vienna'},stdio:'pipe'});
 assert.throws(()=>helper.parsePaperLocalExpiry('',Date.now()));assert.throws(()=>helper.parsePaperLocalExpiry('2026-01-01T12:00',Date.now()));
});
