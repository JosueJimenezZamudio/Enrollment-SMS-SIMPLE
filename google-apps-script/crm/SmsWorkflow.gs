/** Planner and worker. The only producer POST is smsProducerRequest_. */
function smsContext_() {
  const s=smsSettings_(),leads=smsRows_('Master Leads'),campaigns=smsRows_('Campaigns'),templates=smsRows_('Templates'),events=smsRows_('Events');
  for(const [rows,key] of [[leads,'Lead ID'],[campaigns,'Campaign ID'],[templates,'Template ID'],[events,'Event ID']])if(new Set(rows.map(r=>r[key])).size!==rows.length)throw new Error('DUPLICATE_CRM_ID:'+key);
  return {s,leads,campaigns,templates,events};
}
function smsCandidate_(row,ctx,now) {
  const c=ctx.campaigns.find(x=>x['Campaign ID']===row['Campaign ID']),l=ctx.leads.find(x=>x['Lead ID']===row['Lead ID']);
  if(!c||!l)throw new Error('MISSING_CAMPAIGN_OR_LEAD');
  const t=ctx.templates.find(x=>x['Template ID']===c['Template ID']),e=ctx.events.find(x=>x['Event ID']===c['Event ID']);
  const rendered=smsEligibility_(c,t,e,l,ctx.leads,ctx.s,now,row['Custom Message']);
  const identity=smsBusiness_(c,l),scheduledAt=smsScheduled_(c,ctx.s,row['Scheduled Time']);
  const mode=rendered.manual||smsText_(row['Scheduled Time']).trim()||row['Approval Mode']==='MANUAL'?'MANUAL':c['SMS Approval Mode'];
  return {...rendered,...identity,c,l,t,e,scheduledAt,mode,leadId:l['Lead ID'],eventType:c['Business Event Type']};
}
function smsCandidateHash_(x) { return smsJsonHash_([x.phone,x.body,x.leadId,x.eventType,x.dedupe,x.scheduledAt,x.mode,x.c['SMS Policy Fingerprint']]); }
function smsOutboxFrom_(c,l) {
  const id=smsBusiness_(c,l),now=smsNow_();
  return {'Outbox ID':'SMS-'+smsHash_(id.dedupe),'Campaign ID':c['Campaign ID'],'Lead ID':l['Lead ID'],'Business Lead ID':l['Business Lead ID'],'Event ID':c['Event ID'],'Event Type':c['Business Event Type'],'Event Instance':c['Event Instance'],'Business Event Key':id.key,'Phone':smsPhone_(l.Phone)||'','Template ID':c['Template ID'],'Approval Mode':c['SMS Approval Mode'],'Send Control':c['SMS Approval Mode']==='AUTO'?'READY':'DRAFT','Submission State':'DRAFT','Dedupe Key':id.dedupe,'Created At':now,'Source':l.Source,'Source Record ID':l['Source Record ID']};
}
function smsPlanLocked_() {
  smsSeedLeadsLocked_(false);const ctx=smsContext_(),now=Date.now();let created=0;
  if(!['ALLOWLIST','PRODUCTION'].includes(ctx.s.SMS_ROLLOUT_MODE))throw new Error('INVALID_ROLLOUT_MODE');
  const allowedPhones=new Set(smsText_(ctx.s.SMS_TEST_RECIPIENT_ALLOWLIST)
    .split(/[,\s]+/).filter(Boolean).map(smsPhone_).filter(Boolean));
  const inRollout=l=>ctx.s.SMS_ROLLOUT_MODE==='PRODUCTION'||
    (!!smsPhone_(l.Phone)&&allowedPhones.has(smsPhone_(l.Phone)));
  for(const c of ctx.campaigns) {
    if(c.Enabled!=='Yes'||c['SMS Control']!=='READY'||!smsChannelIncludes_(c.Channel,'SMS'))continue;
    const t=ctx.templates.find(x=>x['Template ID']===c['Template ID']);
    if(c['SMS Policy Fingerprint']!==smsPolicyHash_(c,t)||!smsPolicyAuthorized_(c)){smsPatch_('Campaigns','Campaign ID',c['Campaign ID'],{'SMS Status':'POLICY_CHANGED'});continue;}
    const welcome=c.Trigger==='New Lead';
    if(!smsTrue_(ctx.s[welcome?'WELCOME_SMS_ENABLED':'CAMPAIGN_SMS_ENABLED']))continue;
    let recipients=[];
    if(c.Trigger==='Scheduled') {
      const at=Date.parse(smsScheduled_(c,ctx.s,''));if(at>now)continue;
      const journal=smsJournal_(),planId='PLAN-'+smsJsonHash_([c['Campaign ID'],c['Business Event Type'],c['Event Instance']]);
      let plan=journal.find(e=>e['Journal Event ID']===planId);
      if(!plan) {
        if(now-at>smsLimit_(ctx.s,'SMS_MAX_CAMPAIGN_LATENESS_MINUTES',1440)*60000){smsPatch_('Campaigns','Campaign ID',c['Campaign ID'],{'SMS Status':'WINDOW_EXPIRED'});continue;}
        const ids=ctx.leads.filter(l=>inRollout(l)&&campaignEligible_(l,c.Audience)&&l['Lead ID']===l['Business Lead ID']).map(l=>l['Lead ID']);
        plan=smsEvent_('AUDIENCE_FROZEN',{'Policy Revision':c['SMS Policy Revision'],'Source Snapshot JSON':JSON.stringify({campaignId:c['Campaign ID'],fingerprint:c['SMS Policy Fingerprint'],leadIds:ids})},planId);
      }
      const saved=JSON.parse(plan['Source Snapshot JSON']);
      if(saved.fingerprint!==c['SMS Policy Fingerprint']){smsPatch_('Campaigns','Campaign ID',c['Campaign ID'],{'SMS Status':'PLANNED_POLICY_CHANGED'});continue;}
      recipients=saved.leadIds.map(id=>ctx.leads.find(l=>l['Lead ID']===id)).filter(Boolean);
    } else if(welcome) {
      recipients=ctx.leads.filter(l=>l['Lead ID']===l['Business Lead ID']&&Date.parse(l['CRM First Seen At'])>Date.parse(ctx.s.WELCOME_SMS_START_AT));
    } else continue;
    for(const l of recipients.filter(inRollout)) {
      const row=smsOutboxFrom_(c,l),prior=smsRows_('SMS Outbox').filter(r=>r['Dedupe Key']===row['Dedupe Key']);
      if(prior.length>1)throw new Error('SMS_DUPLICATE_OUTBOX_IDENTITY');
      if(prior.length)continue;
      if(smsJournal_().some(e=>e['Journal Event Type']==='PREPARED'&&e['Dedupe Key']===row['Dedupe Key']))continue;
      smsAppend_('SMS Outbox',row);created++;
      if(created>=smsLimit_(ctx.s,'SMS_MAX_NEW_PER_RUN',20))return created;
    }
  }
  return created;
}
function planSmsCrm() { smsOperator_();return smsLocked_(smsPlanLocked_); }
function smsPrepareLocked_(row,ctx) {
  if(row['Send Control']==='HOLD')return;
  const existing=smsJournal_().filter(e=>e['Journal Event Type']==='PREPARED'&&e['Dedupe Key']===row['Dedupe Key']);
  if(existing.length){if(existing.length!==1)throw new Error('SMS_MULTIPLE_SNAPSHOTS');smsSnapshot_(existing[0]);return existing[0];}
  let x;try{x=smsCandidate_(row,ctx,Date.now());}catch(_){smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{'Eligibility':'BLOCKED','Submission State':'BLOCKED','Submission Error':'Invalid identity or schedule; review CRM inputs'});return;}
  if(x.dedupe!==row['Dedupe Key'])throw new Error('SMS_DRAFT_IDENTITY_CHANGED');
  const display={'Preview':x.body,'Variables JSON':JSON.stringify(x.vars),'Phone':x.phone||'','Language':x.lang,'SMS Revision':x.t?x.t['SMS Revision']:'','GSM-7 Septets':x.septets===null?'':x.septets,'Approval Mode':x.mode,'Eligibility':x.issues.length?x.issues.join('; '):'ELIGIBLE'};
  if(x.issues.length){smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{...display,'Submission State':'BLOCKED','Submission Error':x.issues.join('; ')});return;}
  if(!smsPolicyAuthorized_(x.c))throw new Error('SMS_POLICY_NOT_AUTHORIZED');
  const hash=smsCandidateHash_(x);let authorization;
  if(x.mode==='MANUAL') {
    authorization=smsJournal_().find(e=>e['Journal Event Type']==='MANUAL_APPROVED'&&e['Outbox ID']===row['Outbox ID']&&e['Snapshot Hash']===hash&&e['Authorization ID']===row['Authorization ID']);
    if(row['Send Control']!=='READY'||!authorization){smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{...display,'Submission State':'DRAFT','Submission Error':'Explicit manual preview/approval required'});return;}
  } else {
    if(row['Send Control']!=='READY'||!smsTrue_(ctx.s.SMS_AUTO_ENABLED)){smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{...display,'Submission State':'ELIGIBLE'});return;}
    authorization={'Authorization ID':'POLICY-'+x.c['SMS Policy Revision']+'-'+x.c['SMS Policy Fingerprint']};
  }
  if(x.scheduledAt&&x.c.Trigger==='Scheduled'&&Date.now()-Date.parse(x.scheduledAt)>smsLimit_(ctx.s,'SMS_MAX_CAMPAIGN_LATENESS_MINUTES',1440)*60000){smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{...display,'Submission State':'BLOCKED','Submission Error':'Scheduled submission window expired'});return;}
  const frozen=smsFreeze_(x,Date.now()),phoneFence=smsJsonHash_([x.c['Campaign ID'],x.c['Event Instance'],x.phone]);
  const collision=smsJournal_().filter(e=>e['Journal Event Type']==='PREPARED').some(e=>{const src=JSON.parse(e['Source Snapshot JSON']);return src.phoneFence===phoneFence;});
  if(collision){smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{...display,'Submission State':'REVIEW_REQUIRED','Submission Error':'Recipient already reserved for this occurrence'});return;}
  const submission=Utilities.getUuid();
  const src={campaignId:x.c['Campaign ID'],campaignName:x.c['Campaign Name'],leadId:x.leadId,businessLeadId:row['Business Lead ID'],eventId:x.c['Event ID']||'',eventType:x.eventType,eventInstance:x.c['Event Instance'],templateId:x.c['Template ID']||'',templateRevision:x.t?x.t['SMS Revision']:'',language:x.lang,variables:x.vars,policyHash:x.c['SMS Policy Fingerprint'],phoneFence,candidateHash:hash};
  const prepared=smsEvent_('PREPARED',{'Outbox ID':row['Outbox ID'],'Submission ID':submission,'Business Event Key':x.key,'Dedupe Key':x.dedupe,'Authorization Mode':x.mode,'Authorization ID':authorization['Authorization ID'],'Policy Revision':x.c['SMS Policy Revision'],'Source Snapshot JSON':JSON.stringify(src),'Frozen Request JSON':frozen.body,'Snapshot Hash':frozen.hash,'Submission State':'PREPARED'},'PREPARED-'+smsHash_(x.dedupe));
  smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{...display,'Submission State':'PREPARED','Frozen Message':frozen.payload.message,'Frozen ScheduledAt UTC':frozen.payload.scheduledAt,'Submission ID':submission,'Snapshot Hash':frozen.hash,'Authorization ID':authorization['Authorization ID'],'Authorization Fingerprint':hash,'Submission Error':''});
  return prepared;
}
function smsCanIngest_(s) { return s.SMS_ENGINE_MODE==='LIVE'&&!smsTrue_(s.SMS_PAUSED); }
function smsReservationLocked_(sub,ctx) {
  const p=sub.prepared,events=sub.events,latest=events.filter(e=>['PREPARED','DISPATCH_STARTED','HTTP_RESULT','ERROR','ACCEPTED'].includes(e['Journal Event Type'])).slice(-1)[0],snapshot=smsSnapshot_(p);
  if(events.some(e=>e['Journal Event Type']==='ACCEPTED'))return null;
  if(['CONFLICT','AUTH_ERROR','REVIEW_REQUIRED'].includes(latest['Submission State']))return null;
  if(Date.parse(latest['Dispatch Lease Until'])>Date.now()||Date.parse(latest['Next Action At'])>Date.now())return null;
  const matches=smsRows_('SMS Outbox').filter(r=>r['Outbox ID']===p['Outbox ID']);if(matches.length!==1)return null;
  const row=matches[0];if(row['Send Control']!=='READY'||!smsCanIngest_(ctx.s))return null;
  const src=JSON.parse(p['Source Snapshot JSON']),c=ctx.campaigns.find(x=>x['Campaign ID']===src.campaignId),l=ctx.leads.find(x=>x['Lead ID']===src.leadId);
  if(!c||!l||c.Enabled!=='Yes'||c['SMS Control']!=='READY'||!smsTrue_(ctx.s[c.Trigger==='New Lead'?'WELCOME_SMS_ENABLED':'CAMPAIGN_SMS_ENABLED']))return null;
  if(p['Authorization Mode']==='AUTO'&&!smsTrue_(ctx.s.SMS_AUTO_ENABLED))return null;
  // Suppression and recipient change stop POSTs, but do not erase an uncertain receipt.
  if(smsPhone_(l.Phone)!==snapshot.payload.phone||l['SMS Permission']!=='Allowed'||smsTrue_(l['SMS Opt Out'])||!campaignEligible_(l,c.Audience)||ctx.leads.some(x=>smsPhone_(x.Phone)===snapshot.payload.phone&&(smsTrue_(x['SMS Opt Out'])||x['SMS Permission']==='Denied')))return null;
  if(ctx.s.SMS_ROLLOUT_MODE==='ALLOWLIST'&&!smsText_(ctx.s.SMS_TEST_RECIPIENT_ALLOWLIST).split(/[,\s]+/).map(smsPhone_).includes(snapshot.payload.phone))return null;
  if(!['ALLOWLIST','PRODUCTION'].includes(ctx.s.SMS_ROLLOUT_MODE))return null;
  const attempts=events.filter(e=>e['Journal Event Type']==='DISPATCH_STARTED').length;
  // After any request may have begun, only the original bytes are recoverable.
  // Before first dispatch verify mutable inputs still match the approved snapshot.
  if(!attempts) {
    const x=smsCandidate_(row,ctx,Date.now());if(x.issues.length||smsCandidateHash_(x)!==src.candidateHash){smsEvent_('ERROR',{'Submission ID':p['Submission ID'],'Outbox ID':p['Outbox ID'],'Submission State':'REVIEW_REQUIRED','Safe Error':'Prepared draft changed before dispatch'});return null;}
  }
  if(attempts>=smsLimit_(ctx.s,'SMS_HTTP_RETRY_LIMIT',6)){smsEvent_('ERROR',{'Submission ID':p['Submission ID'],'Outbox ID':p['Outbox ID'],'Submission State':'REVIEW_REQUIRED','Safe Error':'HTTP retry limit; reconcile before any further action'});return null;}
  const lease=new Date(Date.now()+600000).toISOString();
  const dispatch=smsEvent_('DISPATCH_STARTED',{'Submission ID':p['Submission ID'],'Outbox ID':p['Outbox ID'],'Snapshot Event ID':p['Journal Event ID'],'Dedupe Key':p['Dedupe Key'],'HTTP Attempt Number':attempts+1,'Submission State':'SUBMITTING','Dispatch Lease Until':lease});
  return {p,snapshot,dispatch,attempt:attempts+1};
}
function smsProducerRequest_(kind,body) {
  const props=PropertiesService.getScriptProperties(),base=props.getProperty('SMS_API_BASE_URL'),secret=props.getProperty(kind==='ingest'?'SMS_INGEST_SECRET':'SMS_STATUS_SECRET');
  if(base!=='https://rccdxrmyavihzdrgokpv.supabase.co/functions/v1'||!secret) return {status:401,raw:'',config:true};
  const path=kind==='ingest'?'queue-enrollment-sms':'sms-queue-status';
  try{const r=UrlFetchApp.fetch(base+'/'+path,{method:'post',contentType:'application/json',headers:{'x-enrollment-sms-secret':secret},payload:body,muteHttpExceptions:true,followRedirects:false});return {status:r.getResponseCode(),raw:r.getContentText(),headers:r.getHeaders()};}
  catch(_){return {status:0,raw:''};}
}
function smsFinishLocked_(job,http) {
  const result=smsResponse_(http.status,http.raw,job.snapshot,'',false),p=job.p;
  const data={'Submission ID':p['Submission ID'],'Outbox ID':p['Outbox ID'],'Snapshot Event ID':p['Journal Event ID'],'Dedupe Key':p['Dedupe Key'],'HTTP Attempt Number':job.attempt,'HTTP Status':http.status,'Submission State':result.state,'Safe Error':result.error||''};
  if(result.queue){data['Queue ID']=result.queue.id;data['Backend Observation JSON']=JSON.stringify(result.queue);}
  if(result.state==='RETRY_PENDING'){
    let delay=[1,2,5,15,30,60][Math.min(job.attempt-1,5)]*60000;
    const retry=http.headers&&(http.headers['Retry-After']||http.headers['retry-after']);
    if(retry){const seconds=Number(retry);const wait=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now();if(Number.isFinite(wait))delay=Math.max(delay,Math.min(wait,86400000));}
    data['Next Action At']=new Date(Date.now()+delay+Math.floor(Math.random()*15000)).toISOString();
  }
  // Configuration errors differ from ambiguous transient 503s.
  let err;try{err=JSON.parse(http.raw).error;}catch(_){}
  if(http.status===503&&typeof err==='string'&&/client unavailable|device unavailable/i.test(err)){data['Submission State']='REVIEW_REQUIRED';data['Safe Error']='Producer configuration unavailable';smsSetSetting_('SMS_PAUSED','TRUE');}
  smsEvent_(result.state==='ACCEPTED'?'ACCEPTED':'HTTP_RESULT',data,'RESULT-'+job.dispatch['Journal Event ID']);
  if(result.state==='AUTH_ERROR')smsSetSetting_('SMS_PAUSED','TRUE');
  smsProjectLocked_();
}
function smsPollJobsLocked_() {
  const events=smsJournal_(),subs=smsSubmissions_(events),s=smsSettings_();
  return subs.map(sub=>{
    const accepted=sub.events.find(e=>e['Journal Event Type']==='ACCEPTED');
    const observations=sub.events.filter(e=>e['Backend Observation JSON']);const last=observations[observations.length-1];
    const q=last?JSON.parse(last['Backend Observation JSON']):null;
    if(accepted&&q&&['sent','failed','cancelled'].includes(q.status))return null;
    const sync=sub.events.filter(e=>e['Journal Event Type']==='STATUS_OBSERVED'||e['Journal Event Type']==='STATUS_ERROR').slice(-1)[0];
    const interval=q&&q.status==='unknown'?900000:q&&q.status==='queued'?300000:60000;
    if(sync&&Date.now()-Date.parse(sync['Recorded At UTC'])<interval)return null;
    return {p:sub.prepared,snapshot:smsSnapshot_(sub.prepared),knownId:accepted?accepted['Queue ID']:'',checked:sync?Date.parse(sync['Recorded At UTC']):0};
  }).filter(Boolean).sort((a,b)=>a.checked-b.checked).slice(0,smsLimit_(s,'SMS_MAX_STATUS_PER_RUN',50));
}
function pollSmsStatuses() {
  smsOperator_();const jobs=smsLocked_(smsPollJobsLocked_);let count=0;
  for(const job of jobs){const selector={dedupeKey:job.p['Dedupe Key']};if(job.knownId)selector.queueId=job.knownId;
    const http=smsProducerRequest_('status',JSON.stringify(selector)),r=smsResponse_(http.status,http.raw,job.snapshot,job.knownId,true);
    smsLocked_(()=>{smsEvent_(r.queue?'STATUS_OBSERVED':'STATUS_ERROR',{'Submission ID':job.p['Submission ID'],'Outbox ID':job.p['Outbox ID'],'HTTP Status':http.status,'Queue ID':r.queue?r.queue.id:job.knownId,'Backend Observation JSON':r.queue?JSON.stringify(r.queue):'','Safe Error':r.error||'','Submission State':job.knownId?'ACCEPTED':'RETRY_PENDING'});smsProjectLocked_();});count++;if(r.state==='AUTH_ERROR')break;
  }return {checked:count};
}
function runSmsWorker() {
  smsOperator_();if(PropertiesService.getScriptProperties().getProperty('SMS_SCHEMA_READY')!=='true')throw new Error('SMS_INSTALLATION_INCOMPLETE');
  const started=Date.now(),s=smsSettings_();let posts=0;
  if(smsCanIngest_(s)) {
    smsLocked_(smsPlanLocked_);
    smsLocked_(()=>{
      const ctx=smsContext_(),props=PropertiesService.getScriptProperties();
      const drafts=smsRows_('SMS Outbox').filter(r=>!r['Submission ID']&&r['Send Control']!=='HOLD');
      const cursor=props.getProperty('SMS_PREPARE_CURSOR')||'';
      const position=drafts.findIndex(r=>r['Outbox ID']===cursor)+1;
      const ordered=drafts.slice(position).concat(drafts.slice(0,position));
      for(const row of ordered.slice(0,smsLimit_(ctx.s,'SMS_MAX_NEW_PER_RUN',20))){
        if(Date.now()-started>120000)break;
        smsPrepareLocked_(row,ctx);props.setProperty('SMS_PREPARE_CURSOR',row['Outbox ID']);
      }
    });
    for(let i=0;i<smsLimit_(s,'SMS_MAX_NEW_PER_RUN',20)&&Date.now()-started<smsLimit_(s,'SMS_MAX_RUN_SECONDS',240)*1000;i++) {
      const job=smsLocked_(()=>{const ctx=smsContext_();for(const sub of smsSubmissions_(smsJournal_())){const job=smsReservationLocked_(sub,ctx);if(job)return job;}return null;});
      if(!job)break;const response=smsProducerRequest_('ingest',job.snapshot.body);smsLocked_(()=>smsFinishLocked_(job,response));posts++;
    }
  }
  smsLocked_(smsProjectLocked_);
  const poll=Date.now()-started<210000?pollSmsStatuses():{checked:0};return {posts,checked:poll.checked};
}
function smsProjectLocked_() {
  for(const sub of smsSubmissions_(smsJournal_())) {
    const p=sub.prepared,src=JSON.parse(p['Source Snapshot JSON']),snap=smsSnapshot_(p),events=sub.events,last=events.filter(e=>['PREPARED','DISPATCH_STARTED','HTTP_RESULT','ERROR','ACCEPTED'].includes(e['Journal Event Type'])).slice(-1)[0];
    const accepted=events.find(e=>e['Journal Event Type']==='ACCEPTED'),obs=events.filter(e=>e['Backend Observation JSON']).slice(-1)[0],q=obs?JSON.parse(obs['Backend Observation JSON']):null;
    const out=smsRows_('SMS Outbox').filter(r=>r['Outbox ID']===p['Outbox ID']);
    if(out.length>1)throw new Error('SMS_DUPLICATE_OUTBOX_ID');
    const statusEvents=events.filter(e=>/^STATUS_/.test(e['Journal Event Type']));const sync=statusEvents.slice(-1)[0],checked=statusEvents.filter(e=>e['Journal Event Type']==='STATUS_OBSERVED').slice(-1)[0];
    if(out.length) smsPatch_('SMS Outbox','Outbox ID',p['Outbox ID'],{'Submission ID':p['Submission ID'],'Frozen Message':snap.payload.message,'Frozen ScheduledAt UTC':snap.payload.scheduledAt,'Snapshot Hash':snap.hash,'Submission State':accepted?'ACCEPTED':last['Submission State']||'PREPARED','Queue ID':accepted?accepted['Queue ID']:'','Backend Status':q?q.status:'','Attempt Status':q?q.attempt_status||'':'','Backend Error':q?q.last_error||'':'','Submission Error':last['Safe Error']||'','Submitted At':accepted?accepted['Recorded At UTC']:'','Claimed At':q?q.claimed_at||'':'','Sent At':accepted&&q?q.sent_at||'':'','Failed At':accepted&&q?q.failed_at||'':'','Last Checked At':checked?checked['Recorded At UTC']:'','Next Action At':last['Next Action At']||'','HTTP Attempt Count':events.filter(e=>e['Journal Event Type']==='DISPATCH_STARTED').length,'Status Sync':sync&&sync['Journal Event Type']==='STATUS_ERROR'?(sync['HTTP Status']==='404'?'NOT_FOUND':'STALE'):q?'CURRENT':'STALE'});
    if(!accepted||!q)continue;
    const logId='SMS-OBS-'+smsJsonHash_([q.id,q.status,q.attempt_status,q.claimed_at,q.sent_at,q.failed_at,q.last_error]);
    if(!smsRows_('Communication Log').some(r=>r['Log ID']===logId))smsAppend_('Communication Log',{'Log ID':logId,'Lead ID':src.leadId,'Campaign ID':src.campaignId,'Campaign Name':src.campaignName,'Channel':'SMS','Recipient':snap.payload.phone,'Sent At':q.status==='sent'?q.sent_at:'','Status':q.status,'Error':q.last_error||'','Delivery Key':p['Dedupe Key'],'Event ID':src.eventId,'Event Type':src.eventType,'Event Instance':src.eventInstance,'Business Event Key':p['Business Event Key'],'Submission ID':p['Submission ID'],'Queue ID':q.id,'Scheduled At UTC':q.scheduled_at,'Submitted At UTC':accepted['Recorded At UTC'],'Claimed At UTC':q.claimed_at||'','Failed At UTC':q.failed_at||'','Observed At UTC':obs['Recorded At UTC'],'Attempt Status':q.attempt_status||'','Log Event Type':'SMS_STATUS'});
    const lead=smsRows_('Master Leads').find(l=>l['Lead ID']===src.leadId);
    if(lead){const patch={'Last SMS Status':q.status,'Last SMS Queue ID':q.id};if(q.status==='sent'&&(!lead['Last SMS Sent At']||Date.parse(q.sent_at)>=Date.parse(lead['Last SMS Sent At']))){patch['Last SMS Sent At']=q.sent_at;patch['Last SMS Campaign']=src.campaignId;if(src.eventType==='New Lead'){patch['Welcome SMS Sent']='Yes';patch['Welcome SMS Sent At']=q.sent_at;}}smsPatch_('Master Leads','Lead ID',src.leadId,patch);}
  }
  const out=smsRows_('SMS Outbox');for(const c of smsRows_('Campaigns')){const rows=out.filter(r=>r['Campaign ID']===c['Campaign ID']),accepted=rows.filter(r=>r['Submission State']==='ACCEPTED');if(!rows.length)continue;
    smsPatch_('Campaigns','Campaign ID',c['Campaign ID'],{'SMS Submitted Count':new Set(accepted.map(r=>r['Queue ID'])).size,'SMS Sent Count':new Set(accepted.filter(r=>r['Backend Status']==='sent').map(r=>r['Queue ID'])).size,'SMS Failed Count':new Set(accepted.filter(r=>r['Backend Status']==='failed').map(r=>r['Queue ID'])).size,'SMS Unknown Count':new Set(accepted.filter(r=>r['Backend Status']==='unknown').map(r=>r['Queue ID'])).size,'SMS Last Run At':smsNow_(),'SMS Status':rows.some(r=>r['Backend Status']==='unknown')?'REVIEW_REQUIRED':c.Trigger!=='New Lead'&&accepted.length===rows.length&&rows.every(r=>['sent','failed','cancelled'].includes(r['Backend Status']))?'COMPLETE':'ACTIVE'});
  }
}

function smsPolicyAuthorized_(c) {
  const id='POLICY-'+c['SMS Policy Revision']+'-'+c['SMS Policy Fingerprint'];
  return smsJournal_().some(e=>e['Journal Event Type']==='POLICY_ARMED'&&e['Authorization ID']===id);
}
