export type TradingRuntimeStrategy={kind:'fixed-paper-order';version:1;symbol:string;side:'buy'|'sell';amount:number};
export type TradingRuntimeLimits={expiresAt:number;maxAttempts:number;cadenceMs:number};
export type TradingRuntimeInput={botId:string;strategy:TradingRuntimeStrategy;limits:TradingRuntimeLimits};
export type TradingRuntimeRoute={kind:'reference';botId:string}|{kind:'stage'}|{kind:'review'|'challenge'|'complete'|'apply';reviewId:string}|{kind:'consent'|'revoke';consentId:string};
export function tradingRuntimeRoute(path:string):TradingRuntimeRoute|null;
export function allowedTradingRuntime(method:string,path:string,body?:unknown):boolean;
export function tradingRuntimeResponse(path:string,status:number,body:unknown):Record<string,unknown>;
