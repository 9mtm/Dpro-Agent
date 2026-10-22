import {createHash} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import {AuthTokenError,verifyRequestTokenAsync} from '../jwt.js';
import {isSystemAccount} from '../default-accounts.js';
import {userActor} from '../../repositories/actor.js';
import {sql,one} from '../../repositories/sql-steps.js';
import type {OperationContext} from './operation-proof.js';

export class ReviewerIdentityError extends Error {
 constructor(){super('Verified human account required');}
}

/** Authentication only. Policy assignment and request scope must still be checked by the operation. */
export async function reviewerRequestIdentity(request:FastifyRequest,ownerOnly=false){
 const actor=request.actor;
 if(actor&&(actor.kind!=='user'||actor.agentId!==undefined||actor.channel!==undefined))throw new ReviewerIdentityError();
 // Recheck the actual bearer even when the central gate has populated authUser/actor.
 const verified=await verifyRequestTokenAsync(request);
 if(isSystemAccount(verified.userId)||verified.userId.length>200)throw new ReviewerIdentityError();
 const row=await sql().read(one<{role:string;status:string;email_verified:number;token_version:number;factor_version:number;enabled:number}>(
  'SELECT u.role,u.status,u.email_verified,u.token_version,f.version AS factor_version,f.enabled FROM users u LEFT JOIN verification_factors f ON f.user_id=u.id WHERE u.id=?',verified.userId));
 if(!row||!['owner','admin','user'].includes(row.role)||row.status!=='active'||Number(row.email_verified)!==1||Number(row.enabled)!==1||!Number.isSafeInteger(Number(row.token_version))||Number(row.token_version)<1||!Number.isSafeInteger(Number(row.factor_version))||Number(row.factor_version)<1)throw new ReviewerIdentityError();
 if(row.role!==verified.user.role||Number(row.token_version)!==Number(verified.user.token_version??1))throw new AuthTokenError('Unauthorized: Account changed');
 if(ownerOnly&&row.role!=='owner')throw new ReviewerIdentityError();
 if(actor&&(actor.userId!==verified.userId||actor.role!==row.role))throw new ReviewerIdentityError();
 const authorization=request.headers.authorization;
 if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||authorization.length<=7)throw new AuthTokenError('Unauthorized: Bearer required');
 const context:OperationContext=Object.freeze({userId:verified.userId,tokenVersion:Number(row.token_version),factorVersion:Number(row.factor_version),sessionHash:createHash('sha256').update(authorization.slice(7)).digest('hex')});
 return Object.freeze({actor:userActor({id:verified.userId,role:row.role}),context});
}
