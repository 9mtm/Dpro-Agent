export function skillInstallRoute(path:string):boolean;
export function allowedSkillInstall(method:string,path:string,body?:unknown):boolean;
export function skillInstallResponse(path:string,status:number,body:unknown):Record<string,unknown>;
