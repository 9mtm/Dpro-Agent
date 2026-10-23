/** Explicit first-form units: USD/EUR/GBP use 100 minor units. No floating-point rounding. */
export const PAPER_INPUT_CURRENCIES=Object.freeze(['USD','EUR','GBP'] as const);
function decimal(value:string,min:bigint,max:bigint,label:string){
 const text=value.trim();if(text.length>32||!/^\d+(?:\.\d{1,2})?$/.test(text))throw Error(`Use a decimal point for ${label}, for example 100.00. No signs, commas or extra decimal places.`);
 const [whole,fraction='']=text.split('.'),units=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(units<min||units>max)throw Error(`${label} is outside the supported range.`);return Number(units);
}
export function parsePaperMoney(value:string){return decimal(value,1n,1000000000000n,'amount');}
export function parsePaperPercent(value:string){return decimal(value,0n,10000n,'percentage');}
export function parsePaperWhole(value:string,min:number,max:number,label:string){
 const text=value.trim();if(text.length>12||!/^\d+$/.test(text))throw Error(`Enter whole ${label}.`);const result=BigInt(text);if(result<BigInt(min)||result>BigInt(max))throw Error(`${label} must be between ${min} and ${max}.`);return Number(result);
}
export function parsePaperSymbols(value:string){
 const symbols=value.trim().split(/[\s,]+/).filter(Boolean);if(symbols.length<1||symbols.length>100||new Set(symbols).size!==symbols.length||symbols.some(s=>s.length>128||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(s)))throw Error('Enter 1–100 unique exact symbols, separated by commas or spaces.');return symbols;
}
export function parsePaperLocalExpiry(value:string,now=Date.now()){
 const text=value.trim();if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text))throw Error('Choose a valid local date and time.');
 const [year,month,day,hour,minute]=text.split(/[-T:]/).map(Number),date=new Date(year,month-1,day,hour,minute,0,0),epoch=date.getTime();
 if(!Number.isSafeInteger(epoch)||date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute)throw Error('This local date or time does not exist. Choose another time.');
 if(epoch<=now||epoch-now>30*86400000)throw Error('Policy expiry must be in the future and within 30 days.');return epoch;
}
export function formatPaperMinor(value:number,currency:string){
 if(!PAPER_INPUT_CURRENCIES.includes(currency as typeof PAPER_INPUT_CURRENCIES[number])||!Number.isSafeInteger(value)||value<0)throw Error('Unsupported amount.');const units=BigInt(value);return `${units/100n}.${String(units%100n).padStart(2,'0')} ${currency}`;
}
export function formatPaperPercent(value:number){if(!Number.isSafeInteger(value)||value<0||value>10000)throw Error('Unsupported percentage.');const units=BigInt(value);return `${units/100n}.${String(units%100n).padStart(2,'0')}%`;}
export function paperLocalTime(value:number){return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'long'}).format(new Date(value));}
