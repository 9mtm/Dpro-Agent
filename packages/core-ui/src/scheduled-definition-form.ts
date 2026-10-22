import type {ScheduleReview} from './schedule-consent-controller';
import {allowedScheduleDefinition} from './scheduler-definitions-contract.js';
export type ScheduleDraft={name:string;description:string;actionType:'api-call'|'send-message';recurrence:'unchanged'|'daily'|'weekly'|'custom';time:string;weekday:string;cron:string;replaceAction:boolean;method:string;url:string;channelId:string;to:string;content:string;replaceHeaders:boolean;headers:string;replaceBody:boolean;body:string;replaceOptions:boolean;options:string};
/** Safe display values never become editable action data. Replacement fields start empty. */
export function scheduleDraft(review:ScheduleReview|null):ScheduleDraft{return {name:review?.name??'',description:review?.description??'',actionType:review?.actionType??'api-call',recurrence:review?'unchanged':'daily',time:'09:00',weekday:'1',cron:review?.cronExpression??'',replaceAction:!review,method:'GET',url:'',channelId:'',to:'',content:'',replaceHeaders:false,headers:'',replaceBody:false,body:'',replaceOptions:false,options:''};}
function expression(draft:ScheduleDraft,review:ScheduleReview|null){
 if(draft.recurrence==='unchanged'){if(!review)throw Error('Choose a repeat time.');return review.cronExpression;}
 if(draft.recurrence==='custom')return draft.cron;
 if(!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.time))throw Error('Enter a valid time.');
 const [hours,minutes]=draft.time.split(':').map(Number);
 if(draft.recurrence==='weekly'&&!/^[0-6]$/.test(draft.weekday))throw Error('Choose a day.');
 return `${minutes} ${hours} * * ${draft.recurrence==='weekly'?draft.weekday:'*'}`;
}
function json(value:string){try{return JSON.parse(value);}catch{throw Error('Enter valid JSON in the replacement field.');}}
export function scheduleDraftChanges(id:string,draft:ScheduleDraft,review:ScheduleReview|null):Record<string,unknown>{
 const changes:Record<string,unknown>={},action:Record<string,unknown>={};
 if(!review||draft.name!==review.name)changes.name=draft.name;
 const description=draft.description||null;if(description!==(review?.description??null))changes.description=description;
 const cron=expression(draft,review);if(!review||cron!==review.cronExpression)changes.cronExpression=cron;
 const familyChanged=!!review&&draft.actionType!==review.actionType;
 if(!review||familyChanged)changes.actionType=draft.actionType;
 // A family switch always supplies a full fresh action; no masked/base object is copied.
 const full=!review||familyChanged;
 if(full||draft.replaceAction){
  if(draft.actionType==='api-call'){action.method=draft.method;action.url=draft.url;}
  else{action.channelId=draft.channelId;action.to=draft.to;action.content=draft.content;}
 }
 if(draft.actionType==='api-call'){
  if(draft.replaceHeaders)action.headers=json(draft.headers);
  if(draft.replaceBody)action.body=json(draft.body);
  if(action.method==='GET'&&draft.replaceBody)throw Error('GET requests cannot include content.');
 }else if(draft.replaceOptions)action.options=json(draft.options);
 if(Object.keys(action).length)changes.actionData=action;
 if(!Object.keys(changes).length)return changes;
 if(!allowedScheduleDefinition('PUT','/api/scheduler/definitions/'+id,{expectedRevision:review?1:0,changes}))throw Error('Check the changed fields. Hidden values cannot be used as replacements.');
 return changes;
}

/** Cancelling delivery replacement leaves separately edited headers/content/options intact. */
export function scheduleDeliveryReplacement(draft:ScheduleDraft,replaceAction:boolean):ScheduleDraft{return {...draft,replaceAction,method:'GET',url:'',channelId:'',to:'',content:''};}
