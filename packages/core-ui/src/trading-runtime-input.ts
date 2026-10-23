import {parsePaperLocalExpiry} from './trading-account-setup-input';
/** Exact integer units only; buy values are minor units, never inferred decimal currency amounts. */
export function parseRuntimeInteger(value:string,min:number,max:number,label:string){
 const text=value.trim();if(text.length>16||!/^\d+$/.test(text))throw Error(`Enter a whole number for ${label}.`);
 const n=BigInt(text);if(n<BigInt(min)||n>BigInt(max))throw Error(`${label} must be between ${min} and ${max}.`);return Number(n);
}
export function captureRuntimeDraft(botId:string,draft:{symbol:string;side:string;amount:string;expiry:string;attempts:string;interval:string},now=Date.now()){
 const symbol=draft.symbol.trim();if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(symbol))throw Error('Enter one exact saved symbol.');
 if(!['buy','sell'].includes(draft.side))throw Error('Choose Buy or Sell.');
 let expiresAt:number;try{expiresAt=parsePaperLocalExpiry(draft.expiry,now);}catch(error){throw Error(error instanceof Error?error.message.replace('Policy expiry','Consent expiry'):'Choose a valid expiry.');}
 return {botId,strategy:{kind:'fixed-paper-order' as const,version:1 as const,symbol,side:draft.side as 'buy'|'sell',amount:parseRuntimeInteger(draft.amount,1,1e12,'amount')},limits:{expiresAt,maxAttempts:parseRuntimeInteger(draft.attempts,1,1000,'maximum attempts'),cadenceMs:parseRuntimeInteger(draft.interval,1,86400,'interval seconds')*1000}};
}
