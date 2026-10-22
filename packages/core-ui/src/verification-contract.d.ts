export const VERIFICATION_PATH:'/api/auth/verification';
export function verificationRoute(path:string):boolean;
export function allowedVerification(method:string,path:string,body?:unknown):boolean;
export type VerificationResponse={enabled:boolean}|{secret:string;expiresAt:number}|{requiresSignIn:true;recoveryCodes?:string[]}|{code:'verification_refused'|'rate_limited'|'unauthenticated'|'inactive_user'|'forbidden'};
export function verificationResponse(path:string,status:number,body:unknown):VerificationResponse|null;
