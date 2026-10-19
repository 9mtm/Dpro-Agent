import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionModel,subscriptionArgs,subscriptionAnswer,runSubscription} from '../src/services/subscription-chat.ts';
test('subscription ids and outputs accept only reviewed providers and assistant text',()=>{
 assert.equal(subscriptionModel('subscription:claude'),true);assert.equal(subscriptionModel('subscription:codex:'+'a'.repeat(32)),true);
 for(const s of ['subscription:claude:../private','subscription:other','claude-cli'])assert.equal(subscriptionModel(s),false);
 assert.equal(subscriptionAnswer('claude',JSON.stringify({type:'result',result:'OK'})),'OK');
 assert.throws(()=>subscriptionAnswer('claude',JSON.stringify({type:'result',result:'failure',is_error:true})));
 assert.throws(()=>subscriptionAnswer('claude',JSON.stringify({type:'result',is_error:true,api_error_code:'oauth_not_allowed_for_organization',result:'untrusted'})),/subscription_org_blocked/);
 assert.equal(subscriptionAnswer('codex',[{type:'item.completed',item:{type:'command_execution',text:'hidden'}},{type:'item.completed',item:{type:'agent_message',text:'OK'}}].map(x=>JSON.stringify(x)).join('\n')),'OK');
 assert.throws(()=>subscriptionAnswer('codex',JSON.stringify({type:'turn.failed'})));
});
test('native restriction flags stay enabled and disabled/isolated calls never spawn',async()=>{
 const a=subscriptionArgs('claude'),b=subscriptionArgs('codex');assert.ok(a.includes('--restricted'));assert.ok(a.includes('--strict-mcp-config'));assert.ok(a.includes('--safe-mode'));assert.ok(b.includes('--ignore-user-config'));assert.ok(b.includes('workspace-write'));assert.ok(![...a,...b].some(x=>/dangerously|bypass/i.test(x)));
 const old=process.env.DPRO_SUBSCRIPTION_CHAT,iso=process.env.AGENT_PLAYER_ISOLATED;
 try{delete process.env.DPRO_SUBSCRIPTION_CHAT;await assert.rejects(runSubscription('subscription:claude','/','test',new AbortController().signal));process.env.DPRO_SUBSCRIPTION_CHAT='1';process.env.AGENT_PLAYER_ISOLATED='1';await assert.rejects(runSubscription('subscription:codex','/','test',new AbortController().signal));}finally{if(old===undefined)delete process.env.DPRO_SUBSCRIPTION_CHAT;else process.env.DPRO_SUBSCRIPTION_CHAT=old;if(iso===undefined)delete process.env.AGENT_PLAYER_ISOLATED;else process.env.AGENT_PLAYER_ISOLATED=iso;}
});

test('subscription project boundary refuses filesystem root before launching',async()=>{
 const old=process.env.DPRO_SUBSCRIPTION_CHAT,iso=process.env.AGENT_PLAYER_ISOLATED;
 try{process.env.DPRO_SUBSCRIPTION_CHAT='1';delete process.env.AGENT_PLAYER_ISOLATED;await assert.rejects(runSubscription('subscription:codex','/','never launch',new AbortController().signal));}
 finally{if(old===undefined)delete process.env.DPRO_SUBSCRIPTION_CHAT;else process.env.DPRO_SUBSCRIPTION_CHAT=old;if(iso===undefined)delete process.env.AGENT_PLAYER_ISOLATED;else process.env.AGENT_PLAYER_ISOLATED=iso;}
});

test('previous native sessions are forked rather than appended',()=>{
 const id='00000000-0000-4000-8000-000000000000';
 assert.ok(subscriptionArgs('claude',id).includes('--fork-session'));
 assert.deepEqual(subscriptionArgs('codex',id).slice(-3),['fork',id,'-']);
});
