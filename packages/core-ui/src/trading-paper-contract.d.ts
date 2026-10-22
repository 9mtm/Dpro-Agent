export function tradingPaperRoute(path:string):{kind:'availability';accountId?:never}|{accountId:string;kind?:never}|null;
export function allowedTradingPaper(method:string,path:string,body?:unknown):boolean;
export function tradingPaperResponse(path:string,status:number,body:unknown):Record<string,unknown>;
