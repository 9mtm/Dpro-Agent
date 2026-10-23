export type TradingAccountSetupInput={currency:string;initialCashMinor:number;policy:{expiresAt:number;symbols:string[];maxOrder:number;maxExposure:number;maxDailyLoss:number;maxOrders:number;cooldownMs:number;maxQuoteAgeMs:number};execution:{feeBps:number;slippageBps:number}};
export type TradingAccountSetupRoute={kind:'stage'}|{kind:'review'|'challenge'|'complete'|'apply';reviewId:string};
export type TradingAccountSetupReview=Omit<TradingAccountSetupInput,'execution'>&{ok:true;id:string;expiresAt:number;appId:'trading';version:'1.0.0';mode:'paper';accountId:string;policyId:string;installationRevision:1;appRevision:1;policyRevision:1;profileRevision:1;execution:{feeBps:number;slippageBps:number;unitScale:1};runtimeConnected:false;createsAccount:true;startsBot:false;connectsBroker:false};
export type TradingAccountSetupApply={ok:true;reviewId:string;setupId:string;result:{accountId:string;policyId:string;appRevision:1;policyRevision:1;profileRevision:1;mode:'paper';runtimeConnected:false};replayed:boolean};
export function tradingAccountSetupRoute(path:string):TradingAccountSetupRoute|null;
export function allowedTradingAccountSetup(method:string,path:string,body?:unknown):boolean;
export function tradingAccountSetupResponse(path:string,status:number,body:unknown):Record<string,unknown>;
