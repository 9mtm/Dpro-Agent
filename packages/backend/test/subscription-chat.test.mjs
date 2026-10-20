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

test('the CLIs are found in the usual install folders even with a short PATH (an app opened from the Dock)',async()=>{
 const {mkdtempSync,mkdirSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {subscriptionSearchDirs}=await import('../src/services/subscription-chat.ts');
 const home=mkdtempSync(join(tmpdir(),'ap-cli-dirs-'));
 for(const v of ['v22.1.0','v24.21.0'])mkdirSync(join(home,'.local','share','fnm','node-versions',v,'installation','bin'),{recursive:true});
 mkdirSync(join(home,'.nvm','versions','node','v20.0.0','bin'),{recursive:true});
 const dirs=await subscriptionSearchDirs(home,'/usr/bin:/bin:relative/dir');
 assert.equal(dirs[0],join(home,'.local','bin'));
 assert.ok(dirs.includes('/usr/bin')&&dirs.includes('/opt/homebrew/bin'));
 assert.ok(!dirs.includes('relative/dir'),'relative PATH entries are ignored');
 const fnm=dirs.filter(d=>d.includes('fnm'));
 assert.deepEqual(fnm,[join(home,'.local','share','fnm','node-versions','v24.21.0','installation','bin'),join(home,'.local','share','fnm','node-versions','v22.1.0','installation','bin')],'newest node first');
 assert.ok(dirs.includes(join(home,'.nvm','versions','node','v20.0.0','bin')));
});

test('ask_coding_app: owner approval always; desktop only; project folder only; never for outside senders (CORE-ROUTE-01)',async()=>{
 const {askCodingAppTool}=await import('../src/tools/cli/ask-coding-app.ts');
 const {approvalCategory}=await import('../src/tools/approvals.ts');
 assert.equal(approvalCategory(askCodingAppTool),'other','every call waits for the owner');
 assert.ok(!askCodingAppTool.selfOnly,'needs a grant per agent');
 const text=r=>r.content[0].text;
 const old=process.env.DPRO_SUBSCRIPTION_CHAT,iso=process.env.AGENT_PLAYER_ISOLATED;
 try{
  delete process.env.DPRO_SUBSCRIPTION_CHAT;delete process.env.AGENT_PLAYER_ISOLATED;
  assert.match(text(await askCodingAppTool.execute({app:'claude',request:'hi'},{workspaceDir:'/tmp',fileReadRoot:'/tmp'})),/only in the Dpro desktop app/);
  process.env.DPRO_SUBSCRIPTION_CHAT='1';
  assert.match(text(await askCodingAppTool.execute({app:'claude',request:'hi'},{workspaceDir:'/tmp',fileReadRoot:'/tmp'})),/Only the owner/,'no owner turn → refused before anything starts');
  assert.match(text(await askCodingAppTool.execute({app:'codex',request:'hi'},{workspaceDir:'/tmp',fileReadRoot:'/tmp',toolPolicy:{channel:'telegram'}})),/not available for outside senders/);
  assert.match(text(await askCodingAppTool.execute({app:'other',request:'hi'},{workspaceDir:'/tmp',fileReadRoot:'/tmp'})),/must be "claude" or "codex"/);
  assert.match(text(await askCodingAppTool.execute({app:'claude',request:'  '},{workspaceDir:'/tmp',fileReadRoot:'/tmp'})),/empty/);
  const {isExecClassTool,isToolAllowedByExecPolicy}=await import('../src/tools/exec-policy.ts');
  assert.ok(isExecClassTool('ask_coding_app')&&askCodingAppTool.execClass,'exec-class: off unless AGENT_EXEC_TOOLS=true');
  const ex=process.env.AGENT_EXEC_TOOLS;delete process.env.AGENT_EXEC_TOOLS;assert.equal(isToolAllowedByExecPolicy('ask_coding_app'),false);if(ex!==undefined)process.env.AGENT_EXEC_TOOLS=ex;
 }finally{if(old===undefined)delete process.env.DPRO_SUBSCRIPTION_CHAT;else process.env.DPRO_SUBSCRIPTION_CHAT=old;if(iso===undefined)delete process.env.AGENT_PLAYER_ISOLATED;else process.env.AGENT_PLAYER_ISOLATED=iso;}
});

test('a coding app can be asked to use one of its own models (CORE-PICKER-02)',async()=>{
 const {subscriptionModel,subscriptionVariant,subscriptionArgs,subscriptionVariants}=await import('../src/services/subscription-chat.ts');
 for(const ok of ['subscription:claude/opus','subscription:codex/gpt-6.1-sol','subscription:claude:'+'a'.repeat(32)+'/sonnet'])assert.equal(subscriptionModel(ok),true,ok);
 for(const bad of ['subscription:claude/-x','subscription:claude/Opus','subscription:claude/a b','subscription:codex/'+'a'.repeat(50),'subscription:claude//opus'])assert.equal(subscriptionModel(bad),false,bad);
 assert.equal(subscriptionVariant('subscription:claude/opus'),'opus');assert.equal(subscriptionVariant('subscription:claude'),undefined);
 const a=subscriptionArgs('claude',undefined,'opus');assert.deepEqual(a.slice(-2),['--model','opus']);
 const b=subscriptionArgs('codex',undefined,'gpt-6.1-sol');assert.deepEqual(b.slice(0,3),['exec','-m','gpt-6.1-sol']);assert.equal(b.at(-1),'-');
 assert.ok(!subscriptionArgs('claude',undefined,'--dangerously').includes('--dangerously'),'a bad name never reaches the command line');
 assert.deepEqual((await subscriptionVariants('claude')).map(v=>v.id),['fable','opus','sonnet','haiku']);
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'ap-codex-models-'));mkdirSync(join(home,'.codex'));
 writeFileSync(join(home,'.codex','models_cache.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',visibility:'list'},{slug:'hidden-one',display_name:'H',visibility:'hide'},{slug:'Bad Slug',visibility:'list'}]}));
 assert.deepEqual(await subscriptionVariants('codex',home),[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}]);
 assert.deepEqual(await subscriptionVariants('codex',join(home,'missing')),[]);
});

test('a chat without a project folder gets its own private folder for the coding app (CORE-PICKER-03)',async()=>{
 const {mkdtempSync,existsSync,statSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {chatWorkspace,removeChatWorkspace,chatWorkspacesRoot}=await import('../src/services/subscription-chat.ts');
 const old=process.env.DPRO_CHAT_WORKSPACES;process.env.DPRO_CHAT_WORKSPACES=mkdtempSync(join(tmpdir(),'ap-chat-ws-'));
 try{
  const dir=await chatWorkspace('conv-0123456789');
  assert.equal(dir,join(chatWorkspacesRoot(),'conv-0123456789'));assert.ok(statSync(dir).isDirectory());
  assert.equal((statSync(dir).mode&0o777).toString(8),'700','only the owner can open it');
  await assert.rejects(chatWorkspace('../escape'));await assert.rejects(chatWorkspace('short'));
  await removeChatWorkspace('conv-0123456789');assert.equal(existsSync(dir),false);
  await removeChatWorkspace('../../etc');
 }finally{if(old===undefined)delete process.env.DPRO_CHAT_WORKSPACES;else process.env.DPRO_CHAT_WORKSPACES=old;}
});
