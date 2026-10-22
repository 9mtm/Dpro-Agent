export const CHAT_ADDONS_PATH:string;
export function chatAddonsRoute(path:string):boolean;
export function allowedChatAddons(method:string,path:string,body?:unknown):boolean;
export function chatAddonsResponse(status:number,body:unknown):unknown;
