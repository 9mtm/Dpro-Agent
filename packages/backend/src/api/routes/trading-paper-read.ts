import type {FastifyInstance,FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
import {readPaperAvailability} from '../../services/trading-paper-availability.js';
import {readPaperAccount} from '../../services/trading-paper-ledger.js';
const unavailable={code:'paper_account_unavailable'};
/** Read-only optional adapter. Caller must supply an explicitly provisioned isolated ledger. */
export async function tradingPaperReadRoutes(app:FastifyInstance,options:{ledger:()=>Database.Database|null}){
 app.get('/api/trading-paper/availability',{config:{access:'owner'}},async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  try{
   const verified=await verifyRequestTokenAsync(request),actor=request.actor;
   if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner')return reply.code(403).send({code:'forbidden'});
   if(Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send({code:'invalid_paper_account'});
   return readPaperAvailability(options.ledger(),verified.userId);
  }catch(error){return reply.code(error instanceof AuthTokenError?401:503).send(error instanceof AuthTokenError?{code:'unauthenticated'}:unavailable);}
 });
 app.get('/api/trading-paper/accounts/:id',{config:{access:'owner'}},async(request,reply:FastifyReply)=>{
  reply.header('Cache-Control','no-store');
  try{
   const verified=await verifyRequestTokenAsync(request),actor=request.actor;
   if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner')return reply.code(403).send({code:'forbidden'});
   const {id}=request.params as {id:string};
   if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send({code:'invalid_paper_account'});
   const db=options.ledger();if(!db||!readPaperAvailability(db,verified.userId).readAccounts)return reply.code(503).send(unavailable);
   const snapshot=readPaperAccount(db,verified.userId,id);
   if(!snapshot.ok)return reply.code(404).send(unavailable);
   return snapshot;
  }catch(error){return reply.code(error instanceof AuthTokenError?401:503).send(error instanceof AuthTokenError?{code:'unauthenticated'}:unavailable);}
 });
}
