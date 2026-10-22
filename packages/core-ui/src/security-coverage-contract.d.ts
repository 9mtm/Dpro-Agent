export const COVERAGE_PATH:string;
export function coverageRoute(path:string):boolean;
export function allowedCoverage(method:string,path:string,body?:unknown):boolean;
export function coverageResponse(status:number,body:unknown):unknown;
