// Chat avatar frame: one live avatar (SDK mountAvatarLive) that speaks the agent's replies
// with a saved voice from the local voice service. Same origin as Dpro; the parent page
// only sends text and display choices, never files or credentials.
const channel=location.hash.slice(1);
const send=value=>parent.postMessage({type:'dpro-avatar',channel,...value},location.origin);
const token=document.querySelector('meta[name="genvr-studio-token"]')?.content;
let live=null,speaking=Promise.resolve();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function voice(body){
 if(!token||!/^[a-f0-9]{64}$/.test(token))throw Error('The local voice service is not available.');
 const response=await fetch('/studio-bridge/voice',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 let data={};try{data=await response.json();}catch{/* error below */}
 if(!response.ok)throw Error(typeof data.error==='string'?data.error:'The voice service refused the request.');
 return data.result;
}
async function speak(text,voiceId,language){
 const started=await voice({action:'speak',text,voiceId,language,target:'self',preview:false});
 let job=started;
 for(let i=0;i<300&&job?.status==='running';i++){await sleep(1000);job=await voice({action:'job',jobId:started.id});}
 if(job?.status!=='done')throw Error(job?.error||'Speech could not be generated.');
 const audio=await voice({action:'audio',audioId:job.result.audioId});
 send({operation:'state',state:'speaking'});
 await live.speak({data:audio.data,target:'self',duration:job.result.duration,text});
}
window.addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='dpro-avatar'||event.data.channel!==channel)return;
 const data=event.data;
 if(data.operation==='start'&&!live){
  void import('/genvr/dist/studio.js').then(sdk=>{
   live=sdk.mountAvatarLive(document.getElementById('avatar'),{projectId:'dpro-chat',display:{open:true,layout:['compact','desktop','large','watch'].includes(data.layout)?data.layout:'compact',framing:'bust',background:'color',color:/^#[0-9a-f]{6}$/i.test(data.color??'')?data.color:'#101827'}});
   send({operation:'mounted'});
  }).catch(()=>send({operation:'unavailable'}));
  return;
 }
 if(!live)return;
 if(data.operation==='voices'){void voice({action:'voices'}).then(result=>send({id:data.id,response:true,ok:true,value:(result.voices??[]).map(v=>({id:v.id,name:v.name,language:v.language??null}))})).catch(error=>send({id:data.id,response:true,ok:false,error:String(error.message||error)}));return;}
 if(data.operation==='speak'&&typeof data.text==='string'&&typeof data.voiceId==='string'){
  const text=data.text.slice(0,1200),language=typeof data.language==='string'&&/^[a-z]{2,3}$/.test(data.language)?data.language:'ar';
  speaking=speaking.then(()=>{send({operation:'state',state:'preparing'});return speak(text,data.voiceId,language);}).then(()=>send({operation:'state',state:'ready'}),error=>send({operation:'state',state:'ready',error:String(error.message||error)}));
  return;
 }
 if(data.operation==='mood'&&['neutral','smile','thinking','surprised','sad'].includes(data.expression)){live.execute({kind:'expression',target:'self',expression:data.expression,duration:data.duration??4000});return;}
 if(data.operation==='display'&&data.patch&&typeof data.patch==='object'){const patch={};if(['compact','desktop','large','watch'].includes(data.patch.layout))patch.layout=data.patch.layout;if(['full','bust','face'].includes(data.patch.framing))patch.framing=data.patch.framing;if(Object.keys(patch).length)live.execute({kind:'display',...patch});}
});
send({operation:'ready'});
