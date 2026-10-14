/**
 * Ednovate Enrollment CRM — Email Automation (v3 — delivery tracking + household duplicate safety)
 * Install as an ADDITIONAL .gs file in the COPIED CRM's Apps Script project.
 * Requires the existing LeadIntake.gs (CRM, getSetting_) and CampaignEngine.gs.
 * This file does not modify the original form-response spreadsheet.
 * v3: verified queue/log-based welcome delivery timestamps and a safe tracking test.
 *
 * All sending is fail-closed by default. New installs will not send messages.
 * Modes: PREVIEW_ONLY (no live sends) and LIVE (requires all explicit guards).
 * Testing sends at most ONE email to the address in EMAIL_TEST_RECIPIENT.
 */
const EMAIL_AUTO = Object.freeze({
  QUEUE_TAB: 'Email Queue',
  MASTER_TAB: 'Master Leads',
  LOG_TAB: 'Communication Log',
  TZ: 'America/Los_Angeles',
  MAX_PER_RUN: 20,
  MAX_QUEUE_PER_CAMPAIGN: 1000,
  MAX_DELAY_MINUTES: 240,
  WELCOME_LOOKBACK_DAYS: 7,
  QUEUE_HEADERS: [
    'Delivery Key','Campaign ID','Campaign Name','Lead ID','Recipient',
    'Language','Subject','Email Body','Status','Queued At','Claimed At',
    'Attempted At','Error','Message ID','Last Updated At'
  ],
  LOG_HEADERS: [
    'Log ID','Lead ID','Campaign ID','Campaign Name','Channel',
    'Recipient','Sent At','Status','Error','Message ID','Delivery Key'
  ]
});

/** Installation validation, even in PREVIEW_ONLY mode. Does not send. */
function validateEmailAutomation() {
  const ss = campaignSpreadsheet_();
  campaignRead_(ss, 'Campaigns', campaignHeaders_());
  campaignRead_(ss, 'Templates', templateHeaders_());
  campaignRead_(ss, 'Events', eventHeaders_());
  emailAutoMasterLeads_(ss);
  const queue = emailAutoSheet_(ss, EMAIL_AUTO.QUEUE_TAB, EMAIL_AUTO.QUEUE_HEADERS);
  const log = emailAutoSheet_(ss, EMAIL_AUTO.LOG_TAB, EMAIL_AUTO.LOG_HEADERS);
  emailAutoAssertMaster_(ss);
  const mode = getSetting_('CAMPAIGN_ENGINE_MODE') || 'PREVIEW_ONLY';
  const switches = {
    mode,
    campaignsEnabled: getSetting_('CAMPAIGN_EMAILS_ENABLED'),
    welcomeEnabled: getSetting_('WELCOME_EMAIL_ENABLED'),
    testInboxConfigured: !!getSetting_('EMAIL_TEST_RECIPIENT'),
    unsubscribeURLConfigured: !!getSetting_('UNSUBSCRIBE_WEBAPP_URL'),
    postalAddressConfigured: !!getSetting_('EMAIL_POSTAL_ADDRESS'),
    contactBasisConfirmed: getSetting_('EMAIL_CONTACT_BASIS_CONFIRMED'),
    queuedRows: Math.max(0, queue.getLastRow() - 1),
    logRows: Math.max(0, log.getLastRow() - 1)
  };
  console.log('Email automation validated: ' + JSON.stringify(switches));
  return switches;
}

/**
 * Sends ONE demonstration to the designated TEST recipient only. Uses synthetic
 * family details: no real family's email or name is included in the test.
 * May run while CAMPAIGN_ENGINE_MODE=PREVIEW_ONLY. Never enrolls a lead.
 */
function sendSelectedCampaignTestEmail() {
  const ui = SpreadsheetApp.getUi();
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active || active.getId() !== CRM.ID || active.getActiveSheet().getName() !== 'Campaigns') {
    throw new Error('Select a campaign row on the Campaigns tab first.');
  }
  const row = active.getActiveRange().getRow();
  if (row < 2) throw new Error('Select a campaign row, not the header.');
  const campaignId = String(active.getActiveSheet().getRange(row, 1).getDisplayValue()).trim();
  const inbox = String(getSetting_('EMAIL_TEST_RECIPIENT') || '').trim();
  if (!campaignValidEmail_(inbox) || /[,;]/.test(inbox)) {
    throw new Error('Enter one valid test email in Settings → EMAIL_TEST_RECIPIENT first.');
  }
  const response = ui.alert('Send test email?',
    'Send ONE email to ' + inbox + ' using demo family data for campaign ' + campaignId + '?',
    ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return 'Cancelled; no email sent.';

  const ss = campaignSpreadsheet_();
  const campaign = campaignRead_(ss, 'Campaigns', campaignHeaders_())
    .find(c => c['Campaign ID'] === campaignId);
  if (!campaign) throw new Error('Campaign not found: ' + campaignId);
  if (campaign['Channel'] !== 'Email') throw new Error('Test sender supports Email channel only.');
  const templates = campaignRead_(ss, 'Templates', templateHeaders_());
  const events = campaignRead_(ss, 'Events', eventHeaders_());
  const template = campaign['Template ID'] ?
    templates.find(t => t['Template ID'] === campaign['Template ID']) : null;
  const event = campaign['Event ID'] ?
    events.find(v => v['Event ID'] === campaign['Event ID']) : null;
  const lead = {'Lead ID':'DEMO-LEAD','Parent Name':'Test Family',
    'Student Name':'Test Student','Email':inbox,'Current Grade':'8',
    'Preferred Language':'English'};
  if (campaign['Event ID'] && !event) throw new Error('Event ID not found.');
  if (campaign['Message Mode'] !== 'Custom' && !template) throw new Error('Template ID not found.');
  const lang = 'EN';
  const rendered = emailAutoRender_(campaign, template, event, lead, lang);
  if (rendered.issues.length) throw new Error('Cannot test: ' + rendered.issues.join('; '));
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Google email quota exhausted.');
  const subject = '[TEST — NOT FOR FAMILIES] ' + rendered.subject;
  MailApp.sendEmail({
    to: inbox, subject,
    body: '[TEST EMAIL — NOT AN ACTUAL INVITATION]\n\n' + rendered.body,
    name: emailAutoSenderName_()
  });
  const testId='TEST-'+Utilities.getUuid();
  emailAutoAppendLog_(ss, [testId, 'DEMO-LEAD', campaignId,
    campaign['Campaign Name'], 'Email', inbox, emailAutoNow_(), 'TEST SENT', '', '', testId]);
  console.log('Sent one TEST-only message to ' + inbox + '.');
  return 'One test email sent to ' + inbox;
}

/** Installs exactly one 10-minute scheduler, harmless until LIVE and switches enabled. */
function installEmailScheduler() {
  validateEmailAutomation();
  const existing = ScriptApp.getProjectTriggers().filter(t =>
    t.getHandlerFunction() === 'runDueEmailCampaigns');
  if (existing.length) {
    console.log('Email scheduler already installed (' + existing.length + ').');
    return;
  }
  ScriptApp.newTrigger('runDueEmailCampaigns').timeBased().everyMinutes(10).create();
  console.log('Email scheduler installed; sending guards remain enforced.');
}

/**
 * Scheduler entrypoint. No sending in PREVIEW_ONLY, and campaigns/welcome
 * each have independent enable switches. Automated retries of SENDING or
 * FAILED deliveries are deliberately forbidden: ambiguous outcomes need review.
 */
function runDueEmailCampaigns() {
  if (String(getSetting_('CAMPAIGN_ENGINE_MODE')).trim() !== 'LIVE') {
    console.log('Email run skipped: PREVIEW_ONLY / not LIVE.');
    return {sent:0,reason:'Not LIVE'};
  }
  const scheduledOn = emailAutoTrue_(getSetting_('CAMPAIGN_EMAILS_ENABLED'));
  const welcomeOn = emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED'));
  if (!scheduledOn && !welcomeOn) {
    console.log('Email run skipped: both email switches OFF.');
    return {sent:0,reason:'Email switches OFF'};
  }
  // Scheduled campaigns retain the postal-address requirement. Immediate
  // welcomes can run without one when CAMPAIGN_EMAILS_ENABLED is FALSE.
  emailAutoAssertLiveSettings_({requirePostalAddress:scheduledOn});
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return {sent:0,reason:'Another run has the lock'};
  try {
    return emailAutoRunLocked_(scheduledOn, welcomeOn);
  } finally {
    lock.releaseLock();
  }
}

function emailAutoRunLocked_(scheduledOn, welcomeOn) {
  const ss = campaignSpreadsheet_();
  const campaigns = campaignRead_(ss, 'Campaigns', campaignHeaders_());
  const templates = campaignRead_(ss, 'Templates', templateHeaders_());
  const events = campaignRead_(ss, 'Events', eventHeaders_());
  const leads = emailAutoMasterLeads_(ss);
  emailAutoAssertMaster_(ss);
  const queue = emailAutoSheet_(ss, EMAIL_AUTO.QUEUE_TAB, EMAIL_AUTO.QUEUE_HEADERS);
  emailAutoSheet_(ss, EMAIL_AUTO.LOG_TAB, EMAIL_AUTO.LOG_HEADERS);
  const allQueue = emailAutoQueueRows_(queue);
  const oldIds = new Set(allQueue.map(q => q['Campaign ID']));
  const now = emailAutoNow_();
  let queued = 0;
  const eligible = campaigns.filter(c => c['Enabled'] === 'Yes' && c['Status'] === 'Ready' &&
    c['Channel'] === 'Email');

  for (const campaign of eligible) {
    if (campaign['Trigger'] === 'Scheduled' && scheduledOn &&
        !oldIds.has(campaign['Campaign ID']) && emailAutoIsDue_(campaign, now)) {
      const newRows = emailAutoQueueScheduled_(ss, campaign, templates, events, leads);
      if (newRows > 0) {
        oldIds.add(campaign['Campaign ID']);
        queued += newRows;
      }
    }
    if (campaign['Trigger'] === 'New Lead' && welcomeOn &&
        campaign['Campaign ID'] === 'WELCOME-EMAIL') {
      queued += emailAutoQueueWelcome_(ss, campaign, templates, events, leads, now);
    }
  }

  const batch = emailAutoQueueRows_(queue).filter(q => q['Status'] === 'PENDING');
  let sent = 0, failed = 0, skipped = 0;
  let quota = MailApp.getRemainingDailyQuota();
  for (const delivery of batch) {
    if (sent + failed + skipped >= EMAIL_AUTO.MAX_PER_RUN || quota < 1) break;
    // Re-check all live guards immediately before each actual send.
    if (String(getSetting_('CAMPAIGN_ENGINE_MODE')).trim() !== 'LIVE' ||
        !emailAutoTrue_(getSetting_('EMAIL_AUDIENCE_PERMISSION_CONFIRMED'))) break;
    const liveCampaign = campaignRead_(ss, 'Campaigns', campaignHeaders_())
      .find(c => c['Campaign ID'] === delivery['Campaign ID']);
    const welcome = delivery['Campaign ID'] === 'WELCOME-EMAIL';
    if (!liveCampaign || liveCampaign['Enabled'] !== 'Yes' || liveCampaign['Status'] !== 'Ready' ||
       liveCampaign['Channel'] !== 'Email' || (welcome ?
       !emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')) :
       !emailAutoTrue_(getSetting_('CAMPAIGN_EMAILS_ENABLED')))) break;
    if (!welcome && !emailAutoIsDue_(liveCampaign,emailAutoNow_())) {
      emailAutoUpdateQueue_(queue,delivery._row,
        {status:'SKIPPED',error:'Scheduled delivery window expired (over 4 hours late)'});
      skipped++;
      continue;
    }

    const currentLeads = emailAutoMasterLeads_(ss);
    const current = currentLeads.find(l => l['Lead ID'] === delivery['Lead ID']);
    const address = String(delivery['Recipient']).trim().toLowerCase();
    const suppressed = currentLeads.some(l =>
      String(l['Email']).trim().toLowerCase() === address && emailAutoTrue_(l['Email Opt Out']));
    // Re-check household duplicate safety at SEND time too, so a pending
    // welcome cannot send after a duplicate form arrives or another CRM row
    // has been marked welcomed. Does not affect ordinary scheduled campaigns.
    const primary = welcome ? emailAutoPrimaryWelcomeLead_(currentLeads, address) : null;
    const wrongHouseholdLead = welcome && (!primary ||
      String(primary['Lead ID']) !== String(delivery['Lead ID']));
    const alreadyWelcomedHousehold = welcome && emailAutoHouseholdWelcomed_(currentLeads, address);
    // Recheck source switch on queued welcomes too, even when they were
    // queued before the switch was turned off.
    const squarespaceWelcomeBlocked = welcome && current &&
      current['Source'] === 'Squarespace' &&
      !emailAutoTrue_(getSetting_('SQUARESPACE_WELCOME_ON_IMPORT'));
    const invalid = squarespaceWelcomeBlocked || !current || String(current['Active Lead']).toLowerCase() !== 'yes' ||
      emailAutoTrue_(current['Email Opt Out']) || suppressed ||
      String(current['Email']).trim().toLowerCase() !== address ||
      !campaignValidEmail_(address) || wrongHouseholdLead || alreadyWelcomedHousehold;
    if (invalid) {
      emailAutoUpdateQueue_(queue, delivery._row, {status:'SKIPPED',
        error:'Inactive, opted out, duplicate household, already welcomed, or invalid address'});
      skipped++;
      continue;
    }

    // Claim before sending. If Apps Script stops after MailApp.sendEmail,
    // the row remains SENDING: no automatic retry, so no accidental duplicates.
    emailAutoUpdateQueue_(queue, delivery._row, {status:'SENDING',claimed:emailAutoNow_()});
    SpreadsheetApp.flush();
    let providerError='';
    try {
      MailApp.sendEmail({to:address,subject:delivery['Subject'],
        body:delivery['Email Body'],name:emailAutoSenderName_(),
        ...(getSetting_('EMAIL_REPLY_TO') ? {replyTo:getSetting_('EMAIL_REPLY_TO')} : {})});
    } catch (err) {
      providerError=String(err && err.message || err).slice(0,400);
    }
    if (providerError) {
      // Treat the provider exception as failed, and never auto retry.
      emailAutoUpdateQueue_(queue,delivery._row,
        {status:'FAILED',attempted:emailAutoNow_(),error:providerError});
      emailAutoAppendLog_(ss,[Utilities.getUuid(),delivery['Lead ID'],
        delivery['Campaign ID'],delivery['Campaign Name'],'Email',address,
        emailAutoNow_(),'FAILED',providerError,'',delivery['Delivery Key']]);
      failed++;
      if (/quota|limit|too many|daily/i.test(providerError)) break;
    } else {
      // Provider accepted the email. If subsequent sheet writes fail, leave
      // SENDING for manual reconciliation; never report it as a safe retry.
      emailAutoUpdateQueue_(queue,delivery._row,
        {status:'SENT',attempted:emailAutoNow_(),error:''});
      emailAutoAppendLog_(ss,[Utilities.getUuid(),delivery['Lead ID'],
        delivery['Campaign ID'],delivery['Campaign Name'],'Email',address,
        emailAutoNow_(),'SENT','','',delivery['Delivery Key']]);
      emailAutoUpdateLeadAfterSend_(ss,current,delivery['Campaign ID']);
      sent++; quota--;
    }
  }
  emailAutoRefreshCampaignSummary_(ss);
  console.log(JSON.stringify({queued,sent,failed,skipped}));
  return {queued,sent,failed,skipped};
}

function emailAutoQueueScheduled_(ss, campaign, templates, events, leads) {
  const context = emailAutoCampaignContext_(campaign, templates, events);
  if (!context.ok) { console.log(context.issues.join('; ')); return 0; }
  const recipients = leads.filter(l => campaignEligible_(l,campaign['Audience']));
  if (recipients.length > EMAIL_AUTO.MAX_QUEUE_PER_CAMPAIGN)
    throw new Error('Too many recipients for campaign: ' + campaign['Campaign ID']);
  const seen = new Set();
  const rows = [];
  for (const lead of recipients) {
    const address = String(lead['Email']).trim().toLowerCase();
    if (seen.has(address)) continue;  // Send only once per email/household.
    seen.add(address);
    if (!campaignValidEmail_(address) || emailAutoTrue_(lead['Email Opt Out'])) continue;
    if (leads.some(l => String(l['Email']).trim().toLowerCase() === address &&
       emailAutoTrue_(l['Email Opt Out']))) continue;
    const lang = campaignLanguage_(lead['Preferred Language']);
    const rendered = emailAutoRender_(campaign,context.template,context.event,lead,lang);
    if (rendered.issues.length) {console.log('Skipping lead ' + lead['Lead ID'] + ': ' + rendered.issues.join('; ')); continue;}
    rows.push(emailAutoQueuedRow_(campaign, lead, address, lang, rendered));
  }
  // A campaign's queue is immutable after first snapshot. If no recipients,
  // mark it Complete to avoid later new leads being silently included.
  if (!rows.length) {
    emailAutoSetCampaignStatus_(ss, campaign['Campaign ID'], 'Complete');
    return 0;
  }
  emailAutoAppendQueueRows_(ss, rows);
  return rows.length;
}

/**
 * Return the oldest active CRM lead for an email address.
 * Historical leads count: if a household was already in the CRM before welcome
 * activation, a fresh duplicate form response must NOT cause a welcome email.
 * A tie on Created At is resolved by Lead ID for deterministic selection.
 * READ ONLY. It does not send or modify the CRM.
 */
function emailAutoPrimaryWelcomeLead_(leads, email) {
  const address = String(email || '').trim().toLowerCase();
  let primary = null;
  let oldest = Infinity;
  for (const lead of leads) {
    if (String(lead['Email'] || '').trim().toLowerCase() !== address ||
        String(lead['Active Lead'] || '').trim().toLowerCase() !== 'yes') continue;
    const when = emailAutoLocalToEpoch_(
      emailAutoNormalizeTimestamp_(lead['Created At']));
    const stamp = Number.isFinite(when) ? when : Infinity;
    if (!primary || stamp < oldest ||
        (stamp === oldest && String(lead['Lead ID']) < String(primary['Lead ID']))) {
      primary = lead;
      oldest = stamp;
    }
  }
  return primary;
}

/** Has ANY CRM entry for the household already been marked welcomed? */
function emailAutoHouseholdWelcomed_(leads, email) {
  const address = String(email || '').trim().toLowerCase();
  return leads.some(lead =>
    String(lead['Email'] || '').trim().toLowerCase() === address &&
    emailAutoTrue_(lead['Welcome Email Sent']));
}

/**
 * Read-only audit. Run from Apps Script to inspect household duplicate safety.
 * Does not send, queue, update Settings, or modify any lead.
 * The detailed matching email addresses are intentionally NOT logged.
 */
function auditWelcomeDuplicateProtection() {
  const ss = campaignSpreadsheet_();
  const leads = emailAutoMasterLeads_(ss);
  const counts = new Map();
  for (const lead of leads) {
    const address = String(lead['Email'] || '').trim().toLowerCase();
    if (!address) continue;
    counts.set(address, (counts.get(address) || 0) + 1);
  }
  const householdsWithDuplicates = [...counts.values()].filter(n => n > 1).length;
  const newest = leads[leads.length - 1];
  const newestAddress = newest && String(newest['Email'] || '').trim().toLowerCase();
  const primary = newestAddress ? emailAutoPrimaryWelcomeLead_(leads, newestAddress) : null;
  const result = {
    totalLeads: leads.length,
    householdsWithDuplicates,
    newestLeadHasEarlierActiveHousehold: Boolean(
      newest && primary && String(primary['Lead ID']) !== String(newest['Lead ID'])),
    newestLeadAlreadyWelcomed: Boolean(
      newestAddress && emailAutoHouseholdWelcomed_(leads, newestAddress)),
    productionWelcomeEnabled: emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')),
    engineMode: String(getSetting_('CAMPAIGN_ENGINE_MODE') || ''),
    messagesSentByAudit: 0
  };
  console.log('WELCOME DUPLICATE AUDIT: ' + JSON.stringify(result));
  return result;
}

function emailAutoQueueWelcome_(ss, campaign, templates, events, leads, now) {
  const start = String(getSetting_('WELCOME_START_AT') || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start)) {
    console.log('Welcome not armed: WELCOME_START_AT is blank/invalid.');
    return 0;
  }
  const context = emailAutoCampaignContext_(campaign,templates,events);
  if (!context.ok) {console.log(context.issues.join('; ')); return 0;}
  const queuedWelcome = emailAutoQueueRows_(ss.getSheetByName(EMAIL_AUTO.QUEUE_TAB))
    .filter(r => r['Campaign ID'] === campaign['Campaign ID']);
  const prior = new Set(queuedWelcome.map(r => r['Lead ID']));
  const previouslyMessaged = new Set(queuedWelcome.map(r => r['Recipient'].toLowerCase()));
  const nowMs = emailAutoLocalToEpoch_(now);
  const startMs = emailAutoLocalToEpoch_(start);
  const rows=[];
  for (const lead of leads) {
    if (prior.has(lead['Lead ID']) || emailAutoTrue_(lead['Welcome Email Sent'])) continue;
    if (!campaignEligible_(lead,campaign['Audience'])) continue;
    // Squarespace is independently gated: don't let the background welcome
    // runner bypass SQUARESPACE_WELCOME_ON_IMPORT when that flag is OFF.
    if (lead['Source'] === 'Squarespace' &&
        !emailAutoTrue_(getSetting_('SQUARESPACE_WELCOME_ON_IMPORT'))) continue;
    if (!['Squarespace','Google Form'].includes(String(lead['Source']))) continue;
    const created = emailAutoNormalizeTimestamp_(lead['Created At']);
    if (!created) continue;
    const createdMs = emailAutoLocalToEpoch_(created);
    if (createdMs < startMs || createdMs > nowMs + 120000 ||
        nowMs - createdMs > EMAIL_AUTO.WELCOME_LOOKBACK_DAYS*86400000) continue;
    const email = String(lead['Email']).trim().toLowerCase();
    if (!campaignValidEmail_(email) ||
        leads.some(other => String(other['Email']).trim().toLowerCase() === email &&
        emailAutoTrue_(other['Email Opt Out']))) continue;
    // Only the oldest active household record is eligible. If that record is
    // historical (before WELCOME_START_AT), ALL new duplicate form submissions
    // with the same email are also skipped. Never backfill a household welcome.
    const householdPrimary = emailAutoPrimaryWelcomeLead_(leads, email);
    if (!householdPrimary || householdPrimary['Lead ID'] !== lead['Lead ID'] ||
        emailAutoHouseholdWelcomed_(leads, email)) continue;
    // At most one queued attempt per email address, including failed/uncertain
    // outcomes: human review is required instead of automatic retries.
    if (previouslyMessaged.has(email) || rows.some(r => r[4] === email)) continue;
    const lang = campaignLanguage_(lead['Preferred Language']);
    const rendered = emailAutoRender_(campaign,context.template,context.event,lead,lang);
    if (!rendered.issues.length) rows.push(emailAutoQueuedRow_(campaign,lead,email,lang,rendered));
  }
  if (rows.length) emailAutoAppendQueueRows_(ss,rows);
  return rows.length;
}

function emailAutoCampaignContext_(c,templates,events) {
  const issues=[];
  if (!['All Active Leads','Applied','Not Applied'].includes(c['Audience']))
    issues.push('Unsupported audience');
  if (!['Template','Custom','Template + Override'].includes(c['Message Mode']))
    issues.push('Unsupported message mode');
  if (c['Channel'] !== 'Email') issues.push('Not an email-only campaign');
  const template = c['Template ID'] ? templates.find(t => t['Template ID'] === c['Template ID']) : null;
  if (c['Message Mode'] !== 'Custom' && (!template || template['Status'] !== 'Approved'))
    issues.push('Template must exist and be Approved');
  const event = c['Event ID'] ? events.find(e => e['Event ID'] === c['Event ID']) : null;
  if (c['Event ID'] && (!event || event['Status'] !== 'Confirmed'))
    issues.push('Event must exist and be Confirmed');
  if (!c['Campaign ID']) issues.push('Missing Campaign ID');
  return {ok:!issues.length,issues,template,event};
}

function emailAutoRender_(campaign,template,event,lead,lang) {
  const message = campaignMessage_(campaign,template,'Email',lang);
  const values = campaignMergeValues_(campaign,event,lead,lang);
  const subject = campaignRender_(message.subject,values);
  const body = campaignRender_(message.body,values);
  return {subject:subject.text,body:body.text,issues:[...subject.issues,...body.issues]};
}

function emailAutoQueuedRow_(campaign,lead,address,lang,rendered) {
  const key = 'D-'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    campaign['Campaign ID']+'\u001f'+address,Utilities.Charset.UTF_8)).replace(/=+$/,'');
  const footer = emailAutoFooter_(lead['Lead ID'],address,lang,campaign['Campaign ID']);
  return [key,campaign['Campaign ID'],campaign['Campaign Name'],lead['Lead ID'],
    address,lang,rendered.subject,rendered.body+'\n\n'+footer,
    'PENDING',emailAutoNow_(),'','','','',emailAutoNow_()];
}

function emailAutoFooter_(leadId,email,lang,campaignId) {
  // Welcome emails use an email-only footer: no address setting or address
  // placeholder. Other campaigns retain their configured postal address.
  const isWelcome = campaignId === 'WELCOME-EMAIL';
  const address = isWelcome ? '' : String(getSetting_('EMAIL_POSTAL_ADDRESS') || '').trim();
  const webUrl = String(getSetting_('UNSUBSCRIBE_WEBAPP_URL') || '').trim();
  const token = emailAutoToken_(leadId,email);
  const url = webUrl + (webUrl.includes('?') ? '&' : '?') +
    'action=unsubscribe&lead='+encodeURIComponent(leadId)+'&token='+encodeURIComponent(token);
  const brand = 'Ednovate' + (address ? ' | ' + address : '');
  return lang === 'ES' ?
    brand + '\nPara dejar de recibir correos electrónicos: ' + url :
    brand + '\nUnsubscribe from email updates: ' + url;
}

function emailAutoToken_(leadId,email) {
  const secret = PropertiesService.getScriptProperties().getProperty('EDNOVATE_UNSUBSCRIBE_SECRET');
  if (!secret || secret.length < 32) throw new Error('Unsubscribe signing secret not initialized.');
  return Utilities.computeHmacSha256Signature(
    String(leadId)+'\n'+String(email).trim().toLowerCase(),secret)
    .map(b=>('0'+(b & 255).toString(16)).slice(-2)).join('');
}

/** Run once before deploying the public unsubscribe web app. */
function initializeUnsubscribeSigningSecret() {
  const prop=PropertiesService.getScriptProperties();
  if (!prop.getProperty('EDNOVATE_UNSUBSCRIBE_SECRET')) {
    prop.setProperty('EDNOVATE_UNSUBSCRIBE_SECRET',
      Utilities.getUuid()+Utilities.getUuid()+Utilities.getUuid());
  }
  console.log('Unsubscribe signing is ready. Do not share or regenerate this secret.');
}

/**
 * Unsubscribe web app. GET only displays a confirmation (no change on link
 * preview/bot GET). POST actually opts out the address, no login required.
 * Deploy: Web app → Execute as Me → access Anyone, if organization permits.
 */
function doGet(e) {
  if (!e || !e.parameter || e.parameter.action !== 'unsubscribe')
    return HtmlService.createHtmlOutput('Unsubscribe page');
  const leadId=String(e.parameter.lead||'');
  const token=String(e.parameter.token||'');
  if (!emailAutoVerifyToken_(leadId,token))
    return HtmlService.createHtmlOutput('<p>This unsubscribe link is invalid or expired.</p>');
  const action=emailAutoEscape_(String(getSetting_('UNSUBSCRIBE_WEBAPP_URL')||''));
  return HtmlService.createHtmlOutput(
    '<html><body style="font-family:Arial,sans-serif;max-width:520px;margin:40px auto">'+
    '<h2>Unsubscribe / Cancelar suscripción</h2>'+
    '<p>Stop receiving Ednovate recruitment emails from this address.</p>'+
    '<form method="POST" target="_top" action="'+action+'">'+
    '<input type="hidden" name="action" value="unsubscribe">'+
    '<input type="hidden" name="lead" value="'+emailAutoEscape_(leadId)+'">'+
    '<input type="hidden" name="token" value="'+emailAutoEscape_(token)+'">'+
    '<button type="submit">Unsubscribe / Cancelar suscripción</button></form></body></html>');
}
function doPost(e) {
  if (typeof sqspIsWebhook_ === 'function' && sqspIsWebhook_(e)) return sqspWebhookDoPost_(e);
  if (!e || !e.parameter || e.parameter.action !== 'unsubscribe')
    return HtmlService.createHtmlOutput('Invalid request.');
  const leadId=String(e.parameter.lead||'');
  const token=String(e.parameter.token||'');
  if (!emailAutoVerifyToken_(leadId,token))
    return HtmlService.createHtmlOutput('Invalid or expired unsubscribe link.');
  const lock=LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss=campaignSpreadsheet_();
    emailAutoAssertMaster_(ss);
    const master=ss.getSheetByName('Master Leads');
    const data=master.getRange(2,1,Math.max(master.getLastRow()-1,1),20).getDisplayValues();
    const match=data.find(r=>r[0]===leadId);
    if (!match) return HtmlService.createHtmlOutput('Link no longer valid.');
    const email=String(match[4]).trim().toLowerCase();
    data.forEach((r,index)=>{
      if (String(r[4]).trim().toLowerCase()===email) {
        master.getRange(index+2,19,1,2).setValues([['Yes',emailAutoNow_()]]);
      }
    });
    const queue=ss.getSheetByName(EMAIL_AUTO.QUEUE_TAB);
    emailAutoQueueRows_(queue).filter(r => r['Status']==='PENDING' &&
      r['Recipient'].toLowerCase()===email).forEach(r=>{
        emailAutoUpdateQueue_(queue,r._row,{status:'SKIPPED',error:'Recipient unsubscribed'});
      });
    SpreadsheetApp.flush();
    return HtmlService.createHtmlOutput('<p>You have been unsubscribed. / Se canceló su suscripción.</p>');
  } finally {lock.releaseLock();}
}
function emailAutoVerifyToken_(leadId, token) {
  if (!leadId || !/^[0-9a-f]{64}$/.test(token)) return false;
  const ss=campaignSpreadsheet_();
  const leads=emailAutoMasterLeads_(ss);
  const lead=leads.find(l=>l['Lead ID']===leadId);
  if (!lead) return false;
  const expected=emailAutoToken_(leadId,lead['Email']);
  let diff=0;
  for(let i=0;i<64;i++) diff|=expected.charCodeAt(i)^token.charCodeAt(i);
  return diff===0;
}
function emailAutoEscape_(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function emailAutoAssertLiveSettings_(options) {
  if (!emailAutoTrue_(getSetting_('EMAIL_AUDIENCE_PERMISSION_CONFIRMED')))
    throw new Error('Confirm permission to contact leads in EMAIL_AUDIENCE_PERMISSION_CONFIRMED.');
  // Postal address is not required for immediate welcome messages.
  // Keep the existing stricter requirement when scheduled campaigns are on.
  if (options && options.requirePostalAddress &&
      !String(getSetting_('EMAIL_POSTAL_ADDRESS') || '').trim())
    throw new Error('Set EMAIL_POSTAL_ADDRESS before enabling scheduled campaigns.');
  const url = String(getSetting_('UNSUBSCRIBE_WEBAPP_URL')).trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(url))
    throw new Error('Set a deployed HTTPS Apps Script URL in UNSUBSCRIBE_WEBAPP_URL.');
  const replyTo=String(getSetting_('EMAIL_REPLY_TO')||'').trim();
  if (replyTo && !campaignValidEmail_(replyTo))
    throw new Error('EMAIL_REPLY_TO is not a valid email address.');
  const ss = campaignSpreadsheet_();
  emailAutoAssertMaster_(ss);
  emailAutoSheet_(ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
  initializeUnsubscribeSigningSecret();
}
function emailAutoTrue_(v) {return /^(true|yes|1)$/i.test(String(v||'').trim());}
function emailAutoNow_() {return Utilities.formatDate(new Date(),EMAIL_AUTO.TZ,'yyyy-MM-dd HH:mm:ss');}
function emailAutoSenderName_() {return getSetting_('EMAIL_SENDER_NAME') || 'Ednovate Enrollment Team';}

function emailAutoSheet_(ss,name,expected) {
  const sh=ss.getSheetByName(name);
  if (!sh) throw new Error('Required sheet missing: '+name);
  const headers=sh.getRange(1,1,1,expected.length).getDisplayValues()[0];
  expected.forEach((h,i)=>{
    if(String(headers[i]).trim()!==h)
      throw new Error('Header mismatch in '+name+' col '+(i+1)+': '+h);
  });
  return sh;
}
function emailAutoAssertMaster_(ss) {
  const sh=ss.getSheetByName('Master Leads');
  if (!sh) throw new Error('Missing Master Leads');
  const h=sh.getRange(1,19,1,2).getDisplayValues()[0];
  if (h[0] !== 'Email Opt Out' || h[1] !== 'Email Opt Out At')
    throw new Error('Master Leads S/T must be Email Opt Out / Email Opt Out At');
}

/** Read Master Leads with email opt-out columns, not just the legacy 18. */
function emailAutoMasterLeads_(ss) {
  emailAutoAssertMaster_(ss);
  const headers=leadHeaders_();
  const expected=headers[18]==='Email Opt Out' ? headers :
    headers.concat(['Email Opt Out','Email Opt Out At']);
  return campaignRead_(ss,'Master Leads',expected);
}

function emailAutoQueueRows_(sheet) {
  const count=sheet.getLastRow()-1;
  if (count<1) return [];
  return sheet.getRange(2,1,count,EMAIL_AUTO.QUEUE_HEADERS.length)
    .getDisplayValues()
    .map((row,i)=>Object.assign(Object.fromEntries(EMAIL_AUTO.QUEUE_HEADERS
      .map((key,j)=>[key,String(row[j]||'').trim()])),{_row:i+2}))
    .filter(q=>q['Delivery Key']);
}
function emailAutoAppendQueueRows_(ss,rows) {
  if (!rows.length) return;
  const sheet=emailAutoSheet_(ss,EMAIL_AUTO.QUEUE_TAB,EMAIL_AUTO.QUEUE_HEADERS);
  if (sheet.getLastRow()+rows.length>sheet.getMaxRows())
    sheet.insertRowsAfter(sheet.getMaxRows(),sheet.getLastRow()+rows.length-sheet.getMaxRows());
  sheet.getRange(sheet.getLastRow()+1,1,rows.length,EMAIL_AUTO.QUEUE_HEADERS.length).setValues(rows);
  SpreadsheetApp.flush();
}
function emailAutoUpdateQueue_(queue,row,x) {
  if ('status' in x) queue.getRange(row,9).setValue(x.status);
  if ('claimed' in x) queue.getRange(row,11).setValue(x.claimed);
  if ('attempted' in x) queue.getRange(row,12).setValue(x.attempted);
  if ('error' in x) queue.getRange(row,13).setValue(x.error);
  queue.getRange(row,15).setValue(emailAutoNow_());
}
function emailAutoAppendLog_(ss,row) {
  const sh=emailAutoSheet_(ss,EMAIL_AUTO.LOG_TAB,EMAIL_AUTO.LOG_HEADERS);
  sh.getRange(sh.getLastRow()+1,1,1,EMAIL_AUTO.LOG_HEADERS.length).setValues([row]);
}
/**
 * Record a delivery after MailApp accepted it, and AFTER Email Queue and
 * Communication Log were written. Never claim success based only on MailApp
 * returning, nor based only on one of the two records.
 *
 * The official welcome timestamp is the queue's Attempted At (the recorded
 * send-attempt time), NOT the time this tracking helper happens to execute.
 * This helper is also deliberately idempotent for the same delivery.
 */
function emailAutoUpdateLeadAfterSend_(ss, lead, campaignId, options) {
  options = options || {};
  const isTestWelcome = campaignId === 'TEST-WELCOME-IMMEDIATE';
  if (isTestWelcome && !options.allowTestWelcome) {
    throw new Error('Test welcome can update tracking only through the controlled verification.');
  }
  const entry = emailAutoVerifiedSentDelivery_(ss, lead, campaignId, isTestWelcome);
  const sh = ss.getSheetByName('Master Leads');
  const id = String(lead['Lead ID'] || '').trim();
  if (!id || sh.getLastRow() < 2) throw new Error('Missing Master Leads record.');
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues();
  const ix = ids.findIndex(r => r[0] === id);
  if (ix < 0) throw new Error('Lead ID not found for tracking: ' + id);
  const row = ix + 2;
  const current = sh.getRange(row, 13, 1, 4).getDisplayValues()[0];
  const isWelcome = campaignId === 'WELCOME-EMAIL' || isTestWelcome;
  if (isWelcome && emailAutoTrue_(current[0])) {
    const recorded = emailAutoNormalizeTimestamp_(current[1]);
    if (recorded && recorded !== emailAutoNormalizeTimestamp_(entry.sentAt)) {
      throw new Error('Welcome was already recorded at another time. Manual review required.');
    }
  }
  const next = [
    isWelcome ? 'Yes' : current[0],
    isWelcome ? entry.sentAt : current[1],
    campaignId,
    entry.sentAt
  ];
  sh.getRange(row, 13, 1, 4).setValues([next]);
  SpreadsheetApp.flush();
  return { leadId: id, campaignId, trackedAt: entry.sentAt,
    welcomeFlag: isWelcome ? 'Yes' : String(current[0] || ''),
    matchingQueueAndLog: true };
}

/** Find a single, provider-accepted delivery corroborated by a matching log. */
function emailAutoVerifiedSentDelivery_(ss, lead, campaignId, allowTest) {
  const email = String(lead['Email'] || '').trim().toLowerCase();
  const id = String(lead['Lead ID'] || '').trim();
  if (!id || !campaignValidEmail_(email)) throw new Error('Invalid lead ID/email for tracking.');
  const queue = emailAutoSheet_(ss, EMAIL_AUTO.QUEUE_TAB, EMAIL_AUTO.QUEUE_HEADERS);
  const relevant = emailAutoQueueRows_(queue).filter(q =>
    q['Campaign ID'] === campaignId && q['Lead ID'] === id &&
    q['Recipient'].trim().toLowerCase() === email && q['Status'] === 'SENT');
  if (relevant.length !== 1) throw new Error('Expected exactly one matching SENT queue delivery.');
  const delivery = relevant[0];
  const at = emailAutoNormalizeTimestamp_(delivery['Attempted At']);
  if (!at) throw new Error('Successful queue delivery has no valid Attempted At timestamp.');
  const log = emailAutoSheet_(ss, EMAIL_AUTO.LOG_TAB, EMAIL_AUTO.LOG_HEADERS);
  const n = log.getLastRow() - 1;
  const rows = n > 0 ? log.getRange(2, 1, n, EMAIL_AUTO.LOG_HEADERS.length).getDisplayValues() : [];
  const expectedStatus = allowTest ? 'IMMEDIATE WELCOME TEST SENT' : 'SENT';
  const matches = rows.filter(r =>
    r[1] === id && r[2] === campaignId && r[4] === 'Email' &&
    String(r[5]).trim().toLowerCase() === email && r[7] === expectedStatus &&
    r[10] === delivery['Delivery Key']);
  if (matches.length !== 1) throw new Error('Matching successful Communication Log entry not found.');
  const logAt = emailAutoNormalizeTimestamp_(matches[0][6]);
  if (!logAt || Math.abs(emailAutoLocalToEpoch_(logAt) - emailAutoLocalToEpoch_(at)) > 180000) {
    throw new Error('Queue and Communication Log send timestamps disagree.');
  }
  return {deliveryKey:delivery['Delivery Key'],sentAt:at,queueRow:delivery._row};
}

/**
 * READ ONLY: audit the most recent immediate welcome test. This proves the
 * same successfully sent Email Queue + Communication Log records can be used
 * to drive Master Leads tracking. Does not send email or update any cell.
 */
function auditWelcomeDeliveryTracking() {
  const ss = campaignSpreadsheet_();
  const leadList = emailAutoMasterLeads_(ss);
  const queue = emailAutoQueueRows_(emailAutoSheet_(ss, EMAIL_AUTO.QUEUE_TAB, EMAIL_AUTO.QUEUE_HEADERS));
  const tests = queue.filter(q => q['Campaign ID'] === 'TEST-WELCOME-IMMEDIATE' && q['Status'] === 'SENT');
  const last = tests[tests.length - 1];
  if (!last) throw new Error('No SENT immediate welcome test exists to audit.');
  const lead = leadList.find(l => l['Lead ID'] === last['Lead ID']);
  if (!lead) throw new Error('Latest test lead is not in Master Leads.');
  const matched = emailAutoVerifiedSentDelivery_(ss, lead, 'TEST-WELCOME-IMMEDIATE', true);
  const flag = emailAutoTrue_(lead['Welcome Email Sent']);
  const flagTime = emailAutoNormalizeTimestamp_(lead['Welcome Email Sent At']);
  const result = {testQueueStatus:'SENT',testLogMatched:true,
    leadFlag:flag?'Yes':'Not yet marked',
    recordedTimestampMatchesQueue:flag && flagTime === matched.sentAt,
    expectedTimestamp:matched.sentAt,
    engineMode:String(getSetting_('CAMPAIGN_ENGINE_MODE')||''),
    emailsSentByAudit:0,crmRowsModified:0};
  console.log('WELCOME TRACKING AUDIT: '+JSON.stringify(result));
  return result;
}

/**
 * NON-SENDING INTEGRATION TEST: mark ONLY the latest previously SENT immediate
 * test email as welcomed in its matching test lead. Updates Master Leads M:P
 * using the original delivery time. Does not append another log/queue row and
 * refuses to operate outside PREVIEW_ONLY with live welcome switch OFF.
 */
function testWelcomeDeliveryTracking() {
  if (String(getSetting_('CAMPAIGN_ENGINE_MODE')).trim() !== 'PREVIEW_ONLY' ||
      emailAutoTrue_(getSetting_('WELCOME_EMAIL_ENABLED')) ||
      emailAutoTrue_(getSetting_('CAMPAIGN_EMAILS_ENABLED'))) {
    throw new Error('Tracking test requires PREVIEW_ONLY and live switches FALSE.');
  }
  const inbox = String(getSetting_('EMAIL_TEST_RECIPIENT') || '').trim().toLowerCase();
  if (!campaignValidEmail_(inbox)) throw new Error('Designated test inbox is not configured.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Could not acquire tracking test lock.');
  try {
    const ss = campaignSpreadsheet_();
    const queue = emailAutoQueueRows_(emailAutoSheet_(ss, EMAIL_AUTO.QUEUE_TAB, EMAIL_AUTO.QUEUE_HEADERS));
    const tests = queue.filter(q => q['Campaign ID'] === 'TEST-WELCOME-IMMEDIATE' &&
      q['Status'] === 'SENT' && q['Recipient'].trim().toLowerCase() === inbox);
    const last = tests[tests.length - 1];
    if (!last) throw new Error('No prior successful immediate test to verify.');
    const lead = emailAutoMasterLeads_(ss).find(l => l['Lead ID'] === last['Lead ID']);
    if (!lead || lead['Source'] !== 'Google Form' ||
        String(lead['Email']).trim().toLowerCase() !== inbox ||
        String(lead['Active Lead']).trim().toLowerCase() !== 'yes') {
      throw new Error('Latest test delivery does not match a valid Google Form test lead.');
    }
    const result = emailAutoUpdateLeadAfterSend_(ss,lead,'TEST-WELCOME-IMMEDIATE',
      {allowTestWelcome:true});
    console.log('WELCOME TRACKING TEST: '+JSON.stringify({
      welcomeSent:result.welcomeFlag,
      welcomeSentAt:result.trackedAt,
      matchingQueueAndLog:result.matchingQueueAndLog,
      emailsSentByTest:0,
      productionEnabled:false
    }));
    return result;
  } finally {lock.releaseLock();}
}

function emailAutoRefreshCampaignSummary_(ss) {
  const queue=emailAutoQueueRows_(ss.getSheetByName(EMAIL_AUTO.QUEUE_TAB));
  const sh=ss.getSheetByName('Campaigns');
  if(sh.getLastRow()<2) return;
  const ids=sh.getRange(2,1,sh.getLastRow()-1,1).getDisplayValues();
  ids.forEach((r,i)=>{
    const id=String(r[0]||'').trim();
    const relevant=queue.filter(q=>q['Campaign ID']===id);
    if(!id || !relevant.length) return;
    const sent=relevant.filter(q=>q['Status']==='SENT').length;
    const failed=relevant.filter(q=>q['Status']==='FAILED').length;
    sh.getRange(i+2,23,1,3).setValues([[sent,failed,emailAutoNow_()]]);
    if(id!=='WELCOME-EMAIL' && relevant.every(q=>
       ['SENT','FAILED','SKIPPED'].includes(q['Status']))) {
      sh.getRange(i+2,22).setValue('Complete');
    }
  });
}
function emailAutoSetCampaignStatus_(ss,id,status) {
  const sh=ss.getSheetByName('Campaigns');
  if(sh.getLastRow()<2) return;
  const ids=sh.getRange(2,1,sh.getLastRow()-1,1).getDisplayValues();
  const ix=ids.findIndex(r=>r[0]===id);
  if(ix>=0) sh.getRange(ix+2,22).setValue(status);
}
function emailAutoNormalizeTimestamp_(value) {
  const v=String(value||'').trim();
  let m=v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(m)return m[1]+'-'+m[2]+'-'+m[3]+' '+m[4]+':'+m[5]+':'+(m[6]||'00');
  m=v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
  if(!m)return '';
  let h=+m[4]; if(m[7] && m[7].toUpperCase()==='PM')h=h%12+12;
  if(m[7] && m[7].toUpperCase()==='AM')h=h%12;
  return m[3]+'-'+String(m[1]).padStart(2,'0')+'-'+String(m[2]).padStart(2,'0')+' '+
    String(h).padStart(2,'0')+':'+m[5]+':'+(m[6]||'00');
}
function emailAutoLocalToEpoch_(stamp) {
  // Treat local wall-clock fields as a UTC-like scalar for elapsed comparison.
  // For schedule gating this avoids parsing locale-dependent Date strings.
  const m=String(stamp).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  return m ? Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]) : NaN;
}
function emailAutoIsDue_(campaign,now) {
  const date=String(campaign['Send Date']||'').trim();
  const time=String(campaign['Send Time']||'').trim();
  let yyyy,mm,dd;
  let m=date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) {yyyy=+m[1];mm=+m[2];dd=+m[3];}
  else if ((m=date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    yyyy=+m[3];mm=+m[1];dd=+m[2];
  } else if ((m=date.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const idx=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .indexOf(m[1].toLowerCase()); if(idx<0)return false;
    yyyy=+m[3];mm=idx+1;dd=+m[2];
  } else return false;
  m=time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if(!m)return false;
  let hour=+m[1]; const min=+m[2];
  if(m[3]) {if(hour<1 || hour>12)return false; hour=hour%12+(m[3].toUpperCase()==='PM'?12:0);}
  if(hour>23||min>59)return false;
  const at=Date.UTC(yyyy,mm-1,dd,hour,min,0);
  const delta=emailAutoLocalToEpoch_(now)-at;
  return delta>=0 && delta<=EMAIL_AUTO.MAX_DELAY_MINUTES*60000;
}

/** Optional helper: arm welcome only for leads created from NOW forward. */
function armWelcomeFromNow() {
  if (String(getSetting_('CAMPAIGN_ENGINE_MODE'))!=='LIVE')
    throw new Error('Set the engine to LIVE after completing all production checks.');
  emailAutoAssertLiveSettings_();
  const ss=campaignSpreadsheet_();
  const welcome=campaignRead_(ss,'Campaigns',campaignHeaders_())
    .find(c=>c['Campaign ID']==='WELCOME-EMAIL');
  if(!welcome || welcome['Enabled']!=='Yes' || welcome['Status']!=='Ready')
    throw new Error('Welcome Email campaign must be enabled and Ready.');
  const context=emailAutoCampaignContext_(welcome,
    campaignRead_(ss,'Templates',templateHeaders_()),
    campaignRead_(ss,'Events',eventHeaders_()));
  if(!context.ok)throw new Error(context.issues.join('; '));
  emailAutoSetSetting_('WELCOME_START_AT',emailAutoNow_());
  emailAutoSetSetting_('WELCOME_EMAIL_ENABLED','TRUE');
  console.log('Welcome automation armed for NEW leads after '+emailAutoNow_()+'.');
}
function emailAutoSetSetting_(key,val) {
  const sh=campaignSpreadsheet_().getSheetByName('Settings');
  const rows=sh.getRange(2,1,Math.max(sh.getLastRow()-1,1),2).getDisplayValues();
  const ix=rows.findIndex(r=>r[0]===key);
  if(ix<0)throw new Error('Settings key missing: '+key);
  sh.getRange(ix+2,2).setValue(val);
}

function testUnsubscribeLink() {
  const leads = emailAutoMasterLeads_(campaignSpreadsheet_());
  const lead = leads.reverse().find(l =>
    l['Source'] === 'Squarespace' &&
    l['Parent Name'] === 'CRM Welcome Test'
  );

  if (!lead) throw new Error('Test lead not found.');

  const email = String(lead['Email']).toLowerCase();
  if (leads.some(l =>
    String(l['Email']).toLowerCase() === email &&
    l['Parent Name'] !== 'CRM Welcome Test'
  )) throw new Error('Test email is shared with another lead.');

  console.log(emailAutoFooter_(
    lead['Lead ID'], email, 'EN', 'WELCOME-EMAIL'
  ));
}
