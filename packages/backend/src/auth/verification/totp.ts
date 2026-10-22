import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4226 dynamic truncation. HMAC-SHA1 here is an OTP primitive, never password storage. */
export function hotp(secret:Buffer,counter:bigint,digits:6|8=6):string{
 if(secret.length<20||counter<0n||counter>0xffffffffffffffffn||![6,8].includes(digits))throw new Error('Invalid OTP parameters');
 const moving=Buffer.alloc(8);moving.writeBigUInt64BE(counter);
 const digest=createHmac('sha1',secret).update(moving).digest();
 const offset=digest[digest.length-1]&15;
 return String((digest.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');
}
export function encodeSecret(bytes:Buffer):string{
 if(bytes.length!==20)throw new Error('Invalid OTP secret');
 let value=0,bits=0,out='';
 for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=ALPHABET[(value>>>bits)&31];}}
 return out;
}
export function decodeSecret(secret:string):Buffer{
 if(typeof secret!=='string'||!/^[A-Z2-7]{32}$/.test(secret))throw new Error('Invalid OTP secret');
 let value=0,bits=0;const out:number[]=[];
 for(const char of secret){value=(value<<5)|ALPHABET.indexOf(char);bits+=5;if(bits>=8){bits-=8;out.push((value>>>bits)&255);}}
 return Buffer.from(out);
}
export const newTotpSecret=()=>encodeSecret(randomBytes(20));
/** Return the matched time step; the caller must atomically persist it to prevent replay. */
export function matchTotp(secret:string,code:unknown,nowMs:number,lastCounter:number):number|null{
 if(typeof code!=='string'||!/^\d{6}$/.test(code)||!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(lastCounter)||lastCounter< -1)return null;
 const key=decodeSecret(secret),current=Math.floor(nowMs/30000),given=Buffer.from(code);let matched:number|null=null;
 try{for(const counter of [current-1,current,current+1]){
  if(counter<0)continue;
  const equal=timingSafeEqual(Buffer.from(hotp(key,BigInt(counter))),given);
  if(equal&&counter>lastCounter)matched=Math.max(matched??counter,counter);
 }}finally{key.fill(0);}
 return matched;
}
