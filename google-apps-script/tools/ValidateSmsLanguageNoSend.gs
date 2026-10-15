/** No-send installation check. Synthetic in-memory data only; no Sheet, HTTP, trigger or settings changes. */
function validateSmsLanguageInstallationNoSend() {
  const functions = [onOpen,previewSelectedCampaign,previewWelcomeCampaign,validateCampaignEngine,previewCampaignById_,campaignIssues_,campaignMessage_,campaignMergeValues_,campaignRender_,campaignEligible_,campaignChannels_,campaignLanguage_,campaignLocalizeDate_,campaignValidEmail_,campaignValidPhone_,campaignRequirePreviewMode_,campaignSpreadsheet_,campaignRead_,campaignAssertHeaders_,campaignCheckUniqueIds_,campaignHeaders_,eventHeaders_,templateHeaders_,leadHeaders_,previewHeaders_,logHeaders_,smsText_,smsTrue_,smsHash_,smsJsonHash_,smsPhone_,smsSeptets_,smsChannelIncludes_,smsTemplateHash_,smsPolicyHash_,smsBusiness_,smsLanguage_,smsEffectiveManual_,smsRender_,smsIso_,smsWallToIso_,smsCreatedMs_,smsScheduled_,smsEligibility_,smsFreeze_,smsResponse_,smsNow_,smsSs_,smsLocked_,smsRows_,smsSettings_,smsColumn_,smsRaw_,smsPatch_,smsAppend_,smsJournal_,smsEvent_,smsSnapshot_,smsSubmissions_,smsSetSetting_,smsLimit_,smsOperator_,installSmsCrmPaused,smsSeedLeadsLocked_,smsValidationRules_,validateSmsCrm,smsProtectRanges_,validateStoppedSmsIntegration,diagnoseSmsSheetAccess,smsContext_,smsCandidate_,smsCandidateHash_,smsOutboxFrom_,smsPlanLocked_,planSmsCrm,smsPrepareLocked_,smsCanIngest_,smsReservationLocked_,smsProducerRequest_,smsFinishLocked_,smsPollJobsLocked_,pollSmsStatuses,runSmsWorker,smsProjectLocked_,smsPolicyAuthorized_,smsAddMenu_,smsSelected_,approveSelectedSmsTemplate,armSelectedSmsCampaign,createManualSmsDraft,previewSelectedSms,approveSelectedManualSms,holdSelectedSms,installSmsWorkerTrigger,installSmsAutomationTriggers,smsPreviewIssues_,smsPreviewColumns_,smsInspectLeadStopped_];
  const names = ["onOpen","previewSelectedCampaign","previewWelcomeCampaign","validateCampaignEngine","previewCampaignById_","campaignIssues_","campaignMessage_","campaignMergeValues_","campaignRender_","campaignEligible_","campaignChannels_","campaignLanguage_","campaignLocalizeDate_","campaignValidEmail_","campaignValidPhone_","campaignRequirePreviewMode_","campaignSpreadsheet_","campaignRead_","campaignAssertHeaders_","campaignCheckUniqueIds_","campaignHeaders_","eventHeaders_","templateHeaders_","leadHeaders_","previewHeaders_","logHeaders_","smsText_","smsTrue_","smsHash_","smsJsonHash_","smsPhone_","smsSeptets_","smsChannelIncludes_","smsTemplateHash_","smsPolicyHash_","smsBusiness_","smsLanguage_","smsEffectiveManual_","smsRender_","smsIso_","smsWallToIso_","smsCreatedMs_","smsScheduled_","smsEligibility_","smsFreeze_","smsResponse_","smsNow_","smsSs_","smsLocked_","smsRows_","smsSettings_","smsColumn_","smsRaw_","smsPatch_","smsAppend_","smsJournal_","smsEvent_","smsSnapshot_","smsSubmissions_","smsSetSetting_","smsLimit_","smsOperator_","installSmsCrmPaused","smsSeedLeadsLocked_","smsValidationRules_","validateSmsCrm","smsProtectRanges_","validateStoppedSmsIntegration","diagnoseSmsSheetAccess","smsContext_","smsCandidate_","smsCandidateHash_","smsOutboxFrom_","smsPlanLocked_","planSmsCrm","smsPrepareLocked_","smsCanIngest_","smsReservationLocked_","smsProducerRequest_","smsFinishLocked_","smsPollJobsLocked_","pollSmsStatuses","runSmsWorker","smsProjectLocked_","smsPolicyAuthorized_","smsAddMenu_","smsSelected_","approveSelectedSmsTemplate","armSelectedSmsCampaign","createManualSmsDraft","previewSelectedSms","approveSelectedManualSms","holdSelectedSms","installSmsWorkerTrigger","installSmsAutomationTriggers","smsPreviewIssues_","smsPreviewColumns_","smsInspectLeadStopped_"];
  const constants = [['CAMPAIGN_ENGINE',CAMPAIGN_ENGINE],['SMS_SCHEMA',SMS_SCHEMA],['SMS_DEFAULTS',SMS_DEFAULTS],['SMS_QUEUE_FIELDS',SMS_QUEUE_FIELDS],['SMS_STATES',SMS_STATES]];
  const fingerprint = smsHash_(JSON.stringify([functions.map((f,i)=>[names[i],f.toString().replace(/\r\n/g,'\n')]),constants]));
  if (fingerprint !== 'c213ea0d78555e70f7fe017abe7403e255352953c417b0a88b0b04f2fb95311d') throw new Error('INSTALLED_CODE_MISMATCH: '+fingerprint);
  const assert = (ok, label) => { if (!ok) throw new Error('LANGUAGE_CHECK_FAILED: '+label); };
  const c = {'Campaign ID':'VALIDATION-ONLY', 'Campaign Name':'Validation', Trigger:'Manual', Channel:'SMS', Audience:'All Active Leads', 'Message Mode':'Template', 'Template ID':'VALIDATION-TEMPLATE', Enabled:'Yes', 'SMS Approval Mode':'AUTO', 'SMS Control':'READY', 'Business Event Type':'Validation', 'Event Instance':'no-send'};
  const t = {'Template ID':'VALIDATION-TEMPLATE', Status:'Approved', 'SMS Status':'Approved', 'SMS Revision':'1', 'SMS Body EN':'Hello {ParentName}.', 'SMS Body ES':'Hola {ParentName}.'};
  t['SMS Content Hash']=smsTemplateHash_(t);
  c['SMS Policy Fingerprint']=smsPolicyHash_(c,t);
  const s={...SMS_DEFAULTS,SMS_ROLLOUT_MODE:'ALLOWLIST',SMS_TEST_RECIPIENT_ALLOWLIST:'+12025550123'};
  const checks=[];
  for(const [label,value,lang,body] of [
    ['blank','','EN','Hello Example.'], ['undefined',undefined,'EN','Hello Example.'],
    ['unrecognized','Estonian','EN','Hello Example.'], ['English','English','EN','Hello Example.'],
    ['Spanish','Spanish','ES','Hola Example.'], ['ES','es','ES','Hola Example.'],
    ['accented alias',' Español ','ES','Hola Example.'], ['alias','Espanol','ES','Hola Example.']
  ]) {
    const l={'Lead ID':'VALIDATION-LEAD','Business Lead ID':'VALIDATION-LEAD','Parent Name':'Example',Phone:'+12025550123','Preferred Language':value,'Active Lead':'Yes','SMS Permission':'Allowed','SMS Permission Source':'synthetic'};
    const ctx={campaigns:[c],templates:[t],leads:[l],events:[],s};
    const rendered=smsRender_(c,t,null,l,'');
    const eligible=smsEligibility_(c,t,null,l,[l],s,Date.now(),'');
    const previewIssues=campaignIssues_(c,t,null,l,'SMS',smsLanguage_(value),ctx);
    assert(rendered.lang===lang && rendered.body===body,label+' rendering');
    assert(eligible.lang===lang && eligible.body===body && eligible.issues.length===0,label+' AUTO');
    assert(previewIssues.length===0,label+' preview');
    const candidate={...eligible,leadId:l['Lead ID'],eventType:'Validation',dedupe:'validation-only',scheduledAt:'2026-10-15T00:00:00.000Z'};
    const frozen=smsFreeze_(candidate,Date.now());
    const saved={'Frozen Request JSON':frozen.body,'Snapshot Hash':frozen.hash,'Dedupe Key':'validation-only'};
    l['Preferred Language']=lang==='ES'?'English':'Spanish';
    candidate.body='Changed after prepare';
    const recovered=smsSnapshot_(saved);
    assert(recovered.body===frozen.body && recovered.payload.message===body,label+' frozen snapshot');
    checks.push(label+':'+lang);
  }
  const result={result:'PASS',fingerprint,functionsChecked:functions.length,checks,frozenSnapshot:'PASS',smsSubmitted:0,crmWrites:0};
  console.log(JSON.stringify(result));
  return result;
}
