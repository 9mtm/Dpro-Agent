import {addonCatalogue} from '../../services/addon-catalogue.js';
import type {FastifyInstance} from 'fastify';
import {authorizeActiveRole} from '../../auth/route-guards.js';
import {isLoopbackPeer} from './terminal.js';
import {chatAddons} from '../../services/chat-addons.js';
export async function chatAddonsRoutes(app:FastifyInstance,options:{home?:string}={}){
 app.get('/api/chat/addons/catalogue',{config:{access:'owner'}},async(request,reply)=>{
  if(!authorizeActiveRole(request,reply,['owner']))return;
  if(!isLoopbackPeer(request))return reply.code(403).send({code:'not_loopback'});
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  return addonCatalogue(options.home);
 });
 app.get('/api/chat/addons',{config:{access:'owner'}},async(request,reply)=>{
  if(!authorizeActiveRole(request,reply,['owner']))return;
  if(!isLoopbackPeer(request))return reply.code(403).send({code:'not_loopback'});
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  return chatAddons(options.home);
 });
}
