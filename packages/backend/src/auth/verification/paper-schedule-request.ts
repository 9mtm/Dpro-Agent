/** Dedicated owner identity for paper schedule reads/emergency stop. No factor-table dependency. */
import {createHash} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import {AuthTokenError,verifyRequestTokenAsync} from '../jwt.js';
import {isSystemAccount} from '../default-accounts.js';
import {ReviewerIdentityError} from './reviewer-request.js';
import {userActor} from '../../repositories/actor.js';
import {sql,one} from '../../repositories/sql-steps.js';
import type {OperationContext} from './operation-proof.js';
export async function paperScheduleOwnerRequestIdentity(request:FastifyRequest){
 const authorization=request.headers.authorization;
 if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||authorization.length<=7)throw new AuthTokenError('Unauthorized: Bearer required');
 const verified=await verifyRequestTokenAsync(request);
 const row=await sql().read(one<{role:string;status:string;email_verified:number;token_version:number}>('SELECT role,status,email_verified,token_version FROM users WHERE id=?',verified.userId));
 const actor=request.actor;
 if(isSystemAccount(verified.userId)||verified.userId.length>128||!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||!row||row.role!=='owner'||row.status!=='active'||Number(row.email_verified)!==1)throw new ReviewerIdentityError();
 if(request.headers.authorization!==authorization||row.role!==verified.user.role||!Number.isSafeInteger(Number(row.token_version))||Number(row.token_version)<1||Number(row.token_version)!==Number(verified.user.token_version??1))throw new AuthTokenError('Unauthorized: Account changed');
 const context:OperationContext=Object.freeze({userId:verified.userId,sessionHash:createHash('sha256').update(authorization.slice(7)).digest('hex'),tokenVersion:Number(row.token_version),factorVersion:0});
 return Object.freeze({actor:userActor({id:verified.userId,role:row.role}),context});
}
