export type ChannelState={id:string;enabled:boolean;state:string;configured:boolean;hasSecrets:boolean;allowedUsers:string[];allowedChannels:string[]};
export type ChannelEntry=ChannelState&{label:string;runtime:'node'|'python';requiredEnv:string[];prerequisites:string};
export const AGENT_CONNECT_PATH:'/api/agent-connect';
export function channelRoute(path:string):boolean;
export function allowedChannel(method:string,path:string,body?:unknown):boolean;
export function channelResponse(path:string,status:number,body:unknown):unknown;
