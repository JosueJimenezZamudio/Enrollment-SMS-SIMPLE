/** Explicit operator actions. None of the preview/approval actions send HTTP to Supabase. */
function smsAddMenu_() {
  SpreadsheetApp.getUi().createMenu('SMS Tools')
    .addItem('Validate stopped SMS setup','validateSmsCrm')
    .addItem('Approve selected SMS template','approveSelectedSmsTemplate')
    .addItem('Arm selected SMS campaign policy','armSelectedSmsCampaign')
    .addItem('Plan SMS rows (no send)','planSmsCrm')
    .addItem('Create manual SMS for selected lead','createManualSmsDraft')
    .addItem('Preview selected SMS','previewSelectedSms')
    .addItem('Approve selected manual SMS','approveSelectedManualSms')
    .addItem('Hold selected SMS','holdSelectedSms')
    .addItem('Refresh SMS statuses','pollSmsStatuses').addToUi();
}
function smsSelected_(tab,key) {
  const ss=SpreadsheetApp.getActiveSpreadsheet();if(!ss||ss.getId()!==CRM.ID||ss.getActiveSheet().getName()!==tab)throw new Error('SELECT_ROW_ON_'+tab);
  const row=ss.getActiveRange().getRow();if(row<2)throw new Error('SELECT_DATA_ROW');
  const item=smsRows_(tab).find(x=>x._row===row);if(!item||!item[key])throw new Error('MISSING_ROW_ID');return item;
}
function approveSelectedSmsTemplate() {
  const who=smsOperator_(),before=smsSelected_('Templates','Template ID'),hash=smsTemplateHash_(before),ui=SpreadsheetApp.getUi();
  if(before.Status!=='Approved')throw new Error('TEMPLATE_MUST_BE_APPROVED');
  if(!smsText_(before['SMS Body EN']).trim()&&!smsText_(before['SMS Body ES']).trim())throw new Error('SMS_BODY_REQUIRED');
  if(ui.alert('Approve SMS template?',smsText_(before['SMS Body EN'])+'\n\n'+smsText_(before['SMS Body ES']),ui.ButtonSet.YES_NO)!==ui.Button.YES)return;
  smsLocked_(()=>{const live=smsRows_('Templates').find(t=>t['Template ID']===before['Template ID']);if(smsTemplateHash_(live)!==hash)throw new Error('TEMPLATE_CHANGED');const revision=String((Number(live['SMS Revision'])||0)+1);
    smsEvent_('TEMPLATE_APPROVED',{'Authorization Mode':'POLICY','Authorization ID':Utilities.getUuid(),'Policy Revision':revision,'Source Snapshot JSON':JSON.stringify({templateId:live['Template ID'],revision,hash,en:live['SMS Body EN']||'',es:live['SMS Body ES']||'',required:live['SMS Required Variables']||'',actor:who})});
    smsPatch_('Templates','Template ID',live['Template ID'],{'SMS Revision':revision,'SMS Status':'Approved','SMS Content Hash':hash,'SMS Approved At':smsNow_(),'SMS Approved By':who});});
}
function armSelectedSmsCampaign() {
  smsOperator_();const before=smsSelected_('Campaigns','Campaign ID'),ctx=smsContext_(),t=ctx.templates.find(x=>x['Template ID']===before['Template ID']),e=ctx.events.find(x=>x['Event ID']===before['Event ID']);
  if(!['AUTO','MANUAL'].includes(before['SMS Approval Mode']))throw new Error('SET_APPROVAL_MODE');
  if(!smsChannelIncludes_(before.Channel,'SMS'))throw new Error('SET_SMS_OR_BOTH_CHANNEL');
  if(!['All Active Leads','Applied','Not Applied'].includes(before.Audience))throw new Error('INVALID_AUDIENCE');
  const proposed={...before,'Business Event Type':before['Business Event Type']||(before.Trigger==='New Lead'?'New Lead':e?e['Event Type']:'Campaign'),'Event Instance':before['Event Instance']||(before.Trigger==='New Lead'?'welcome:onboarding:v1':before['Event ID']||before['Campaign ID'])};
  if(proposed['SMS Approval Mode']==='AUTO'&&(!t||t['SMS Status']!=='Approved'||t['SMS Content Hash']!==smsTemplateHash_(t)))throw new Error('APPROVE_SMS_TEMPLATE_FIRST');
  smsScheduled_(proposed,ctx.s,'');
  const hash=smsPolicyHash_(proposed,t),ui=SpreadsheetApp.getUi();
  if(ui.alert('Arm SMS campaign policy?',proposed['Campaign ID']+'\nMode: '+proposed['SMS Approval Mode']+'\nAUTO authorizes eligible future rows without per-row approval. Custom overrides still require MANUAL. No SMS is submitted by this action.',ui.ButtonSet.YES_NO)!==ui.Button.YES)return;
  smsLocked_(()=>{const fresh=smsContext_(),live=fresh.campaigns.find(c=>c['Campaign ID']===before['Campaign ID']),lt=fresh.templates.find(x=>x['Template ID']===live['Template ID']);
    const ready={...live,'Business Event Type':proposed['Business Event Type'],'Event Instance':proposed['Event Instance']};
    if(smsPolicyHash_(ready,lt)!==hash)throw new Error('CAMPAIGN_CHANGED');
    const old=smsJournal_().filter(e=>e['Journal Event Type']==='PREPARED').map(e=>JSON.parse(e['Source Snapshot JSON'])).find(x=>x.campaignId===ready['Campaign ID']&&(x.eventType!==ready['Business Event Type']||x.eventInstance!==ready['Event Instance']));if(old)throw new Error('EXISTING_CAMPAIGN_IDENTITY_IS_IMMUTABLE');
    const rev=String((Number(live['SMS Policy Revision'])||0)+1);
    smsEvent_('POLICY_ARMED',{'Authorization Mode':ready['SMS Approval Mode'],'Authorization ID':'POLICY-'+rev+'-'+hash,'Policy Revision':rev,'Source Snapshot JSON':JSON.stringify({campaignId:ready['Campaign ID'],fingerprint:hash})});
    smsPatch_('Campaigns','Campaign ID',ready['Campaign ID'],{'Business Event Type':ready['Business Event Type'],'Event Instance':ready['Event Instance'],'SMS Policy Revision':rev,'SMS Policy Fingerprint':hash,'SMS Control':'READY','SMS Status':'ARMED'});
  });
}
function createManualSmsDraft() {
  smsOperator_();const lead=smsSelected_('Master Leads','Lead ID'),ui=SpreadsheetApp.getUi();
  const answer=ui.prompt('Manual SMS','Enter the existing SMS campaign ID. This creates a draft only.',ui.ButtonSet.OK_CANCEL);if(answer.getSelectedButton()!==ui.Button.OK)return;
  smsLocked_(()=>{smsSeedLeadsLocked_(false);const c=smsRows_('Campaigns').find(x=>x['Campaign ID']===answer.getResponseText().trim()),l=smsRows_('Master Leads').find(x=>x['Lead ID']===lead['Lead ID']);if(!c)throw new Error('CAMPAIGN_NOT_FOUND');
    const row=smsOutboxFrom_(c,l);if(smsRows_('SMS Outbox').some(r=>r['Dedupe Key']===row['Dedupe Key'])||smsJournal_().some(e=>e['Journal Event Type']==='PREPARED'&&e['Dedupe Key']===row['Dedupe Key']))throw new Error('BUSINESS_EVENT_ALREADY_EXISTS');
    row['Approval Mode']='MANUAL';row['Send Control']='DRAFT';smsAppend_('SMS Outbox',row);});
}
function previewSelectedSms() {
  smsOperator_();const row=smsSelected_('SMS Outbox','Outbox ID'),x=smsCandidate_(row,smsContext_(),Date.now());
  SpreadsheetApp.getUi().alert('SMS preview',x.phone+'\n'+x.body+'\nSchedule: '+(x.scheduledAt||'Freeze current time at preparation')+'\nSeptets: '+x.septets+'\n'+x.issues.join('; '),SpreadsheetApp.getUi().ButtonSet.OK);
  return {issues:x.issues,septets:x.septets,mode:x.mode};
}
function approveSelectedManualSms() {
  smsOperator_();const row=smsSelected_('SMS Outbox','Outbox ID');if(row['Submission ID'])throw new Error('FROZEN_REQUEST_CANNOT_BE_REAPPROVED');
  const x=smsCandidate_({...row,'Approval Mode':'MANUAL'},smsContext_(),Date.now()),hash=smsCandidateHash_(x),ui=SpreadsheetApp.getUi();if(x.issues.length)throw new Error(x.issues.join('; '));
  if(x.scheduledAt&&Date.parse(x.scheduledAt)<Date.now()&&x.c.Trigger!=='Scheduled')throw new Error('MANUAL_SCHEDULE_IS_IN_THE_PAST');
  if(ui.alert('Approve this exact SMS?',x.phone+'\n\n'+x.body+'\n\nSchedule: '+(x.scheduledAt||'When available; timestamp freezes once')+'\n'+x.septets+' GSM-7 septets',ui.ButtonSet.YES_NO)!==ui.Button.YES)return;
  smsLocked_(()=>{const fresh=smsRows_('SMS Outbox').find(r=>r['Outbox ID']===row['Outbox ID']);const current=smsCandidate_({...fresh,'Approval Mode':'MANUAL'},smsContext_(),Date.now());if(current.issues.length||smsCandidateHash_(current)!==hash)throw new Error('PREVIEW_CHANGED');
    const auth=Utilities.getUuid();smsEvent_('MANUAL_APPROVED',{'Outbox ID':row['Outbox ID'],'Authorization Mode':'MANUAL','Authorization ID':auth,'Snapshot Hash':hash,'Submission State':'APPROVED'});
    smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{'Approval Mode':'MANUAL','Send Control':'READY','Authorization ID':auth,'Authorization Fingerprint':hash,'Submission State':'APPROVED'});});
}
function holdSelectedSms() { smsOperator_();const row=smsSelected_('SMS Outbox','Outbox ID');smsLocked_(()=>{smsEvent_('HOLD_REQUESTED',{'Outbox ID':row['Outbox ID'],'Submission ID':row['Submission ID']||''});smsPatch_('SMS Outbox','Outbox ID',row['Outbox ID'],{'Send Control':'HOLD'});}); }
/** Install only during authorized rollout; never called by workbook setup. */
function installSmsWorkerTrigger() { return installSmsAutomationTriggers(); }
/** Independent status trigger keeps writeback alive when planning/ingest fails or is paused. */
function installSmsAutomationTriggers() {
  smsOperator_();validateSmsCrm();
  if(PropertiesService.getScriptProperties().getProperty('SMS_SCHEMA_READY')!=='true')throw new Error('SMS_INSTALLATION_INCOMPLETE');
  return smsLocked_(()=>{
    const handlers=['runSmsWorker','pollSmsStatuses'],triggers=ScriptApp.getProjectTriggers();
    for(const name of handlers)if(triggers.filter(t=>t.getHandlerFunction()===name).length>1)throw new Error('MULTIPLE_SMS_TRIGGERS');
    for(const name of handlers)if(!triggers.some(t=>t.getHandlerFunction()===name))ScriptApp.newTrigger(name).timeBased().everyMinutes(1).create();
    return {worker:true,status:true};
  });
}
function smsPreviewIssues_(c,t,e,l,context) {
  const ctx=context||smsContext_(),full=ctx.campaigns.find(x=>x['Campaign ID']===c['Campaign ID'])||c,lead=ctx.leads.find(x=>x['Lead ID']===l['Lead ID'])||l;
  return smsEligibility_(full,ctx.templates.find(x=>x['Template ID']===full['Template ID']),e,lead,ctx.leads,ctx.s,Date.now(),'').issues;
}

function smsPreviewColumns_(campaign, lead, channel, context) {
  if(channel!=='SMS')return Array(8).fill('');
  try {
    const ctx=context||smsContext_(),c=ctx.campaigns.find(x=>x['Campaign ID']===campaign['Campaign ID']),l=ctx.leads.find(x=>x['Lead ID']===lead['Lead ID']);
    const row=smsOutboxFrom_(c,l),x=smsCandidate_(row,ctx,Date.now());
    return [row['Outbox ID'],x.mode,c['SMS Control'],x.septets===null?'':x.septets,x.scheduledAt,x.issues.join('; ')||'ELIGIBLE',x.key,x.t?x.t['SMS Revision']:''];
  } catch(_) {return ['','','','','','Invalid identity or schedule','',''];}
}

/** Read-only single-lead inspection. Never plans, freezes, approves or submits. */
function smsInspectLeadStopped_(campaignId, leadId) {
  smsOperator_();
  const ctx = smsContext_();
  if (ctx.s.SMS_ENGINE_MODE !== 'PREVIEW_ONLY' ||
      !smsTrue_(ctx.s.SMS_PAUSED) || smsTrue_(ctx.s.SMS_AUTO_ENABLED)) {
    throw new Error('SMS_MUST_BE_STOPPED');
  }
  const c = ctx.campaigns.find(x => x['Campaign ID'] === campaignId);
  const l = ctx.leads.find(x => x['Lead ID'] === leadId);
  if (!c || !l) throw new Error('CAMPAIGN_OR_LEAD_NOT_FOUND');
  const t = ctx.templates.find(x => x['Template ID'] === c['Template ID']);
  const e = ctx.events.find(x => x['Event ID'] === c['Event ID']);
  const r = smsEligibility_(c, t, e, l, ctx.leads, ctx.s, Date.now(), '');
  let scheduledAt = '', scheduleIssue = '';
  try { scheduledAt = smsScheduled_(c, ctx.s, ''); }
  catch (_) { scheduleIssue = 'MISSING_OR_INVALID_CAMPAIGN_SCHEDULE'; }
  const allow = smsText_(ctx.s.SMS_TEST_RECIPIENT_ALLOWLIST)
    .split(/[,\s]+/).filter(Boolean).map(smsPhone_).filter(Boolean);
  const audience = ctx.leads.filter(x => campaignEligible_(x, c.Audience));
  return {
    campaignId, leadId, message: r.body, gsm7Septets: r.septets,
    oneSegment: !!r.body && r.septets !== null && r.septets <= 160,
    approvalMode: r.manual ? 'MANUAL' : c['SMS Approval Mode'],
    issues: r.issues, scheduledAt, scheduleIssue,
    recipientLast4: (r.phone || '').slice(-4),
    businessLeadMatches: l['Business Lead ID'] === l['Lead ID'],
    allowlistMode: ctx.s.SMS_ROLLOUT_MODE === 'ALLOWLIST',
    allowlistContainsOnlyThisPhone: !!r.phone && allow.length === 1 && allow[0] === r.phone,
    audienceRows: audience.length,
    audienceRowsOutsideAllowlist: audience.filter(x => !allow.includes(smsPhone_(x.Phone))).length,
    submissionsMade: 0
  };
}
