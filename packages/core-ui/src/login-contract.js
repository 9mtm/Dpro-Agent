/** The emitted device token shape; possession never establishes authentication. */
export const validDeviceToken = value => typeof value === 'string' && value.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(value);
export function validLoginBody(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['email', 'password', 'deviceToken', 'verification', 'recovery'].includes(key))
    && Object.hasOwn(body, 'email') && Object.hasOwn(body, 'password')
    && typeof body.email === 'string' && body.email.length > 0 && body.email.length <= 320
    && typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 4096
    && (!Object.hasOwn(body,'recovery') || typeof body.recovery==='boolean')
    && (!Object.hasOwn(body,'verification') || validVerification(body.verification,body.recovery===true))
    && (!Object.hasOwn(body, 'deviceToken') || validDeviceToken(body.deviceToken));
}

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function validVerification(value,recovery){
 return record(value)&&Object.keys(value).length===3&&['challenge','nonce','code'].every(key=>Object.hasOwn(value,key))
  &&validDeviceToken(value.challenge)&&validDeviceToken(value.nonce)&&typeof value.code==='string'
  &&(recovery?/^[a-f0-9]{32}$/:/^[0-9]{6}$/).test(value.code);
}
/** Undefined means ordinary login; malformed/ambiguous continuation always fails closed. */
export function loginContinuation(body){
 if(!record(body))throw Error('Invalid sign-in response');
 if(Object.hasOwn(body,'verificationRequired')){
  if(body.verificationRequired!==true||!validDeviceToken(body.challenge)||!validDeviceToken(body.nonce)||!['totp','recovery'].includes(body.verificationMethod)||!Number.isSafeInteger(body.expiresAt)||body.expiresAt<0||['user','token','deviceToken','recovered','requiresSignIn'].some(key=>Object.hasOwn(body,key)))throw Error('Invalid sign-in challenge');
  return {verificationRequired:true,challenge:body.challenge,nonce:body.nonce,expiresAt:body.expiresAt,verificationMethod:body.verificationMethod};
 }
 if(Object.hasOwn(body,'recovered')||Object.hasOwn(body,'requiresSignIn')){
  if(body.recovered!==true||body.requiresSignIn!==true||['user','token','deviceToken','challenge','nonce','expiresAt','verificationMethod'].some(key=>Object.hasOwn(body,key)))throw Error('Invalid recovery response');
  return {recovered:true,requiresSignIn:true};
 }
 if(['challenge','nonce','verificationMethod','expiresAt'].some(key=>Object.hasOwn(body,key)))throw Error('Ambiguous sign-in response');
 return undefined;
}
