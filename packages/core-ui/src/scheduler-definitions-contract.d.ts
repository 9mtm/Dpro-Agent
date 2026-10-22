export function scheduleDefinitionRoute(path:string):boolean;
export function allowedScheduleDefinition(method:string,path:string,body?:unknown):boolean;
export function scheduleDefinitionResponse(path:string,status:number,body:unknown):Record<string,unknown>;
