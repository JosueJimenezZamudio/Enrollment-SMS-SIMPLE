/** Append-only journal and additive CRM migration. Call mutations under smsLocked_. */
function smsNow_() { return new Date().toISOString(); }
function smsSs_() {
  const expected=PropertiesService.getScriptProperties().getProperty('SMS_EXPECTED_CRM_ID');
  if(expected&&expected!==CRM.ID)throw new Error('SMS_CRM_BINDING_MISMATCH');
  return campaignSpreadsheet_();
}
function smsLocked_(fn) {
  const lock=LockService.getScriptLock(); if(!lock.tryLock(15000))throw new Error('SMS_LOCK_BUSY');
  try{return fn();}finally{lock.releaseLock();}
}
function smsRows_(name) {
  const sh=smsSs_().getSheetByName(name);if(!sh)throw new Error('SMS_MISSING_TAB:'+name);
  const w=sh.getLastColumn(), headers=sh.getRange(1,1,1,w).getDisplayValues()[0];
  const nonempty=headers.filter(Boolean);if(new Set(nonempty).size!==nonempty.length)throw new Error('DUPLICATE_HEADERS:'+name);
  const spec=SMS_SCHEMA[name];if(spec)spec.headers.forEach((h,i)=>{if(headers[spec.offset+i]!==h)throw new Error('SMS_HEADER_MISMATCH:'+name+':'+h);});
  return sh.getLastRow()<2?[]:sh.getRange(2,1,sh.getLastRow()-1,w).getDisplayValues().map((r,i)=>Object.assign({_row:i+2},Object.fromEntries(headers.map((h,j)=>[h,r[j]])))).filter(r=>smsText_(r[headers[0]]).trim());
}
function smsSettings_() { const rows=smsRows_('Settings'), s={...SMS_DEFAULTS};const seen=new Set(); rows.forEach(r=>{if(seen.has(r.Key))throw new Error('DUPLICATE_SETTING');seen.add(r.Key);s[r.Key]=r.Value;}); return s; }
function smsColumn_(n) { let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s; }
/** Sheets REST RAW avoids formula interpretation without altering the saved bytes. */
function smsRaw_(name,row,col,values) {
  const sh=smsSs_().getSheetByName(name),height=values.length,width=values[0].length;
  if(sh.getMaxRows()<row+height-1)sh.insertRowsAfter(sh.getMaxRows(),row+height-1-sh.getMaxRows());
  const a1="'"+name.replace(/'/g,"''")+"'!"+smsColumn_(col)+row+':'+smsColumn_(col+width-1)+(row+height-1);
  const url='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(CRM.ID)+'/values/'+encodeURIComponent(a1)+'?valueInputOption=RAW';
  const res=UrlFetchApp.fetch(url,{method:'put',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({range:a1,majorDimension:'ROWS',values}),muteHttpExceptions:true});
  if(res.getResponseCode()!==200)throw new Error('SMS_SHEET_WRITE_FAILED');
  SpreadsheetApp.flush();
  const actual=sh.getRange(row,col,height,width).getValues().map(r=>r.map(smsText_));
  if(JSON.stringify(actual)!==JSON.stringify(values.map(r=>r.map(smsText_))))throw new Error('SMS_SHEET_WRITE_UNVERIFIED');
}
function smsPatch_(name,idField,id,patch) {
  const matches=smsRows_(name).filter(r=>r[idField]===id);if(matches.length!==1)throw new Error('SMS_ROW_ID_NOT_UNIQUE:'+name);
  const sh=smsSs_().getSheetByName(name),h=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0];
  const changes=Object.entries(patch).map(([k,v])=>({index:h.indexOf(k),value:v==null?'':v,key:k})).filter(x=>smsText_(matches[0][x.key])!==smsText_(x.value)).sort((a,b)=>a.index-b.index);
  if(changes.some(x=>x.index<0))throw new Error('SMS_MISSING_COLUMN');
  if(!changes.length)return;
  // Patch only changed cells; never rewrite intervening email/user columns.
  const data=changes.map(x=>({range:"'"+name.replace(/'/g,"''")+"'!"+smsColumn_(x.index+1)+matches[0]._row,values:[[x.value]]}));
  const url='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(CRM.ID)+'/values:batchUpdate';
  const res=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({valueInputOption:'RAW',data}),muteHttpExceptions:true,followRedirects:false});
  if(res.getResponseCode()!==200)throw new Error('SMS_SHEET_WRITE_FAILED');
  SpreadsheetApp.flush();
  const first=changes[0].index,last=changes[changes.length-1].index;
  const actual=sh.getRange(matches[0]._row,first+1,1,last-first+1).getValues()[0];
  if(changes.some(x=>smsText_(actual[x.index-first])!==smsText_(x.value)))throw new Error('SMS_SHEET_WRITE_UNVERIFIED');

}
function smsAppend_(name,obj) {
  const sh=smsSs_().getSheetByName(name),h=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0];
  smsRaw_(name,sh.getLastRow()+1,1,[h.map(k=>obj[k]==null?'':obj[k])]);
}
function smsJournal_() {
  const rows=smsRows_('SMS Submission Log'), ids=new Map();
  for(const r of rows){const old=ids.get(r['Journal Event ID']);const canonical=JSON.stringify(SMS_SCHEMA['SMS Submission Log'].headers.map(k=>r[k]));if(old&&old!==canonical)throw new Error('SMS_JOURNAL_CONFLICT');ids.set(r['Journal Event ID'],canonical);}
  return rows.filter((r,i)=>rows.findIndex(x=>x['Journal Event ID']===r['Journal Event ID'])===i);
}
function smsEvent_(type,data,id) {
  const obj={...data,'Journal Event ID':id||Utilities.getUuid(),'Recorded At UTC':smsNow_(),'Journal Event Type':type};
  const existing=smsJournal_().find(r=>r['Journal Event ID']===obj['Journal Event ID']);
  if(existing){for(const k of Object.keys(data))if(smsText_(existing[k])!==smsText_(data[k]))throw new Error('SMS_EVENT_CONFLICT');return existing;}
  smsAppend_('SMS Submission Log',obj);
  const saved=smsJournal_().find(r=>r['Journal Event ID']===obj['Journal Event ID']);if(!saved)throw new Error('SMS_EVENT_NOT_DURABLE');return saved;
}
function smsSnapshot_(event) {
  const body=event['Frozen Request JSON'];if(!body||smsHash_(body)!==event['Snapshot Hash'])throw new Error('SMS_SNAPSHOT_CORRUPT');
  const p=JSON.parse(body);if(JSON.stringify(Object.keys(p))!==JSON.stringify(['phone','message','leadId','eventType','dedupeKey','scheduledAt'])||p.dedupeKey!==event['Dedupe Key'])throw new Error('SMS_SNAPSHOT_IDENTITY_CONFLICT');
  return {body,hash:event['Snapshot Hash'],payload:p};
}
function smsSubmissions_(events) {
  const map=new Map();
  events.filter(e=>e['Journal Event Type']==='PREPARED').forEach(e=>{smsSnapshot_(e);if(map.has(e['Dedupe Key']))throw new Error('SMS_MULTIPLE_SNAPSHOTS');map.set(e['Dedupe Key'],{prepared:e,events:events.filter(x=>x['Submission ID']===e['Submission ID'])});});
  const submissions=[...map.values()];
  for(const row of smsRows_('SMS Outbox'))if(row['Submission ID']&&!submissions.some(s=>s.prepared['Submission ID']===row['Submission ID']&&s.prepared['Outbox ID']===row['Outbox ID']))throw new Error('SMS_SNAPSHOT_MISSING');
  return submissions;
}
function smsSetSetting_(key,value) { smsPatch_('Settings','Key',key,{Value:value}); }
function smsLimit_(s,k,max) { const n=Number(s[k]);if(!Number.isInteger(n)||n<1||n>max)throw new Error('INVALID_SMS_LIMIT:'+k);return n; }
function smsOperator_() {
  const allowed=PropertiesService.getScriptProperties().getProperty('SMS_OPERATOR_EMAIL');
  const who=Session.getEffectiveUser().getEmail();if(!allowed||!who||who!==allowed)throw new Error('SMS_OPERATOR_REQUIRED');return who;
}
/** Add schema only. Never enables SMS, creates a trigger, or calls producer APIs. */
function installSmsCrmPaused() {
  return smsLocked_(()=>{
    const ss=smsSs_(), settings=ss.getSheetByName('Settings');
    const current=settings.getRange(2,1,Math.max(1,settings.getLastRow()-1),2).getDisplayValues();
    const existing=Object.fromEntries(current);
    if(existing.SMS_ENGINE_MODE==='LIVE'||smsTrue_(existing.SMS_AUTO_ENABLED))throw new Error('PAUSE_SMS_BEFORE_MIGRATION');
    for(const [name,spec] of Object.entries(SMS_SCHEMA)) {
      let sh=ss.getSheetByName(name);if(!sh){if(spec.offset)throw new Error('EXISTING_CRM_TAB_MISSING');sh=ss.insertSheet(name);}
      const width=spec.offset+spec.headers.length;
      if(sh.getMaxColumns()<width)sh.insertColumnsAfter(sh.getMaxColumns(),width-sh.getMaxColumns());
      const before=sh.getRange(1,spec.offset+1,1,spec.headers.length).getDisplayValues()[0];
      before.forEach((v,i)=>{if(v&&v!==spec.headers[i])throw new Error('APPEND_RANGE_OCCUPIED:'+name);});
      sh.getRange(1,spec.offset+1,1,spec.headers.length).setValues([spec.headers]).setBackground('#1a2e52').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
      sh.setColumnWidths(spec.offset+1,spec.headers.length,170);sh.setFrozenRows(1);
      if(!spec.offset){sh.setFrozenColumns(2);sh.getRange(2,1,sh.getMaxRows()-1,width).setNumberFormat('@');}
    }
    for(const [key,val] of Object.entries(SMS_DEFAULTS))if(!Object.prototype.hasOwnProperty.call(existing,key))settings.appendRow([key,val,'Phase 3B SMS setting; independent of email switches.']);
    SpreadsheetApp.flush();
    const props=PropertiesService.getScriptProperties(),who=Session.getEffectiveUser().getEmail();
    if(!who)throw new Error('OPERATOR_IDENTITY_UNAVAILABLE');
    if(!props.getProperty('SMS_OPERATOR_EMAIL'))props.setProperty('SMS_OPERATOR_EMAIL',who);
    props.setProperty('SMS_EXPECTED_CRM_ID',CRM.ID);
    if(!props.getProperty('SMS_BASELINE_AT')) {
      const at=smsNow_();
      // Persist the cutover boundary before any seeding. Re-running never re-arms history.
      props.setProperty('SMS_BASELINE_AT',at);

    }
    smsSeedLeadsLocked_(true);
    smsValidationRules_();
    smsProtectRanges_();
    props.setProperty('SMS_SCHEMA_READY','true');
    return validateSmsCrm();
  });
}
function smsSeedLeadsLocked_(installation) {
  const props=PropertiesService.getScriptProperties(),baseline=props.getProperty('SMS_BASELINE_AT');if(!baseline)throw new Error('SMS_NOT_INSTALLED');

  const leads=smsRows_('Master Leads');
  for(const l of leads) {
    const email=smsText_(l.Email).trim().toLowerCase();
    const group=email?leads.filter(x=>smsText_(x.Email).trim().toLowerCase()===email):[l];
    const mapped=[...new Set(group.map(x=>x['Business Lead ID']).filter(Boolean))];
    let business=mapped.length===1?mapped[0]:'';
    if(!mapped.length){const primary=email?emailAutoPrimaryWelcomeLead_(leads,email):l;business=primary?primary['Lead ID']:l['Lead ID'];}
    if(mapped.length>1)business=''; // conflict stays blocked, not silently remapped
    const patch={};if(!l['Business Lead ID']&&business)patch['Business Lead ID']=business;
    if(!l['CRM First Seen At'])patch['CRM First Seen At']=installation?baseline:smsNow_();
    if(!l['SMS Permission'])patch['SMS Permission']='Unknown';
    if(Object.keys(patch).length)smsPatch_('Master Leads','Lead ID',l['Lead ID'],patch);
  }
}
function smsValidationRules_() {
  const rules=[['Campaigns',27,['AUTO','MANUAL']],['Campaigns',28,['DRAFT','READY','HOLD']],['Templates',13,['Draft','Approved','Hold']],['Master Leads',24,['Allowed','Unknown','Denied']],['SMS Outbox',18,['AUTO','MANUAL']],['SMS Outbox',19,['DRAFT','READY','HOLD']]];
  rules.forEach(([name,col,options])=>{const sh=smsSs_().getSheetByName(name);sh.getRange(2,col,sh.getMaxRows()-1,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(options,true).setAllowInvalid(false).build());});
}
function validateSmsCrm() {
  const expected={'Master Leads':[...CRM.HEADERS,'Email Opt Out','Email Opt Out At','ZIP Code'],Campaigns:campaignHeaders_(),Templates:templateHeaders_(),'Communication Log':EMAIL_AUTO.LOG_HEADERS,'Campaign Preview':previewHeaders_()};
  for(const [name,headers] of Object.entries(expected))campaignAssertHeaders_(smsSs_().getSheetByName(name),headers);
  Object.keys(SMS_SCHEMA).forEach(smsRows_);const s=smsSettings_();smsSubmissions_(smsJournal_());
  return {schema:'crm-sms-v1',mode:s.SMS_ENGINE_MODE,paused:smsTrue_(s.SMS_PAUSED),auto:smsTrue_(s.SMS_AUTO_ENABLED),outbox:smsRows_('SMS Outbox').length,producerCalls:0};
}
/** Protect only new SMS ranges. Owners can still edit; this is an audit journal,
 * not storage that is tamper-proof against the spreadsheet owner. */
function smsProtectRanges_() {
  const ss=smsSs_(),operator=smsOperator_();
  const ranges=[['SMS Submission Log',1,22],['SMS Outbox',1,12],['SMS Outbox',14,3],['SMS Outbox',20,25],['Templates',12,5],['Campaigns',27,12],['Master Leads',24,10],['Communication Log',12,13],['Campaign Preview',13,8]];
  for(const [name,col,width] of ranges){
    const sh=ss.getSheetByName(name),label='Enrollment SMS managed '+col+':'+width;
    let p=sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).find(x=>x.getDescription()===label);
    if(!p)p=sh.getRange(1,col,sh.getMaxRows(),width).protect().setDescription(label);
    p.setWarningOnly(false);p.addEditor(operator);
    const others=p.getEditors().filter(u=>u.getEmail()!==operator);if(others.length)p.removeEditors(others);
    if(p.canDomainEdit())p.setDomainEdit(false);
  }
  for(const row of smsRows_('Settings').filter(r=>Object.prototype.hasOwnProperty.call(SMS_DEFAULTS,r.Key)||['WELCOME_SMS_ENABLED','CAMPAIGN_SMS_ENABLED'].includes(r.Key))){
    const sh=ss.getSheetByName('Settings'),label='Enrollment SMS setting '+row.Key;
    let p=sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).find(x=>x.getDescription()===label);
    if(!p)p=sh.getRange(row._row,1,1,3).protect().setDescription(label);
    p.setWarningOnly(false);p.addEditor(operator);const others=p.getEditors().filter(u=>u.getEmail()!==operator);if(others.length)p.removeEditors(others);if(p.canDomainEdit())p.setDomainEdit(false);
  }
}
/** No producer credentials and no queue writes: verify real runtime + public 401. */
function validateStoppedSmsIntegration() {
  smsOperator_();const result=validateSmsCrm(),s=smsSettings_();
  if(smsCanIngest_(s)||smsTrue_(s.SMS_AUTO_ENABLED)||smsTrue_(s.WELCOME_SMS_ENABLED)||smsTrue_(s.CAMPAIGN_SMS_ENABLED))throw new Error('SMS_MUST_BE_STOPPED');
  if(smsRows_('SMS Outbox').length||smsJournal_().length)throw new Error('EXPECTED_EMPTY_SMS_TABS');
  if(ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='runSmsWorker'))throw new Error('UNEXPECTED_SMS_TRIGGER');
  const statuses={};for(const endpoint of ['queue-enrollment-sms','sms-queue-status']){
    const r=UrlFetchApp.fetch('https://rccdxrmyavihzdrgokpv.supabase.co/functions/v1/'+endpoint,{method:'post',contentType:'application/json',payload:'{}',muteHttpExceptions:true,followRedirects:false});
    if(r.getResponseCode()!==401)throw new Error('UNEXPECTED_UNAUTHORIZED_RESPONSE');statuses[endpoint]=401;
  }
  console.log(JSON.stringify({...result,unauthorized:statuses,smsTrigger:false}));return result;
}

/** Read one header cell through the same REST API; log no body or credentials. */
function diagnoseSmsSheetAccess() {
  smsOperator_();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
    encodeURIComponent(CRM.ID) + '/values/' + encodeURIComponent("'Master Leads'!A1");
  const response = UrlFetchApp.fetch(url, {
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions: true,
    followRedirects: false
  });
  let error = {};
  try { error = JSON.parse(response.getContentText()).error || {}; } catch (_) {}
  const allowed = ['SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED',
    'accessNotConfigured', 'insufficientPermissions', 'forbidden'];
  const reasons = [error.status]
    .concat((Array.isArray(error.errors) ? error.errors : []).map(x => x.reason))
    .concat((Array.isArray(error.details) ? error.details : []).map(x => x.reason))
    .filter(x => allowed.includes(x));
  const result = {httpStatus: response.getResponseCode(), reasons: [...new Set(reasons)]};
  console.log(JSON.stringify(result));
  return result;
}
