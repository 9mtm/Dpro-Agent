export const GENVR_BYTES:number;
export const GENVR_PATH:string;
export function genvrId(value:unknown):value is string;
export function validStudioProject(value:unknown):boolean;
export function genvrRoute(path:string):boolean;
export function allowedGenVR(method:string,path:string,body?:unknown):boolean;
export function genvrResponse(path:string,status:number,body:unknown):unknown;

export const GENVR_AGENTS:string;
export function validGenVRTeam(value:unknown):boolean;

export function genvrMarket(path:string):boolean;
