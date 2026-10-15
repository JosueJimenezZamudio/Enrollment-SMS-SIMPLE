/** Phase 3B pure SMS rules. No transport or Sheet writes in this file. */
const SMS_SCHEMA = Object.freeze({
  'Templates': {offset:11, headers:['SMS Revision','SMS Status','SMS Content Hash','SMS Approved At','SMS Approved By','SMS Required Variables']},
  'Campaigns': {offset:26, headers:['SMS Approval Mode','SMS Control','SMS Status','SMS Submitted Count','SMS Sent Count','SMS Failed Count','SMS Unknown Count','SMS Last Run At','Business Event Type','Event Instance','SMS Policy Revision','SMS Policy Fingerprint']},
  'Master Leads': {offset:21, headers:['SMS Opt Out','SMS Opt Out At','SMS Permission','SMS Permission Source','Welcome SMS Sent','Welcome SMS Sent At','Last SMS Campaign','Last SMS Sent At','Last SMS Status','Last SMS Queue ID','Business Lead ID','CRM First Seen At']},
  'Communication Log': {offset:11, headers:['Event ID','Event Type','Event Instance','Business Event Key','Submission ID','Queue ID','Scheduled At UTC','Submitted At UTC','Claimed At UTC','Failed At UTC','Observed At UTC','Attempt Status','Log Event Type']},
  'Campaign Preview': {offset:12, headers:['SMS Outbox ID','SMS Approval Mode','SMS Control','GSM-7 Septets','Scheduled At UTC','SMS Validation','Business Event Key','SMS Revision']},
  'SMS Outbox': {offset:0, headers:['Outbox ID','Campaign ID','Lead ID','Business Lead ID','Event ID','Event Type','Event Instance','Business Event Key','Phone','Language','Template ID','SMS Revision','Custom Message','Variables JSON','Preview','GSM-7 Septets','Scheduled Time','Approval Mode','Send Control','Eligibility','Submission State','Frozen Message','Frozen ScheduledAt UTC','Dedupe Key','Submission ID','Snapshot Hash','Queue ID','Backend Status','Attempt Status','Submission Error','Backend Error','Submitted At','Claimed At','Sent At','Failed At','Last Checked At','Next Action At','HTTP Attempt Count','Authorization ID','Authorization Fingerprint','Status Sync','Created At','Source','Source Record ID']},
  'SMS Submission Log': {offset:0, headers:['Journal Event ID','Recorded At UTC','Journal Event Type','Outbox ID','Submission ID','Snapshot Event ID','Business Event Key','Dedupe Key','Authorization Mode','Authorization ID','Policy Revision','Source Snapshot JSON','Frozen Request JSON','Snapshot Hash','HTTP Attempt Number','HTTP Status','Queue ID','Submission State','Backend Observation JSON','Dispatch Lease Until','Next Action At','Safe Error']}
});
const SMS_DEFAULTS = Object.freeze({SMS_ENGINE_MODE:'PREVIEW_ONLY',SMS_AUTO_ENABLED:'FALSE',SMS_PAUSED:'TRUE',SMS_ROLLOUT_MODE:'ALLOWLIST',SMS_TEST_RECIPIENT_ALLOWLIST:'',WELCOME_SMS_START_AT:'',SMS_WELCOME_SOURCES:'Google Form,Squarespace',SMS_TIMEZONE:'America/Los_Angeles',SMS_MAX_NEW_PER_RUN:'5',SMS_MAX_STATUS_PER_RUN:'20',SMS_MAX_RUN_SECONDS:'240',SMS_HTTP_RETRY_LIMIT:'6',SMS_MAX_CAMPAIGN_LATENESS_MINUTES:'240',SMS_MAX_WELCOME_AGE_DAYS:'7',SMS_RULESET_VERSION:'crm-sms-v1'});
const SMS_QUEUE_FIELDS = ['id','dedupe_key','status','scheduled_at','claimed_at','sent_at','failed_at','last_error','attempt_status'];
const SMS_STATES = ['queued','claimed','sending','unknown','sent','failed','cancelled'];
function smsText_(v) { return v == null ? '' : String(v); }
function smsTrue_(v) { return /^(true|yes|1)$/i.test(smsText_(v).trim()); }
function smsHash_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s,Utilities.Charset.UTF_8).map(b=>('0'+(b&255).toString(16)).slice(-2)).join(''); }
function smsJsonHash_(x) { return smsHash_(JSON.stringify(x)); }
function smsPhone_(v) { const d=smsText_(v).replace(/\D/g,''); return d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'+d:null; }
function smsSeptets_(s) {
  const basic='@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  const ext='^{}\\[~]|€'; let n=0;
  for(const c of s) { if(basic.includes(c))n++; else if(ext.includes(c))n+=2; else return null; } return n;
}
function smsChannelIncludes_(value,channel) { return value===channel || value==='Both'; }
function smsTemplateHash_(t) { return smsJsonHash_([t['Template ID'],t['SMS Body EN']||'',t['SMS Body ES']||'',t['SMS Required Variables']||'']); }
function smsPolicyHash_(c,t) {
  return smsJsonHash_(['crm-sms-v1',...['Campaign ID','Trigger','Send Date','Send Time','Channel','Audience','Message Mode','Template ID','Event ID','SMS EN (custom/override)','SMS ES (custom/override)','SMS Approval Mode','Business Event Type','Event Instance'].map(k=>c[k]||''),t?t['SMS Revision']||'':'',t?smsTemplateHash_(t):'']);
}
function smsBusiness_(c,l) {
  const parts=['crm-event-v1',CRM.ID,l['Business Lead ID'],c['Campaign ID'],c['Business Event Type'],c['Event Instance']];
  if(parts.some(v=>!smsText_(v).trim()))throw new Error('MISSING_BUSINESS_IDENTITY');
  const key='crm-event-v1:'+smsJsonHash_(parts); return {key,dedupe:'enrollment:sms:v1:'+smsJsonHash_([key,'SMS'])};
}
// Only an explicit Spanish preference selects ES; all other values default to EN.
function smsLanguage_(v) { return /^(español|espanol|spanish|es)$/i.test(smsText_(v).trim()) ? 'ES' : 'EN'; }
function smsEffectiveManual_(c,lang,custom) {
  return !!smsText_(custom).trim() || c['Message Mode']==='Custom' || (c['Message Mode']==='Template + Override' && !!smsText_(c['SMS '+lang+' (custom/override)']).trim());
}
function smsRender_(c,t,e,l,custom) {
  const lang=smsLanguage_(l['Preferred Language']); const vars=campaignMergeValues_(c,e,l,lang);
  const result=smsText_(custom).trim()?{text:smsText_(custom),issues:[]}:campaignRender_(campaignMessage_(c,t,'SMS',lang).body,vars);
  const body=result.text.trim(), septets=smsSeptets_(body), issues=result.issues.slice();
  if(!body)issues.push('EMPTY_MESSAGE'); if(septets===null)issues.push('NON_GSM7'); else if(septets>160)issues.push('OVER_ONE_SEGMENT');
  if(!smsText_(custom).trim() && t && c['Message Mode']!=='Custom') {
    smsText_(t['SMS Required Variables']).split(',').map(x=>x.trim()).filter(Boolean).forEach(k=>{if(!Object.prototype.hasOwnProperty.call(vars,k)||!smsText_(vars[k]).trim())issues.push('MISSING_VARIABLE:'+k);});
  }
  return {body,septets,issues:[...new Set(issues)],lang,vars,manual:smsEffectiveManual_(c,lang,custom)};
}
function smsIso_(s) {
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(smsText_(s)))throw new Error('INVALID_UTC_SCHEDULE');
  const d=new Date(s);if(!Number.isFinite(d.getTime()))throw new Error('INVALID_UTC_SCHEDULE');
  const day=s.slice(0,10), parts=day.split('-').map(Number); const calendar=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
  if(calendar.toISOString().slice(0,10)!==day)throw new Error('INVALID_CALENDAR_DATE');return d.toISOString();
}
/** Convert a CRM wall time to UTC; ambiguous/nonexistent DST times are rejected. */
function smsWallToIso_(date,time,tz) {
  let d=smsText_(date).trim(),m=d.match(/^([A-Za-z]{3}) (\d{1,2}),? (\d{4})$/);
  if(m){const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase())+1;if(!month)throw new Error('INVALID_DATE');d=m[3]+'-'+String(month).padStart(2,'0')+'-'+m[2].padStart(2,'0');}
  m=d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);if(m)d=m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');
  const t=smsText_(time).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if(!/^\d{4}-\d\d-\d\d$/.test(d)||!t)throw new Error('INVALID_CAMPAIGN_SCHEDULE');
  let h=Number(t[1]);if(t[4]){if(h<1||h>12)throw new Error('INVALID_TIME');h=h%12+(t[4].toUpperCase()==='PM'?12:0);}
  if(h>23||Number(t[2])>59||Number(t[3]||0)>59)throw new Error('INVALID_TIME');
  const stamp=d+' '+String(h).padStart(2,'0')+':'+t[2]+':'+(t[3]||'00');
  const naive=Date.parse(smsIso_(stamp.replace(' ','T')+'Z')),offsets=new Set();
  [-86400000,0,86400000].forEach(delta=>offsets.add(Utilities.formatDate(new Date(naive+delta),tz,'Z')));
  const hits=[];for(const z of offsets){const match=z.match(/^([+-])(\d{2})(\d{2})$/);if(!match)throw new Error('INVALID_TIMEZONE_OFFSET');const mins=(Number(match[2])*60+Number(match[3]))*(match[1]==='-'?-1:1);const at=new Date(naive-mins*60000);if(Utilities.formatDate(at,tz,'yyyy-MM-dd HH:mm:ss')===stamp)hits.push(at.toISOString());}
  if(hits.length!==1)throw new Error('AMBIGUOUS_OR_INVALID_LOCAL_SCHEDULE');return hits[0];
}
function smsCreatedMs_(value,tz) {
  const s=smsText_(value);if(/(?:Z|[+-]\d\d:\d\d)$/.test(s))return Date.parse(smsIso_(s));
  const stamp=emailAutoNormalizeTimestamp_(s);if(!stamp)return NaN;
  return Date.parse(smsWallToIso_(stamp.slice(0,10),stamp.slice(11),tz));
}

function smsScheduled_(c,s,override) {
  if(smsText_(override).trim())return smsIso_(override);
  if(c['Trigger']==='Scheduled')return smsWallToIso_(c['Send Date'],c['Send Time'],s.SMS_TIMEZONE);
  if(c['Trigger']!=='New Lead' && c['Trigger']!=='Manual')throw new Error('UNSUPPORTED_TRIGGER');return '';
}
function smsEligibility_(c,t,e,l,leads,s,now,custom) {
  const r=smsRender_(c,t,e,l,custom), issues=r.issues.slice(), phone=smsPhone_(l.Phone);
  if(!smsChannelIncludes_(c.Channel,'SMS'))issues.push('SMS_CHANNEL_DISABLED');
  if(c.Enabled!=='Yes'||c['SMS Control']!=='READY')issues.push('CAMPAIGN_NOT_ARMED');
  if(!['AUTO','MANUAL'].includes(c['SMS Approval Mode']))issues.push('INVALID_APPROVAL_MODE');
  if(!campaignEligible_(l,c.Audience))issues.push('INELIGIBLE_AUDIENCE');
  if(!phone)issues.push('INVALID_PHONE');
  if(l['SMS Permission']!=='Allowed'||!smsText_(l['SMS Permission Source']).trim())issues.push('SMS_PERMISSION_REQUIRED');
  if(leads.some(x=>phone&&smsPhone_(x.Phone)===phone&&(smsTrue_(x['SMS Opt Out'])||x['SMS Permission']==='Denied')))issues.push('SMS_SUPPRESSED');
  if(smsTrue_(l['SMS Opt Out']))issues.push('SMS_SUPPRESSED');
  const householdEmail=smsText_(l.Email).trim().toLowerCase();
  const household=householdEmail?leads.filter(x=>smsText_(x.Email).trim().toLowerCase()===householdEmail):[l];
  if(new Set(household.map(x=>x['Business Lead ID']).filter(Boolean)).size>1)issues.push('HOUSEHOLD_IDENTITY_CONFLICT');
  if(!l['Business Lead ID']||l['Business Lead ID']!==l['Lead ID'])issues.push('DUPLICATE_HOUSEHOLD');
  if(c['Event ID']&&(!e||e.Status!=='Confirmed'))issues.push('EVENT_NOT_CONFIRMED');
  if(!['Template','Custom','Template + Override'].includes(c['Message Mode']))issues.push('INVALID_MESSAGE_MODE');
  if(!r.manual&&(!t||t.Status!=='Approved'||t['SMS Status']!=='Approved'||t['SMS Content Hash']!==smsTemplateHash_(t)))issues.push('SMS_TEMPLATE_NOT_APPROVED');
  if(c['SMS Policy Fingerprint']!==smsPolicyHash_(c,t))issues.push('POLICY_CHANGED');
  if(s.SMS_ROLLOUT_MODE==='ALLOWLIST') {
    const allow=smsText_(s.SMS_TEST_RECIPIENT_ALLOWLIST).split(/[,\s]+/).filter(Boolean).map(smsPhone_);
    if(!phone||!allow.includes(phone))issues.push('NOT_ON_TEST_ALLOWLIST');
  } else if(s.SMS_ROLLOUT_MODE!=='PRODUCTION')issues.push('INVALID_ROLLOUT_MODE');
  if(c.Trigger==='New Lead') {
    const cutoff=Date.parse(s.WELCOME_SMS_START_AT),first=Date.parse(l['CRM First Seen At']);
    let created;try{created=smsCreatedMs_(l['Created At'],s.SMS_TIMEZONE);}catch(_){created=NaN;}
    if(!Number.isFinite(cutoff)||!Number.isFinite(first)||first<=cutoff||!Number.isFinite(created)||created<cutoff||created>now+120000||now-created>Number(s.SMS_MAX_WELCOME_AGE_DAYS)*86400000)issues.push('HISTORICAL_OR_STALE_WELCOME');
    if(!smsText_(s.SMS_WELCOME_SOURCES).split(',').map(x=>x.trim()).includes(l.Source))issues.push('SOURCE_NOT_ENABLED');
    if(smsTrue_(l['Welcome SMS Sent']))issues.push('ALREADY_WELCOMED');
  }
  return {...r,phone,issues:[...new Set(issues)]};
}
function smsFreeze_(candidate,now) {
  const schedule=candidate.scheduledAt?smsIso_(candidate.scheduledAt):new Date(now).toISOString();
  const payload={phone:candidate.phone,message:candidate.body.trim(),leadId:candidate.leadId||null,eventType:candidate.eventType||null,dedupeKey:candidate.dedupe,scheduledAt:schedule};
  if(!smsPhone_(payload.phone)||!payload.message||smsSeptets_(payload.message)===null||smsSeptets_(payload.message)>160)throw new Error('INVALID_FROZEN_PAYLOAD');
  const body=JSON.stringify(payload); return {body,hash:smsHash_(body),payload};
}
function smsResponse_(status,raw,snapshot,knownId,readOnly) {
  if(status===401)return {state:'AUTH_ERROR',error:'Endpoint credential rejected'};
  if(status===409)return {state:'CONFLICT',error:'Dedupe conflict; do not change payload or key'};
  if(status===404&&readOnly)return {state:'NOT_FOUND',error:'Item unavailable to this client; acceptance is not disproven'};
  if(status===400)return {state:'REVIEW_REQUIRED',error:'Request rejected; inspect the frozen request'};
  if(status===429||status>=500||status===0) return {state:'RETRY_PENDING',error:'Temporary API/network failure; preserve frozen request'};
  let data;try{data=JSON.parse(raw);}catch(_){return {state:'REVIEW_REQUIRED',error:'Invalid response JSON; reconcile same identity'};}
  if(![200,201].includes(status)||data.ok!==true||!data.queued)return {state:'REVIEW_REQUIRED',error:'Unexpected API response'};
  const q=data.queued,p=JSON.parse(snapshot.body),keys=Object.keys(q).sort();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(JSON.stringify(keys)!==JSON.stringify(SMS_QUEUE_FIELDS.slice().sort())||!uuid.test(q.id)||q.dedupe_key!==p.dedupeKey||(knownId&&q.id!==knownId)||!SMS_STATES.includes(q.status)||Date.parse(q.scheduled_at)!==Date.parse(p.scheduledAt)||(!readOnly&&(data.dedupeKey!==p.dedupeKey||typeof data.duplicate!=='boolean'))||![null,'claimed','sending','unknown','sent','failed','expired','cancelled'].includes(q.attempt_status))return {state:'REVIEW_REQUIRED',error:'Backend identity, projection or schedule mismatch'};
  for(const k of ['claimed_at','sent_at','failed_at'])if(q[k]!==null&&!Number.isFinite(Date.parse(q[k])))return {state:'REVIEW_REQUIRED',error:'Invalid backend timestamp'};
  if(q.status==='sent'&&!q.sent_at||q.status==='failed'&&!q.failed_at)return {state:'REVIEW_REQUIRED',error:'Missing terminal timestamp'};
  if(q.last_error!==null&&q.last_error!=='SMS transport reported an error; operator review required')return {state:'REVIEW_REQUIRED',error:'Unexpected backend error projection'};
  return {state:readOnly?'OBSERVED':'ACCEPTED',queue:q};
}
