export const TEMPLATES_PATH:string;
export const templateCategories:readonly string[];
export const templateDrawers:readonly string[];
export function validTemplateConfig(value:unknown):boolean;
export function templatePath(path:string):boolean;
export function allowedTemplates(method:string,path:string,body?:unknown):boolean;
export function templatesResponse(path:string,status:number,body:unknown):unknown;
