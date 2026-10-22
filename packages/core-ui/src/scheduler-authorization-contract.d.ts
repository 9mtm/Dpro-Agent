export function scheduleAuthorizationRoute(path:string):boolean;
export function allowedScheduleAuthorization(method:string,path:string,body?:unknown):boolean;
export function scheduleAuthorizationResponse(path:string,status:number,body:unknown):Record<string,unknown>;

export function projectScheduledReview(value:unknown,definitionHash:string):Record<string,unknown>;
