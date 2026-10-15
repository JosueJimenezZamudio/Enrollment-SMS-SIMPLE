const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
function runtime({baseline=false}={}) {
 const book=new Map(),props=new Map(),calls=[],logs=[],triggers=[],clock={now:Date.parse('2026-10-13T22:00:00.000Z')};
 const fmt=(date,tz,pattern)=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(date)).map(p=>[p.type,p.value]));const stamp=`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;if(pattern==='Z'){const local=Date.parse(stamp.replace(' ','T')+'Z'),minutes=Math.round((local-new Date(date).getTime())/60000),abs=Math.abs(minutes);return (minutes<0?'-':'+')+String(Math.floor(abs/60)).padStart(2,'0')+String(abs%60).padStart(2,'0');}return stamp;};
 class FakeDate extends Date {constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
 class Range {
  constructor(sheet,r,c,n=1,w=1){Object.assign(this,{sheet,r,c,n,w});}
  getValues(){return Array.from({length:this.n},(_,i)=>Array.from({length:this.w},(_,j)=>this.sheet.data[this.r-1+i]?.[this.c-1+j]??''));}
  getDisplayValues(){return this.getValues().map(r=>r.map(v=>v instanceof Date?fmt(v,'America/Los_Angeles','yyyy-MM-dd HH:mm:ss'):String(v)));}
  getValue(){return this.getValues()[0][0];}getDisplayValue(){return this.getDisplayValues()[0][0];}getRow(){return this.r;}
  setValues(values){if(values.length!==this.n||values.some(r=>r.length!==this.w))throw Error('Dimension mismatch');values.forEach((row,i)=>row.forEach((v,j)=>{this.sheet.data[this.r-1+i]??=[];this.sheet.data[this.r-1+i][this.c-1+j]=v;}));return this;}
  setValue(v){return this.setValues([[v]]);}clearContent(){return this.setValues(Array.from({length:this.n},()=>Array(this.w).fill('')));}
  protect(){const p={getDescription:()=>p.description,setDescription(v){p.description=v;return p;},setWarningOnly(){return p;},addEditor(){},getEditors:()=>[],canDomainEdit:()=>false};this.sheet.protections.push(p);return p;}
  setNumberFormat(){return this;}setBackground(){return this;}setFontColor(){return this;}setFontWeight(){return this;}setWrap(){return this;}setDataValidation(){return this;}
 }
 class Sheet {constructor(name,headers=[],rows=[]){this.name=name;this.protections=[];this.data=[headers,...rows];this.maxRows=1000;this.maxCols=Math.max(headers.length,26);}getProtections(){return this.protections;}getName(){return this.name;}getLastRow(){for(let i=this.data.length-1;i>=0;i--)if(this.data[i]?.some(x=>x!==''&&x!=null))return i+1;return 0;}getLastColumn(){return Math.max(...this.data.map(r=>r.length),0);}getMaxRows(){return this.maxRows;}getMaxColumns(){return this.maxCols;}getRange(...args){return new Range(this,...args);}insertRowsAfter(_,n){this.maxRows+=n;}insertColumnsAfter(_,n){this.maxCols+=n;}setColumnWidths(){}setFrozenRows(){}setFrozenColumns(){}appendRow(r){this.data.push(r);return this;}}
 let activeName='Campaigns',activeRow=2;
 const ss={getId:()=> '1KUmlLfCJIkrmui-FHDn3mnbqEJ0n2yp-QJwU-Ja-8x4',getSheetByName:n=>book.get(n),insertSheet:n=>{const s=new Sheet(n);book.set(n,s);return s;},getActiveSheet:()=>book.get(activeName),getActiveRange:()=>new Range(book.get(activeName),activeRow,1)};
 let locked=false;const lock={hasLock:()=>locked,tryLock(){if(locked)return false;locked=true;return true;},waitLock(){if(locked)throw Error('Nested lock');locked=true;},releaseLock(){locked=false;}};
 const context={console:{log:x=>logs.push(x),warn:x=>logs.push(x),error:x=>logs.push(x)},Date:FakeDate,Math,JSON,Set,Map,URL,Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},getUuid:()=>crypto.randomUUID(),computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()],computeHmacSha256Signature:(s,k)=>[...crypto.createHmac('sha256',k).update(s).digest()],base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url'),formatDate:fmt},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,String(v)),deleteProperty:k=>props.delete(k)})},Session:{getEffectiveUser:()=>({getEmail:()=> 'operator@example.test'})},LockService:{getScriptLock:()=>lock},SpreadsheetApp:{ProtectionType:{RANGE:'RANGE'},openById:()=>ss,getActiveSpreadsheet:()=>ss,flush:()=>{},newDataValidation:()=>({requireValueInList(){return this;},setAllowInvalid(){return this;},build(){return {};}}),getUi:()=>({ButtonSet:{YES_NO:'YES_NO',OK:'OK',OK_CANCEL:'OK_CANCEL'},Button:{YES:'YES',OK:'OK'},alert:()=> 'YES',createMenu:()=>({addItem(){return this;},addSeparator(){return this;},addToUi(){}})})},ScriptApp:{getOAuthToken:()=> 'test-google-token',getProjectTriggers:()=>triggers,newTrigger:name=>({timeBased(){return this;},everyMinutes(){return this;},create(){triggers.push({getHandlerFunction:()=>name});}})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:o=>calls.push({kind:'mail',options:o})},HtmlService:{createHtmlOutput:text=>text},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>text})}};
 let backend=new Map(),transport=null;
 context.UrlFetchApp={fetch:(url,options)=>{
  if(url.startsWith('https://sheets.googleapis.com/')){const payload=JSON.parse(options.payload);for(const part of (payload.data||[payload])){const m=part.range.match(/^'(.+)'!([A-Z]+)(\d+)(?::|$)/),col=[...m[2]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);book.get(m[1].replace(/''/g,"'")).getRange(+m[3],col,part.values.length,part.values[0].length).setValues(part.values);}return response(200,{});}
  calls.push({kind:'api',url,body:options.payload,headers:options.headers});if(transport)return transport(url,options);
  const p=JSON.parse(options.payload);if(url.endsWith('sms-queue-status')){const pair=[...backend.entries()].find(([k,v])=>(!p.dedupeKey||k===p.dedupeKey)&&(!p.queueId||p.queueId===v.q.id));return pair?response(200,{ok:true,queued:pair[1].q}):response(404,{ok:false});}
  const prior=backend.get(p.dedupeKey);if(prior&&prior.body!==options.payload)return response(409,{ok:false});
  const q=prior?.q||{id:crypto.randomUUID(),dedupe_key:p.dedupeKey,status:'queued',scheduled_at:p.scheduledAt,claimed_at:null,sent_at:null,failed_at:null,last_error:null,attempt_status:null};
  backend.set(p.dedupeKey,{body:options.payload,q});return response(prior?200:201,{ok:true,duplicate:!!prior,dedupeKey:p.dedupeKey,queued:q});
 }};
 vm.createContext(context);
 const files=['LeadIntake.gs','CampaignEngine.gs','EmailAutomation.gs','WelcomeEmailImmediate_v3.gs','SquarespaceWebHook.gs'];
 if(!baseline)files.push('SmsCore.gs','SmsStore.gs','SmsWorkflow.gs','SmsUi.gs');
 for(const f of files)vm.runInContext(fs.readFileSync(path.join(ROOT,baseline?'tests/baseline':'crm',f),'utf8'),context,{filename:f});
 const run=s=>vm.runInContext(s,context),get=(name)=>run(name);
 const add=(name,headers,objects=[])=>{book.set(name,new Sheet(name,headers,objects.map(o=>Array.isArray(o)?o:headers.map(k=>o[k]??''))));};
 const schema=baseline?{}:get('SMS_SCHEMA');
 add('Master Leads',[...get('CRM.HEADERS'),'Email Opt Out','Email Opt Out At','ZIP Code',...(schema['Master Leads']?.headers||[])]);
 add('Campaigns',[...get('campaignHeaders_()'),...(schema.Campaigns?.headers||[])]);
 add('Templates',[...get('templateHeaders_()'),...(schema.Templates?.headers||[])]);
 add('Events',get('eventHeaders_()'));add('Email Queue',get('EMAIL_AUTO.QUEUE_HEADERS'));
 add('Communication Log',[...get('EMAIL_AUTO.LOG_HEADERS'),...(schema['Communication Log']?.headers||[])]);
 add('Campaign Preview',[...get('previewHeaders_()'),...(schema['Campaign Preview']?.headers||[])]);
 add('Settings',['Key','Value','Description']);
 if(!baseline)for(const n of ['SMS Outbox','SMS Submission Log'])add(n,schema[n].headers);
 const setSetting=(k,v)=>{const sh=book.get('Settings'),r=sh.data.findIndex(r=>r[0]===k);if(r<0)sh.data.push([k,String(v),'']);else sh.data[r][1]=String(v);};
 if(!baseline)Object.entries(get('SMS_DEFAULTS')).forEach(([k,v])=>setSetting(k,v));
 Object.entries({CAMPAIGN_ENGINE_MODE:'PREVIEW_ONLY',WELCOME_EMAIL_ENABLED:'FALSE',CAMPAIGN_EMAILS_ENABLED:'FALSE',WELCOME_SMS_ENABLED:'TRUE',CAMPAIGN_SMS_ENABLED:'TRUE',EMAIL_AUDIENCE_PERMISSION_CONFIRMED:'TRUE',EMAIL_POSTAL_ADDRESS:'Test address',UNSUBSCRIBE_WEBAPP_URL:'https://script.google.com/macros/s/test/exec',EMAIL_SENDER_NAME:'Test',WELCOME_START_AT:'2026-10-13 14:00:00',SQUARESPACE_WELCOME_ON_IMPORT:'TRUE'}).forEach(([k,v])=>setSetting(k,v));
 props.set('SMS_OPERATOR_EMAIL','operator@example.test');props.set('SMS_EXPECTED_CRM_ID',ss.getId());props.set('SMS_BASELINE_AT','2026-10-13T20:00:00.000Z');props.set('SMS_SCHEMA_READY','true');props.set('SMS_API_BASE_URL','https://rccdxrmyavihzdrgokpv.supabase.co/functions/v1');props.set('SMS_INGEST_SECRET','test-ingest');props.set('SMS_STATUS_SECRET','test-read');props.set('EDNOVATE_UNSUBSCRIBE_SECRET','test-only-secret-at-least-thirty-two-characters');
 const put=(name,obj)=>{const sh=book.get(name);sh.data.push(sh.data[0].map(k=>obj[k]??''));};
 const rows=name=>{const [h,...rs]=book.get(name).data;return rs.filter(r=>r?.some(Boolean)).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??''])));};
 const patch=(name,key,id,x)=>{const sh=book.get(name),h=sh.data[0],r=sh.data.find((r,i)=>i&&r[h.indexOf(key)]===id);if(!r)throw Error('no fixture');for(const [k,v]of Object.entries(x))r[h.indexOf(k)]=v;};
 return {context,run,get,book,props,calls,logs,clock,backend,setSetting,put,rows,patch,active:(n,r=2)=>{activeName=n;activeRow=r;},transport:f=>transport=f,response,add};
}
function response(status,obj){return {getResponseCode:()=>status,getContentText:()=>JSON.stringify(obj),getHeaders:()=>({})};}
function fixture(r){
 const t={'Template ID':'TPL-WELCOME','Template Name':'Welcome',Status:'Approved','SMS Body EN':'Hello {ParentName}, welcome.','SMS Body ES':'Hola {ParentName}.','SMS Revision':'1','SMS Status':'Approved','Email Subject EN':'Hello','Email Body EN':'Welcome {ParentName}','Email Subject ES':'Hola','Email Body ES':'Hola {ParentName}'};
 if(r.context.smsTemplateHash_)t['SMS Content Hash']=r.context.smsTemplateHash_(t);
 const c={'Campaign ID':'WELCOME-EMAIL','Campaign Name':'Welcome',Trigger:'New Lead',Channel:'Both',Audience:'All Active Leads','Message Mode':'Template','Template ID':'TPL-WELCOME',Enabled:'Yes',Status:'Ready','SMS Approval Mode':'AUTO','SMS Control':'READY','Business Event Type':'New Lead','Event Instance':'welcome:onboarding:v1','SMS Policy Revision':'1'};
 if(r.context.smsPolicyHash_)c['SMS Policy Fingerprint']=r.context.smsPolicyHash_(c,t);
 const l={'Lead ID':'LEAD-ONE','Business Lead ID':'LEAD-ONE','Parent Name':'Alex',Email:'alex@example.test',Phone:'+12025550123','Preferred Language':'English','Active Lead':'Yes','SMS Permission':'Allowed','SMS Permission Source':'controlled-test','Created At':'10/13/2026 2:30:00 PM','CRM First Seen At':'2026-10-13T21:30:01.000Z',Source:'Google Form','Source Record ID':'FORM-ONE','Applied to Ednovate School':'No'};
 r.put('Templates',t);r.put('Campaigns',c);r.put('Master Leads',l);
 for(const [k,v]of Object.entries({SMS_ENGINE_MODE:'LIVE',SMS_PAUSED:'FALSE',SMS_AUTO_ENABLED:'TRUE',SMS_TEST_RECIPIENT_ALLOWLIST:'+12025550123',WELCOME_SMS_START_AT:'2026-10-13T21:00:00.000Z'}))r.setSetting(k,v);
 if(r.context.smsEvent_)r.context.smsLocked_(()=>r.context.smsEvent_('POLICY_ARMED',{'Authorization ID':'POLICY-1-'+c['SMS Policy Fingerprint'],'Policy Revision':'1','Source Snapshot JSON':JSON.stringify({campaignId:c['Campaign ID'],fingerprint:c['SMS Policy Fingerprint']})}));
 return {t,c,l};
}
module.exports={runtime,fixture,response};
