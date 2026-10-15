const INSTANT_WELCOME = Object.freeze({
  PROP: 'EDNOVATE_WELCOME_IMMEDIATE_V2',
  CAMPAIGN_ID: 'WELCOME-EMAIL',
  TEST_CAMPAIGN_ID: 'TEST-WELCOME-IMMEDIATE',
  OLD_HANDLER: 'welcomeFormIntakeTestTick',
  MAX_ARMED_HOURS: 24
});

function welcomeImmediateChecks_() {
  if (String(getSetting_('CAMPAIGN_ENGINE_MODE')).trim() !== 'PREVIEW_ONLY' ||
      emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')) ||
      emailAutoTrue_(getSetting_('CAMPAIGN_EMAILS_ENABLED'))) {
    throw new Error('Immediate welcome TEST requires PREVIEW_ONLY and both live switches FALSE.');
  }
  const inbox = String(getSetting_('EMAIL_TEST_RECIPIENT') || '').trim().toLowerCase();
  if (!campaignValidEmail_(inbox) || /[,;]/.test(inbox)) {
    throw new Error('Settings!EMAIL_TEST_RECIPIENT must contain one valid test inbox.');
  }
  const ss = campaignSpreadsheet_();
  const campaigns = campaignRead_(ss, 'Campaigns', campaignHeaders_());
  const campaign = campaigns.find(c => c['Campaign ID'] === INSTANT_WELCOME.CAMPAIGN_ID);
  if (!campaign || campaign['Trigger'] !== 'New Lead' || !['Email','Both'].includes(campaign['Channel']) ||
      campaign['Enabled'] !== 'No' || campaign['Status'] !== 'Ready' ||
      campaign['Message Mode'] !== 'Template' || campaign['Template ID'] !== 'TPL-WELCOME') {
    throw new Error('Welcome campaign must remain New Lead / Email / No / Ready / Template / TPL-WELCOME.');
  }
  const templates = campaignRead_(ss, 'Templates', templateHeaders_());
  const template = templates.find(t => t['Template ID'] === 'TPL-WELCOME');
  if (!template || template['Status'] !== 'Approved' ||
      !template['Email Subject EN'] || !template['Email Body EN'] ||
      !template['Email Subject ES'] || !template['Email Body ES']) {
    throw new Error('TPL-WELCOME must be Approved and contain English and Spanish subjects/bodies.');
  }
  emailAutoSheet_(ss, EMAIL_AUTO.QUEUE_TAB, EMAIL_AUTO.QUEUE_HEADERS);
  emailAutoSheet_(ss, EMAIL_AUTO.LOG_TAB, EMAIL_AUTO.LOG_HEADERS);
  emailAutoAssertMaster_(ss);
  return {ss, inbox, campaign, template};
}

function armWelcomeFormIntakeTest() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ctx = welcomeImmediateChecks_();
    const props = PropertiesService.getScriptProperties();
    const current = props.getProperty(INSTANT_WELCOME.PROP);
    if (current) {
      const state = JSON.parse(current);
      if (state.status === 'ARMED' || state.status === 'CLAIMED') {
        throw new Error('An immediate welcome test is already ' + state.status + '.');
      }
    }
    // If a legacy 5-minute watcher trigger was installed, turn it off.
    ScriptApp.getProjectTriggers().filter(t =>
      t.getHandlerFunction() === INSTANT_WELCOME.OLD_HANDLER)
      .forEach(t => ScriptApp.deleteTrigger(t));

    const oldLeads = emailAutoMasterLeads_(ctx.ss);
    const state = {
      id: Utilities.getUuid(), status: 'ARMED',
      recipient: ctx.inbox,
      armedAt: emailAutoNow_(),
      previousIds: oldLeads.map(l => l['Lead ID']).filter(Boolean)
    };
    props.setProperty(INSTANT_WELCOME.PROP, JSON.stringify(state));
    console.log('Immediate welcome test ARMED. A NEW Google Form submission to the test inbox will send from the existing form-submit trigger. No watcher delay.');
    return {status:'ARMED',trigger:'existing handleOriginalFormSubmit',destination:'TEST INBOX ONLY'};
  } finally { lock.releaseLock(); }
}

function welcomeImmediateTestAfterFormSubmit_(outcome, response) {
  if (String(getSetting_('CAMPAIGN_ENGINE_MODE') || '') !== 'PREVIEW_ONLY') {
    return {status: 'TEST_DISABLED_MODE'};
  }
  if (!outcome || outcome.action !== 'created' || !outcome.leadId) return {status:'NOT_NEW'};
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(INSTANT_WELCOME.PROP);
  if (!raw) return {status:'NOT_ARMED'};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire immediate welcome test lock; no email sent.');
  try {
    const fresh = props.getProperty(INSTANT_WELCOME.PROP);
    if (!fresh) return {status:'NOT_ARMED'};
    const state = JSON.parse(fresh);
    if (state.status !== 'ARMED') return {status:state.status};
    const ctx = welcomeImmediateChecks_();
    if (ctx.inbox !== state.recipient) throw new Error('The designated test inbox changed; no send.');
    const incoming = String((response || [])[2] || '').trim().toLowerCase();
    if (incoming !== state.recipient) return {status:'DIFFERENT_EMAIL'};
    if (state.previousIds.indexOf(outcome.leadId) !== -1) return {status:'EXISTING_LEAD'};
    const nowMs = emailAutoLocalToEpoch_(emailAutoNow_());
    const armedMs = emailAutoLocalToEpoch_(state.armedAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(armedMs) ||
        nowMs < armedMs || nowMs-armedMs > INSTANT_WELCOME.MAX_ARMED_HOURS*3600000) {
      throw new Error('Immediate welcome test has expired; no email sent.');
    }
    const leads = emailAutoMasterLeads_(ctx.ss);
    const lead = leads.find(l => l['Lead ID'] === outcome.leadId);
    if (!lead || lead['Source'] !== 'Google Form' ||
        String(lead['Source Record ID']) !== formFingerprint_(response) ||
        String(lead['Email']).trim().toLowerCase() !== state.recipient ||
        String(lead['Active Lead']).trim().toLowerCase() !== 'yes' ||
        emailAutoTrue_(lead['Email Opt Out'])) {
      throw new Error('New lead could not be verified as the exact new test submission.');
    }
    const prior = emailAutoQueueRows_(ctx.ss.getSheetByName(EMAIL_AUTO.QUEUE_TAB));
    if (prior.some(q => q['Campaign ID'] === INSTANT_WELCOME.TEST_CAMPAIGN_ID &&
                        q['Lead ID'] === lead['Lead ID'])) {
      throw new Error('This lead already has an immediate welcome test attempt.');
    }
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Insufficient email quota.');
    const language = campaignLanguage_(lead['Preferred Language']);
    const rendered = emailAutoRender_(ctx.campaign, ctx.template, null, lead, language);
    if (rendered.issues.length || !rendered.subject || !rendered.body) {
      throw new Error('Cannot render welcome message: ' + rendered.issues.join('; '));
    }
    const stamp = emailAutoNow_();
    const key = 'IMMEDIATE-WELCOME-TEST-' + state.id;
    const subject = rendered.subject;
    const body = rendered.body;
    emailAutoAppendQueueRows_(ctx.ss, [[key, INSTANT_WELCOME.TEST_CAMPAIGN_ID,
      'Immediate Welcome — TEST ONLY',lead['Lead ID'],state.recipient,language,
      subject,body,'PENDING',stamp,'','','','',stamp]]);
    const queue = emailAutoSheet_(ctx.ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
    const row = queue.getLastRow();
    emailAutoUpdateQueue_(queue,row,{status:'SENDING',claimed:emailAutoNow_()});
    state.status = 'CLAIMED'; state.leadId = lead['Lead ID'];
    props.setProperty(INSTANT_WELCOME.PROP,JSON.stringify(state));
    SpreadsheetApp.flush(); // Durable claim BEFORE MailApp; never retry automatically.
    let problem = '';
    try {
      MailApp.sendEmail({to:state.recipient,subject,body,name:emailAutoSenderName_()});
    } catch (err) {
      problem = String(err && err.message || err).slice(0,400);
    }
    const attemptedAt = emailAutoNow_();
    if (problem) {
      emailAutoUpdateQueue_(queue,row,{status:'FAILED',attempted:attemptedAt,error:problem});
      emailAutoAppendLog_(ctx.ss,[Utilities.getUuid(),lead['Lead ID'],
        INSTANT_WELCOME.TEST_CAMPAIGN_ID,'Immediate Welcome — TEST ONLY',
        'Email',state.recipient,attemptedAt,'IMMEDIATE WELCOME TEST FAILED',problem,'',key]);
      state.status = 'FAILED';state.error=problem;
    } else {
      emailAutoUpdateQueue_(queue,row,{status:'SENT',attempted:attemptedAt,error:''});
      emailAutoAppendLog_(ctx.ss,[Utilities.getUuid(),lead['Lead ID'],
        INSTANT_WELCOME.TEST_CAMPAIGN_ID,'Immediate Welcome — TEST ONLY',
        'Email',state.recipient,attemptedAt,'IMMEDIATE WELCOME TEST SENT','','',key]);
      state.status = 'SENT';state.sentAt=attemptedAt;state.language=language;
    }
    props.setProperty(INSTANT_WELCOME.PROP,JSON.stringify(state));
    SpreadsheetApp.flush();
    console.log('Immediate welcome test: '+state.status);
    return {status:state.status,sentAt:state.sentAt||''};
  } finally { lock.releaseLock(); }
}

function checkWelcomeFormIntakeTest() {
  const raw=PropertiesService.getScriptProperties().getProperty(INSTANT_WELCOME.PROP);
  const state=raw?JSON.parse(raw):{status:'NOT_ARMED'};
  const output={status:state.status,armedAt:state.armedAt||'',sentAt:state.sentAt||'',
    error:state.error||'',language:state.language||'',
    submissionTrigger:'handleOriginalFormSubmit'};
  console.log(JSON.stringify(output));
  return output;
}

function cancelWelcomeFormIntakeTest() {
  const lock=LockService.getScriptLock();lock.waitLock(15000);
  try {
    const props=PropertiesService.getScriptProperties();
    const raw=props.getProperty(INSTANT_WELCOME.PROP);
    if (raw) {
      const state=JSON.parse(raw);
      if (state.status==='ARMED') {
        state.status='CANCELLED';
        props.setProperty(INSTANT_WELCOME.PROP,JSON.stringify(state));
      }
    }
    ScriptApp.getProjectTriggers().filter(t =>
      t.getHandlerFunction()===INSTANT_WELCOME.OLD_HANDLER)
      .forEach(t=>ScriptApp.deleteTrigger(t));
    return {status:'CANCELLED',existingFormSubmitTriggerUnchanged:true};
  } finally {lock.releaseLock();}
}


function welcomeImmediateAfterFormSubmit_(outcome, response) {
  if (!outcome || outcome.action !== 'created' || !outcome.leadId) {
    return {status:'NOT_NEW'};
  }
  const mode=String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim();
  if (mode==='PREVIEW_ONLY') {
    return welcomeImmediateTestAfterFormSubmit_(outcome,response);
  }
  if (mode!=='LIVE') return {status:'DISABLED_MODE'};
  return welcomeProductionAfterFormSubmit_(outcome,response);
}

function welcomeProductionAfterFormSubmit_(outcome,response) {
  if (String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim() !== 'LIVE' ||
      !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED'))) {
    return {status:'WELCOME_DISABLED'};
  }

  emailAutoAssertLiveSettings_();

  const lock=LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Welcome lock unavailable; no email sent.');
  try {
    // Recheck all switch states AFTER obtaining lock.
    if (String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim()!=='LIVE' ||
        !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED'))) {
      return {status:'WELCOME_DISABLED'};
    }
    const armed=String(getSetting_('WELCOME_START_AT')||'').trim();
    const startMs=emailAutoLocalToEpoch_(emailAutoNormalizeTimestamp_(armed));
    if (!Number.isFinite(startMs)) return {status:'NOT_ARMED'};

    const ss=campaignSpreadsheet_();
    const campaigns=campaignRead_(ss,'Campaigns',campaignHeaders_());
    const campaign=campaigns.find(c=>c['Campaign ID']==='WELCOME-EMAIL');
    if (!campaign || campaign['Trigger']!=='New Lead' ||
        !['Email','Both'].includes(campaign['Channel']) || campaign['Enabled']!=='Yes' ||
        campaign['Status']!=='Ready' || campaign['Audience']!=='All Active Leads') {
      return {status:'WELCOME_CAMPAIGN_DISABLED'};
    }
    const templates=campaignRead_(ss,'Templates',templateHeaders_());
    const events=campaignRead_(ss,'Events',eventHeaders_());
    const ctx=emailAutoCampaignContext_(campaign,templates,events);
    if (!ctx.ok) throw new Error('Welcome configuration: '+ctx.issues.join('; '));

    const leads=emailAutoMasterLeads_(ss);
    const lead=leads.find(l=>l['Lead ID']===outcome.leadId);
    const email=String((response||[])[2]||'').trim().toLowerCase();
    if (!lead || lead['Source']!=='Google Form' ||
        String(lead['Source Record ID'])!==formFingerprint_(response) ||
        String(lead['Email']).trim().toLowerCase()!==email ||
        !campaignValidEmail_(email) ||
        String(lead['Active Lead']).trim().toLowerCase()!=='yes') {
      return {status:'INVALID_OR_UNVERIFIED_LEAD'};
    }
    const createdMs=emailAutoLocalToEpoch_(
      emailAutoNormalizeTimestamp_(lead['Created At']));
    const nowMs=emailAutoLocalToEpoch_(emailAutoNow_());
    // Existing/historical leads and stale replays do not receive welcomes.
    // The scheduled runner can still handle an unusually delayed trigger.
    if (!Number.isFinite(createdMs) || createdMs<startMs ||
        createdMs>nowMs+120000 || nowMs-createdMs>30*60000) {
      return {status:'BEFORE_START_OR_STALE'};
    }

    if (leads.some(l=>String(l['Email']).trim().toLowerCase()===email &&
        emailAutoTrue_(l['Email Opt Out']))) return {status:'OPTED_OUT'};
    if (leads.some(l=>String(l['Email']).trim().toLowerCase()===email &&
        emailAutoTrue_(l['Welcome Email Sent']))) return {status:'ALREADY_WELCOMED'};
    if (leads.some(l=>l['Lead ID']!==lead['Lead ID'] &&
        String(l['Email']).trim().toLowerCase()===email &&
        String(l['Active Lead']).trim().toLowerCase()==='yes')) {
      return {status:'EXISTING_EMAIL_HOUSEHOLD'};
    }

    const queue=emailAutoSheet_(ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
    const log=emailAutoSheet_(ss,EMAIL_AUTO.LOG_TAB,EMAIL_AUTO.LOG_HEADERS);
    const prev=emailAutoQueueRows_(queue);
    if (prev.some(q=>q['Campaign ID']==='WELCOME-EMAIL' &&
        (q['Lead ID']===lead['Lead ID'] ||
         String(q['Recipient']).trim().toLowerCase()===email))) {
      return {status:'ALREADY_QUEUED'};
    }
    const lang=campaignLanguage_(lead['Preferred Language']);
    const rendered=emailAutoRender_(campaign,ctx.template,ctx.event,lead,lang);
    if (rendered.issues.length || !rendered.subject || !rendered.body) {
      throw new Error('Welcome template cannot render: '+rendered.issues.join('; '));
    }
    if (MailApp.getRemainingDailyQuota()<1) return {status:'NO_MAIL_QUOTA'};

    emailAutoAssertLiveSettings_();
    if (String(getSetting_('CAMPAIGN_ENGINE_MODE')||'').trim()!=='LIVE' ||
        !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED'))) {
      return {status:'WELCOME_DISABLED'};
    }
    const rowValues=emailAutoQueuedRow_(campaign,lead,email,lang,rendered);
    emailAutoAppendQueueRows_(ss,[rowValues]);
    const queueRow=queue.getLastRow();
    emailAutoUpdateQueue_(queue,queueRow,{status:'SENDING',claimed:emailAutoNow_()});
    SpreadsheetApp.flush(); // Claim before attempting mail. Never retry uncertain sends.

    const attempt=emailAutoNow_();
    let error='';
    try {
      const options={to:email,subject:rowValues[6],body:rowValues[7],
        name:emailAutoSenderName_()};
      const replyTo=String(getSetting_('EMAIL_REPLY_TO')||'').trim();
      if (replyTo) options.replyTo=replyTo;
      MailApp.sendEmail(options);
    } catch(e) {
      error=String(e&&e.message||e).slice(0,400);
    }
    const key=rowValues[0];
    if (error) {
      emailAutoUpdateQueue_(queue,queueRow,
        {status:'FAILED',attempted:attempt,error});
      emailAutoAppendLog_(ss,[Utilities.getUuid(),lead['Lead ID'],
        'WELCOME-EMAIL',campaign['Campaign Name'],'Email',email,
        attempt,'FAILED',error,'',key]);
      emailAutoRefreshCampaignSummary_(ss);
      return {status:'FAILED',error};
    }

    emailAutoUpdateQueue_(queue,queueRow,
      {status:'SENT',attempted:attempt,error:''});
    emailAutoAppendLog_(ss,[Utilities.getUuid(),lead['Lead ID'],
      'WELCOME-EMAIL',campaign['Campaign Name'],'Email',email,
      attempt,'SENT','','',key]);
    emailAutoUpdateLeadAfterSend_(ss,lead,'WELCOME-EMAIL');
    emailAutoRefreshCampaignSummary_(ss);
    SpreadsheetApp.flush();
    return {status:'SENT',leadId:lead['Lead ID']};
  } finally {
    lock.releaseLock();
  }
}

function validateImmediateWelcomeSetup() {
  if (typeof INSTANT_WELCOME === 'undefined' || !INSTANT_WELCOME.PROP) {
    throw new Error('INSTANT_WELCOME configuration is missing from this file.');
  }
  if (typeof welcomeImmediateAfterFormSubmit_ !== 'function' ||
      typeof emailAutoMasterLeads_ !== 'function') {
    throw new Error('Welcome or EmailAutomation function unavailable.');
  }
  const ss=campaignSpreadsheet_();
  emailAutoAssertMaster_(ss);
  emailAutoSheet_(ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
  emailAutoSheet_(ss,EMAIL_AUTO.LOG_TAB,EMAIL_AUTO.LOG_HEADERS);
  const c=campaignRead_(ss,'Campaigns',campaignHeaders_())
    .find(x=>x['Campaign ID']==='WELCOME-EMAIL');
  const t=campaignRead_(ss,'Templates',templateHeaders_())
    .find(x=>x['Template ID']==='TPL-WELCOME');
  if (!c || c['Trigger']!=='New Lead' || c['Template ID']!=='TPL-WELCOME')
    throw new Error('Welcome campaign is missing or misconfigured.');
  if (!t || !t['Email Subject EN'] || !t['Email Body EN'] ||
      !t['Email Subject ES'] || !t['Email Body ES'])
    throw new Error('English and Spanish welcome emails must have subject/body.');
  const result={campaignStatus:c['Status'],campaignEnabled:c['Enabled'],
    templateStatus:t['Status'],languageVersions:'EN, ES',
    engineMode:getSetting_('CAMPAIGN_ENGINE_MODE'),
    welcomeEnabled:getSetting_('WELCOME_EMAIL_ENABLED'),
    messagesSendInValidation:0};
  console.log(JSON.stringify(result));
  return result;
}
