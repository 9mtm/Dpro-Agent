export function validDeviceToken(value: unknown): value is string;
export function validLoginBody(body: unknown): boolean;

export type LoginContinuation={verificationRequired:true;challenge:string;nonce:string;expiresAt:number;verificationMethod:'totp'|'recovery'}|{recovered:true;requiresSignIn:true};
export function loginContinuation(body:unknown):LoginContinuation|undefined;
