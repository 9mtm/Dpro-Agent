export function schedulerRoute(path:string):{kind:string;id?:string}|null;
export function allowedScheduler(method:string,path:string,body?:unknown):boolean;
export function schedulerResponse(path:string,status:number,body:unknown):unknown;
