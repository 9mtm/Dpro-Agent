export function reviewerRoute(path:string):boolean;
export function reviewerOwnerRoute(path:string):boolean;
export function allowedReviewer(method:string,path:string,body?:unknown):boolean;
export function reviewerResponse(path:string,status:number,body:unknown):Record<string,unknown>;
