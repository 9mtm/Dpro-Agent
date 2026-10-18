export const SKILLS_PATH:string;
export function skillLibraryPath(path:string):boolean;
export function allowedSkillLibrary(method:string,path:string,body?:unknown):boolean;
export function skillLibraryResponse(path:string,status:number,body:unknown):unknown;
