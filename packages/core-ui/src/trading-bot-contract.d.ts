export type TradingBotRoute = {kind:'list'|'stage'} | {kind:'review'|'challenge'|'complete'|'apply';reviewId:string} | {kind:'stop'|'revoke';botId:string};
export type TradingBotDescriptor = {botId:string;accountId:string;policyId:string;policyRevision:number;appRevision:number;currency:string;expiresAt:number;maxSuccessfulTicks:number;cooldownMs:number;status:'active'|'expired'|'stopped'|'revoked';successfulTicks:number;lastSuccessAt:number|null;createdAt:number;running:false};
export type TradingBotList = {mode:'paper';running:false;bots:TradingBotDescriptor[];hasMore:boolean};
export type TradingBotReview = {ok:true;id:string;botId:string;expiresAt:number;accountId:string;policyId:string;policyRevision:number;appRevision:number;currency:string;botExpiresAt:number;maxSuccessfulTicks:number;cooldownMs:number;symbols:string[];limits:{symbols:string[];maxOrder:number;maxExposure:number;maxDailyLoss:number;maxOrders:number;cooldownMs:number;maxQuoteAgeMs:number};execution:{feeBps:number;slippageBps:number;unitScale:1}};
export type TradingBotApply = {ok:true;botId:string;reviewId:string;replayed:boolean};
export type TradingBotStop = {mode:'paper';botId:string;status:'stopped'|'revoked';running:false};
export function tradingBotRoute(path:string):TradingBotRoute|null;
export function allowedTradingBot(method:string,path:string,body?:unknown):boolean;
export function tradingBotResponse(path:string,status:number,body:unknown):Record<string,unknown>;
