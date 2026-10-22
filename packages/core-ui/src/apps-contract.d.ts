export const APPS_CATALOGUE_PATH:string;
export function appsCatalogueRoute(path:string):boolean;
export function allowedAppsCatalogue(method:string,path:string,body?:unknown):boolean;
export function appsCatalogueResponse(status:number,body:unknown):unknown;
export const SOURCE_CATALOGUE_PATH:string;
export function sourceCatalogueRoute(path:string):boolean;
export function allowedSourceCatalogue(method:string,path:string,body?:unknown):boolean;
export function sourceCatalogueResponse(status:number,body:unknown):unknown;
