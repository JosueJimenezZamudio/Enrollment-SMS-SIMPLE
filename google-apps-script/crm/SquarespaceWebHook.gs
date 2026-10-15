/** Authenticated Zapier -> Squarespace CRM intake. No email sending. */
const SQSP_HOOK = Object.freeze({
 CRM_ID:'1KUmlLfCJIkrmui-FHDn3mnbqEJ0n2yp-QJwU-Ja-8x4',
 SECRET_PROPERTY:'SQSP_HOOK_SECRET_SHA256',ACTION:'squarespace_lead'
});
function initializeSquarespaceWebhookSecret() {
 const props=PropertiesService.getScriptProperties();
 if(props.getProperty(SQSP_HOOK.SECRET_PROPERTY)) {console.log('Secret already exists.');return;}
 const token=Array.from({length:4},()=>Utilities.getUuid().replace(/-/g,'')).join('');
 props.setProperty(SQSP_HOOK.SECRET_PROPERTY,sqspHash_(token));
 console.log('PRIVATE TOKEN — COPY TO ZAPIER, DO NOT SHARE: '+token);
}
function rotateSquarespaceWebhookSecret() {
 const token=Array.from({length:4},()=>Utilities.getUuid().replace(/-/g,'')).join('');
 PropertiesService.getScriptProperties().setProperty(SQSP_HOOK.SECRET_PROPERTY,sqspHash_(token));
 console.log('NEW PRIVATE TOKEN — UPDATE ZAPIER: '+token);
}
function validateSquarespaceWebhookSetup(){
 const sheet=SpreadsheetApp.openById(SQSP_HOOK.CRM_ID).getSheetByName('Master Leads');
 if(!sheet)throw new Error('Master Leads is missing');
 sqspCols_(sheet);
 const out={enabled:getSetting_('SQUARESPACE_WEBHOOK_ENABLED'),hasSecret:!!PropertiesService.getScriptProperties().getProperty(SQSP_HOOK.SECRET_PROPERTY),mode:getSetting_('CAMPAIGN_ENGINE_MODE'),emailsSent:0};
 console.log(JSON.stringify(out));return out;
}
function sqspIsWebhook_(e){
 if(!e)return false;
 if(e.parameter&&e.parameter.action===SQSP_HOOK.ACTION)return true;
 try{return JSON.parse((e.postData||{}).contents||'{}').action===SQSP_HOOK.ACTION;}catch(_){return false;}
}
function sqspWebhookDoPost_(e){
 try{
  const raw=(e.postData||{}).contents||'';
  if(raw.length>16000)throw new Error('Payload too large');
  const p=raw.trim().startsWith('{')?JSON.parse(raw):e.parameter||{};
  if(p.action!==SQSP_HOOK.ACTION)throw new Error('Unknown action');
  const expected=PropertiesService.getScriptProperties().getProperty(SQSP_HOOK.SECRET_PROPERTY);
  if(!expected||!sqspEqual_(sqspHash_(String(p.secret||'')),expected))return sqspJson_({ok:false,code:'UNAUTHORIZED'});
  if(getSetting_('SQUARESPACE_WEBHOOK_ENABLED')!=='TRUE')return sqspJson_({ok:false,code:'DISABLED'});
  const take=(...keys)=>{for(const k of keys){const x=p[k];if(typeof x==='string'||typeof x==='number'){const s=String(x).trim();if(s)return s.slice(0,500);}}return '';};
  const email=take('email','Email','email_address').toLowerCase();
  if(!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email))return sqspJson_({ok:false,code:'INVALID_EMAIL'});
  const rawGrade=take('student_current_grade','grade','Student Current Grade');
  const match=rawGrade.match(/(?:^|\D)(9|10|11|12)(?:st|nd|rd|th)?(?:\D|$)/i);
  const rawLanguage=take('language','preferred_language','Language');
  const language=/span|espa/i.test(rawLanguage)?'Espanol':/engl|ingl/i.test(rawLanguage)?'English':rawLanguage;
  const dateRaw=take('submitted_at','submission_date','Submission Date');
  const date=dateRaw&&!isNaN(new Date(dateRaw).valueOf())?new Date(dateRaw):new Date();
  const result=sqspSaveLead_({email,name:take('parent_name','name','Parent Name'),phone:take('phone','phone_number','Phone'),grade:match?match[1]:rawGrade,zip:take('zip_code','zip','postal_code','Your Zip Code'),language,date});
  // A retry or existing email must never send another welcome message.
  // A failure after saving the lead must not make Zapier retry an email.
  let welcome={status:result.action==='created'?'NOT_ENABLED':'NOT_NEW'};
  if(result.action==='created') {
   try { welcome=sqspWelcomeAfterWebhook_(result,email); }
   catch(err) {console.error('Squarespace welcome error: '+String(err && err.message||err).slice(0,200));welcome={status:'REVIEW_REQUIRED'};}
  }
  console.log('Squarespace lead '+result.action+' row '+result.row+'; welcome '+welcome.status);
  return sqspJson_({ok:true,action:result.action,source:'Squarespace',welcomeEmailSent:welcome.status==='SENT',welcomeStatus:welcome.status});
 }catch(error){console.error('Squarespace intake failed: '+String(error.message||error).slice(0,120));return sqspJson_({ok:false,code:'PROCESSING_ERROR'});}
}
function sqspSaveLead_(lead){
 const lock=LockService.getScriptLock();lock.waitLock(25000);
 try{
  const sheet=SpreadsheetApp.openById(SQSP_HOOK.CRM_ID).getSheetByName('Master Leads');
  const C=sqspCols_(sheet),w=sheet.getLastColumn(),last=sheet.getLastRow();
  const rows=last>1?sheet.getRange(2,1,last-1,w).getValues():[];
  const found=rows.findIndex(r=>String(r[C.Email-1]||'').trim().toLowerCase()===lead.email);
  const sourceKey='SQSP-'+sqspHash_('squarespace|'+lead.email).slice(0,24);
  if(found>=0){
   const row=rows[found],n=found+2;let edits=0;
   for(const [key,value] of [['Parent Name',lead.name],['Phone',lead.phone],['Current Grade',lead.grade],['Preferred Language',lead.language],['ZIP Code',lead.zip]]){
    if(value&&(row[C[key]-1]===''||row[C[key]-1]==null)){sheet.getRange(n,C[key]).setValue(value);edits++;}
   }
   // Keep original source attribution when another form collected the person first.
   if(String(row[C.Source-1]||'')==='Squarespace'&&!row[C['Source Record ID']-1]){
    sheet.getRange(n,C['Source Record ID']).setValue(sourceKey);edits++;
   }
   SpreadsheetApp.flush();return {action:edits?'updated':'already_exists',row:n};
  }
  const values=Array(w).fill('');
  const put=(k,v)=>{values[C[k]-1]=v;};
  put('Lead ID','LEAD-'+Utilities.getUuid());put('Created At',lead.date);put('Parent Name',lead.name);
  put('Email',lead.email);put('Phone',lead.phone);put('Current Grade',lead.grade);
  put('Preferred Language',lead.language);put('ZIP Code',lead.zip);put('Source','Squarespace');
  put('Source Record ID',sourceKey);put('Active Lead','Yes');
  sheet.getRange(last+1,1,1,w).setValues([values]);
  sheet.getRange(last+1,C['Created At']).setNumberFormat('M/d/yyyy H:mm:ss');
  sheet.getRange(last+1,C['ZIP Code']).setNumberFormat('@');
  SpreadsheetApp.flush();return {action:'created',row:last+1};
 }finally{lock.releaseLock();}
}
function sqspCols_(sheet){
 const h=sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0],cols={};
 h.forEach((x,i)=>{cols[String(x).trim()]=i+1;});
 for(const k of ['Lead ID','Created At','Parent Name','Email','Phone','Current Grade','Preferred Language','ZIP Code','Source','Source Record ID','Active Lead'])if(!cols[k])throw new Error('Missing column '+k);
 return cols;
}
function sqspHash_(x){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(x),Utilities.Charset.UTF_8).map(b=>('0'+(b&255).toString(16)).slice(-2)).join('');}
function sqspEqual_(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function sqspJson_(data){return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);}


/**
 * Squarespace instant welcome bridge (v2).
 * Preserves the authenticated Zapier endpoint above and routes ONLY newly
 * created CRM leads through the existing email engine. No extra doPost.
 *
 * Safe defaults:
 * - PREVIEW_ONLY: sends nothing UNLESS you explicitly arm a one-shot test.
 * - LIVE: requires BOTH welcome switches, the activation cutoff, the
 *   approved Welcome campaign/template and the production email checks.
 * - Existing addresses, invalid addresses, prior claims, and opted-out
 *   households do not get another welcome. No automatic retries of uncertain
 *   delivery attempts. Queues are claimed BEFORE calling MailApp.
 */
const SQSP_WELCOME = Object.freeze({
  TEST_PROPERTY:'SQSP_WELCOME_TEST_V1',
  TEST_CAMPAIGN:'TEST-SQSP-WELCOME-IMMEDIATE',
  CAMPAIGN:'WELCOME-EMAIL',
  TEST_NAME:'CRM Welcome Test',
  TEST_LIFETIME_MS:30*60*1000
});

/** Read-only diagnostics. Safe with all email sending disabled. */
function validateSquarespaceWelcomeBridge() {
  const ss=SpreadsheetApp.openById(SQSP_HOOK.CRM_ID);
  const leadSheet=ss.getSheetByName('Master Leads');
  sqspCols_(leadSheet);
  emailAutoAssertMaster_(ss);
  emailAutoSheet_(ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
  emailAutoSheet_(ss,EMAIL_AUTO.LOG_TAB,EMAIL_AUTO.LOG_HEADERS);
  const campaign=campaignRead_(ss,'Campaigns',campaignHeaders_())
    .find(c=>c['Campaign ID']===SQSP_WELCOME.CAMPAIGN);
  const template=campaignRead_(ss,'Templates',templateHeaders_())
    .find(t=>t['Template ID']==='TPL-WELCOME');
  if(!campaign || campaign['Trigger']!=='New Lead' ||
      !['Email','Both'].includes(campaign['Channel']) || campaign['Template ID']!=='TPL-WELCOME')
    throw new Error('Welcome campaign not configured for New Lead / Email / TPL-WELCOME.');
  if(!template || template['Status']!=='Approved' ||
      !template['Email Subject EN'] || !template['Email Subject ES'] ||
      !template['Email Body EN'] || !template['Email Body ES'])
    throw new Error('Welcome template must be Approved with English and Spanish content.');
  const result={
    webhook:getSetting_('SQUARESPACE_WEBHOOK_ENABLED'),
    engineMode:getSetting_('CAMPAIGN_ENGINE_MODE'),
    welcomeEnabled:getSetting_('WELCOME_EMAIL_ENABLED'),
    squarespaceWelcome:getSetting_('SQUARESPACE_WELCOME_ON_IMPORT'),
    welcomeCampaignEnabled:campaign['Enabled'],
    welcomeTemplate:template['Status'],
    activationDate:getSetting_('WELCOME_START_AT')||'(not set)',
    testInboxConfigured:campaignValidEmail_(getSetting_('EMAIL_TEST_RECIPIENT')),
    sentByValidation:0
  };
  console.log('SQUARESPACE WELCOME CHECK: '+JSON.stringify(result));
  return result;
}

/**
 * Arms a one-time test using a NEW Squarespace form submission:
 * Name exactly "CRM Welcome Test" and a UNIQUE email address. The email
 * sends ONLY to the designated test inbox in Settings!B12, never to the
 * new lead's email address. Keep global live sending switches OFF.
 */
function armSquarespaceWelcomeTest() {
  const info=validateSquarespaceWelcomeBridge();
  if(info.engineMode!=='PREVIEW_ONLY' ||
    emailAutoTrue_(info.welcomeEnabled) ||
    emailAutoTrue_(getSetting_('CAMPAIGN_EMAILS_ENABLED')))
    throw new Error('One-time test requires PREVIEW_ONLY and live email switches FALSE.');
  const inbox=String(getSetting_('EMAIL_TEST_RECIPIENT')||'').trim().toLowerCase();
  if(!campaignValidEmail_(inbox))throw new Error('Set one valid EMAIL_TEST_RECIPIENT.');
  const lock=LockService.getScriptLock();lock.waitLock(20000);
  try {
    const prop=PropertiesService.getScriptProperties();
    const raw=prop.getProperty(SQSP_WELCOME.TEST_PROPERTY);
    if(raw && ['ARMED','CLAIMED'].includes(JSON.parse(raw).status))
      throw new Error('A Squarespace welcome test is already armed or claimed.');
    const state={status:'ARMED',recipient:inbox,id:Utilities.getUuid(),
      armedAt:Date.now()};
    prop.setProperty(SQSP_WELCOME.TEST_PROPERTY,JSON.stringify(state));
    console.log('SQUARESPACE WELCOME TEST ARMED: submit a NEW Squarespace form with Parent Name exactly "CRM Welcome Test" and a unique test email. Only Settings!EMAIL_TEST_RECIPIENT receives an email. Expires in 30 minutes.');
    return {status:'ARMED',expiresMinutes:30};
  }finally{lock.releaseLock();}
}

function checkSquarespaceWelcomeTest(){
  const raw=PropertiesService.getScriptProperties().getProperty(SQSP_WELCOME.TEST_PROPERTY);
  const s=raw?JSON.parse(raw):{status:'NOT_ARMED'};
  const out={status:s.status,reason:s.reason||'',sentAt:s.sentAt||'',
    sentToTestInbox:s.status==='SENT'};
  console.log(JSON.stringify(out));return out;
}
function cancelSquarespaceWelcomeTest(){
  const prop=PropertiesService.getScriptProperties();
  const raw=prop.getProperty(SQSP_WELCOME.TEST_PROPERTY);
  if(raw){const s=JSON.parse(raw);if(s.status==='ARMED'){
    s.status='CANCELLED';prop.setProperty(SQSP_WELCOME.TEST_PROPERTY,JSON.stringify(s));}}
  console.log('Squarespace welcome test cancelled if still armed.');
}

function sqspWelcomeAfterWebhook_(result,verifiedEmail) {
  if(!result || result.action!=='created'||!result.row)return {status:'NOT_NEW'};
  const mode=String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim();
  if(mode==='PREVIEW_ONLY') return sqspWelcomeTestAfterWebhook_(result,verifiedEmail);
  if(mode!=='LIVE' || !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')) ||
      !emailAutoTrue_(getSetting_('SQUARESPACE_WELCOME_ON_IMPORT')))
    return {status:'NOT_ENABLED'};
  return sqspWelcomeProductionAfterWebhook_(result,verifiedEmail);
}

/** Fetch the exact row inserted under the authenticated Squarespace request. */
function sqspWelcomeVerifiedLead_(ss,result,verifiedEmail){
  const sh=ss.getSheetByName('Master Leads'),c=sqspCols_(sh);
  if(!Number.isInteger(result.row)||result.row<2||result.row>sh.getLastRow())
    return null;
  const vals=sh.getRange(result.row,1,1,sh.getLastColumn()).getDisplayValues()[0];
  if(String(vals[c.Source-1]).trim()!=='Squarespace' ||
    String(vals[c.Email-1]).trim().toLowerCase()!==verifiedEmail ||
    !/^SQSP-[0-9a-f]{24}$/.test(String(vals[c['Source Record ID']-1]))) return null;
  return emailAutoMasterLeads_(ss).find(l=>String(l['Lead ID'])===String(vals[c['Lead ID']-1]))||null;
}

/** The only PREVIEW_ONLY mail capability is a fresh, manually armed test. */
function sqspWelcomeTestAfterWebhook_(result,email){
  const prop=PropertiesService.getScriptProperties();
  const raw=prop.getProperty(SQSP_WELCOME.TEST_PROPERTY);
  if(!raw)return {status:'NOT_ARMED'};
  const lock=LockService.getScriptLock();lock.waitLock(20000);
  try{
    const fresh=prop.getProperty(SQSP_WELCOME.TEST_PROPERTY);
    if(!fresh)return {status:'NOT_ARMED'};
    const state=JSON.parse(fresh);
    if(state.status!=='ARMED')return {status:state.status};
    if(Date.now()-state.armedAt>SQSP_WELCOME.TEST_LIFETIME_MS){
      state.status='EXPIRED';prop.setProperty(SQSP_WELCOME.TEST_PROPERTY,JSON.stringify(state));
      return {status:'EXPIRED'};
    }
    const ss=SpreadsheetApp.openById(SQSP_HOOK.CRM_ID);
    const lead=sqspWelcomeVerifiedLead_(ss,result,email);
    if(!lead || String(lead['Parent Name']).trim()!==SQSP_WELCOME.TEST_NAME)
      return {status:'NOT_TEST_LEAD'};
    if(String(getSetting_('EMAIL_TEST_RECIPIENT')||'').trim().toLowerCase()!==state.recipient)
      return {status:'TEST_INBOX_CHANGED'};
    const prior=emailAutoQueueRows_(ss.getSheetByName(EMAIL_AUTO.QUEUE_TAB));
    if(prior.some(r=>r['Campaign ID']===SQSP_WELCOME.TEST_CAMPAIGN&&r['Lead ID']===lead['Lead ID']))
      return {status:'ALREADY_TESTED'};
    const camp=campaignRead_(ss,'Campaigns',campaignHeaders_())
      .find(c=>c['Campaign ID']===SQSP_WELCOME.CAMPAIGN);
    const tmpl=campaignRead_(ss,'Templates',templateHeaders_())
      .find(t=>t['Template ID']==='TPL-WELCOME');
    const context=emailAutoCampaignContext_(camp,[tmpl],[]);
    if(!context.ok)throw new Error(context.issues.join('; '));
    const lang=campaignLanguage_(lead['Preferred Language']);
    const msg=emailAutoRender_(camp,tmpl,null,lead,lang);
    if(msg.issues.length || !msg.subject||!msg.body)throw new Error('Missing welcome content');
    if(MailApp.getRemainingDailyQuota()<1)return {status:'NO_MAIL_QUOTA'};
    const key='SQSP-WELCOME-TEST-'+state.id,stamp=emailAutoNow_();
    emailAutoAppendQueueRows_(ss,[[key,SQSP_WELCOME.TEST_CAMPAIGN,'Squarespace Welcome Test',
      lead['Lead ID'],state.recipient,lang,msg.subject,msg.body,'PENDING',stamp,'','','','',stamp]]);
    const queue=ss.getSheetByName(EMAIL_AUTO.QUEUE_TAB),qr=queue.getLastRow();
    emailAutoUpdateQueue_(queue,qr,{status:'SENDING',claimed:emailAutoNow_()});
    state.status='CLAIMED';prop.setProperty(SQSP_WELCOME.TEST_PROPERTY,JSON.stringify(state));
    SpreadsheetApp.flush();
    let error='';
    try {MailApp.sendEmail({to:state.recipient,subject:msg.subject,body:msg.body,
        name:emailAutoSenderName_()});}
    catch(e){error=String(e&&e.message||e).slice(0,400);}
    const at=emailAutoNow_();
    emailAutoUpdateQueue_(queue,qr,{status:error?'FAILED':'SENT',attempted:at,error});
    emailAutoAppendLog_(ss,[Utilities.getUuid(),lead['Lead ID'],
      SQSP_WELCOME.TEST_CAMPAIGN,'Squarespace Welcome Test','Email',state.recipient,
      at,error?'SQSP WELCOME TEST FAILED':'SQSP WELCOME TEST SENT',error,'',key]);
    state.status=error?'FAILED':'SENT';state.sentAt=error?'':at;
    prop.setProperty(SQSP_WELCOME.TEST_PROPERTY,JSON.stringify(state));
    console.log('Squarespace instant welcome test '+state.status+'; recipient=test inbox only');
    return {status:state.status==='SENT'?'TEST_SENT':state.status};
  }finally{lock.releaseLock();}
}

/** LIVE send — duplicates, historical leads, opt-outs and uncertain sends skip. */
function sqspWelcomeProductionAfterWebhook_(result,email) {
  emailAutoAssertLiveSettings_();
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(20000))return {status:'LOCK_BUSY'};
  try{
    if(String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim()!=='LIVE' ||
      !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')) ||
      !emailAutoTrue_(getSetting_('SQUARESPACE_WELCOME_ON_IMPORT')))
      return {status:'NOT_ENABLED'};
    const ss=SpreadsheetApp.openById(SQSP_HOOK.CRM_ID);
    const lead=sqspWelcomeVerifiedLead_(ss,result,email);
    if(!lead || !campaignValidEmail_(email) ||
      String(lead['Active Lead']).trim().toLowerCase()!=='yes')
      return {status:'INVALID_LEAD'};
    const start=emailAutoLocalToEpoch_(emailAutoNormalizeTimestamp_(getSetting_('WELCOME_START_AT')));
    const created=emailAutoLocalToEpoch_(emailAutoNormalizeTimestamp_(lead['Created At']));
    const now=emailAutoLocalToEpoch_(emailAutoNow_());
    if(!Number.isFinite(start)||!Number.isFinite(created)||
      created<start||created>now+120000||now-created>30*60000)
      return {status:'HISTORICAL_OR_STALE'};
    const leads=emailAutoMasterLeads_(ss);
    if(leads.some(l=>String(l['Email']).trim().toLowerCase()===email &&
        emailAutoTrue_(l['Email Opt Out'])))return {status:'OPTED_OUT'};
    if(emailAutoHouseholdWelcomed_(leads,email))return {status:'ALREADY_WELCOMED'};
    if(leads.some(l=>l['Lead ID']!==lead['Lead ID'] &&
        String(l['Email']).trim().toLowerCase()===email &&
        String(l['Active Lead']).trim().toLowerCase()==='yes'))
      return {status:'EXISTING_EMAIL'};
    const queue=emailAutoSheet_(ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
    const prev=emailAutoQueueRows_(queue);
    if(prev.some(q=>q['Campaign ID']===SQSP_WELCOME.CAMPAIGN &&
       (q['Lead ID']===lead['Lead ID']||String(q['Recipient']).trim().toLowerCase()===email)))
      return {status:'ALREADY_QUEUED'};
    const campaign=campaignRead_(ss,'Campaigns',campaignHeaders_())
      .find(c=>c['Campaign ID']===SQSP_WELCOME.CAMPAIGN);
    if(!campaign||campaign['Trigger']!=='New Lead'||!['Email','Both'].includes(campaign['Channel'])||
        campaign['Enabled']!=='Yes'||campaign['Status']!=='Ready'||
        campaign['Audience']!=='All Active Leads')return {status:'CAMPAIGN_NOT_READY'};
    const templates=campaignRead_(ss,'Templates',templateHeaders_());
    const events=campaignRead_(ss,'Events',eventHeaders_());
    const ctx=emailAutoCampaignContext_(campaign,templates,events);
    if(!ctx.ok)throw new Error('Invalid Welcome configuration: '+ctx.issues.join('; '));
    const language=campaignLanguage_(lead['Preferred Language']);
    const message=emailAutoRender_(campaign,ctx.template,ctx.event,lead,language);
    if(message.issues.length ||!message.subject ||!message.body)
      throw new Error('Unresolved welcome fields');
    if(MailApp.getRemainingDailyQuota()<1)return {status:'NO_MAIL_QUOTA'};
    emailAutoAssertLiveSettings_();
    if(String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim()!=='LIVE' ||
       !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')) ||
       !emailAutoTrue_(getSetting_('SQUARESPACE_WELCOME_ON_IMPORT')))
      return {status:'NOT_ENABLED'};
    const values=emailAutoQueuedRow_(campaign,lead,email,language,message);
    emailAutoAppendQueueRows_(ss,[values]);
    const qr=queue.getLastRow();
    emailAutoUpdateQueue_(queue,qr,{status:'SENDING',claimed:emailAutoNow_()});
    SpreadsheetApp.flush(); // no automatic retry if MailApp outcome uncertain
    let err='';
    try{
      const opts={to:email,subject:values[6],body:values[7],name:emailAutoSenderName_()};
      const replyTo=String(getSetting_('EMAIL_REPLY_TO')||'').trim();
      if(replyTo)opts.replyTo=replyTo;
      MailApp.sendEmail(opts);
    }catch(e){err=String(e&&e.message||e).slice(0,400);}
    const at=emailAutoNow_();
    emailAutoUpdateQueue_(queue,qr,{status:err?'FAILED':'SENT',attempted:at,error:err});
    emailAutoAppendLog_(ss,[Utilities.getUuid(),lead['Lead ID'],
      SQSP_WELCOME.CAMPAIGN,campaign['Campaign Name'],'Email',email,
      at,err?'FAILED':'SENT',err,'',values[0]]);
    if(!err){emailAutoUpdateLeadAfterSend_(ss,lead,SQSP_WELCOME.CAMPAIGN);
      emailAutoRefreshCampaignSummary_(ss);SpreadsheetApp.flush();}
    return {status:err?'FAILED':'SENT'};
  }finally{lock.releaseLock();}
}
