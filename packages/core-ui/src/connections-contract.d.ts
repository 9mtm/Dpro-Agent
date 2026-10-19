export type ConnectionStatus='not_connected'|'connecting'|'connected'|'expired'|'error';
export type Connection={id:'genvr';name:'Genvr';status:ConnectionStatus;account:{name:string}|null;scopes:string[];linkedAt:string|null;expiresAt:string|null;pending:{userCode:string;verificationUri:string;expiresAt:string}|null;error:string|null};
export type Publication={localId:string;serverId:string;title:string;status:'draft'|'published';version:number;access:string;link:string|null;updatedAt:string};
export const CONNECTIONS_PATH:'/api/connections';
export function connectionsRoute(path:string):boolean;
export function allowedConnections(method:string,path:string,body?:unknown):boolean;
export function connectionsResponse(path:string,status:number,body:unknown):unknown;
