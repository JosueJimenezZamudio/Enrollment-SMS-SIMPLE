const CAMPAIGN_ENGINE = Object.freeze({
  CAMPAIGN_TAB: 'Campaigns',
  EVENT_TAB: 'Events',
  TEMPLATE_TAB: 'Templates',
  LEAD_TAB: 'Master Leads',
  PREVIEW_TAB: 'Campaign Preview',
  LOG_TAB: 'Communication Log',
  PREVIEW_LIMIT: 500,
  DISPLAY_TIMEZONE: 'America/Los_Angeles'
});

function onOpen() {
  smsAddMenu_();
  SpreadsheetApp.getUi()
    .createMenu('Campaign Tools')
    .addItem('Preview selected campaign', 'previewSelectedCampaign')
    .addItem('Preview welcome campaign', 'previewWelcomeCampaign')
    .addItem('Validate campaign setup', 'validateCampaignEngine')
    .addSeparator()
    .addItem('Validate email automation', 'validateEmailAutomation')
    .addItem('Send ONE test email (selected campaign)', 'sendSelectedCampaignTestEmail')
    .addItem('Install automatic email scheduler', 'installEmailScheduler')
    .addToUi();
}

function previewSelectedCampaign() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active || active.getId() !== CRM.ID ||
      active.getActiveSheet().getName() !== CAMPAIGN_ENGINE.CAMPAIGN_TAB) {
    throw new Error('Select a campaign row on the Campaigns tab first.');
  }
  const row = active.getActiveRange().getRow();
  if (row < 2) throw new Error('Select a campaign row, not the header.');
  const id = String(active.getActiveSheet().getRange(row, 1).getDisplayValue()).trim();
  if (!id) throw new Error('The selected campaign has no Campaign ID.');
  return previewCampaignById_(id);
}

function previewWelcomeCampaign() {
  return previewCampaignById_('WELCOME-EMAIL');
}

function validateCampaignEngine() {
  const ss = campaignSpreadsheet_();
  const campaigns = campaignRead_(ss, CAMPAIGN_ENGINE.CAMPAIGN_TAB, campaignHeaders_());
  const events = campaignRead_(ss, CAMPAIGN_ENGINE.EVENT_TAB, eventHeaders_());
  const templates = campaignRead_(ss, CAMPAIGN_ENGINE.TEMPLATE_TAB, templateHeaders_());
  campaignRead_(ss, CAMPAIGN_ENGINE.LEAD_TAB, leadHeaders_());
  campaignRead_(ss, CAMPAIGN_ENGINE.PREVIEW_TAB, previewHeaders_());
  campaignRead_(ss, CAMPAIGN_ENGINE.LOG_TAB, logHeaders_());
  campaignCheckUniqueIds_(campaigns, 'Campaign ID');
  campaignCheckUniqueIds_(events, 'Event ID');
  campaignCheckUniqueIds_(templates, 'Template ID');
  console.log('Campaign engine verified. Campaigns: ' + campaigns.length +
    ', Events: ' + events.length + ', Templates: ' + templates.length + '.');
  console.log('Preview only. No email/SMS sender or scheduled campaign trigger is installed.');
  return true;
}

function previewCampaignById_(campaignId) {
  campaignRequirePreviewMode_();
  const ss = campaignSpreadsheet_();
  const campaigns = campaignRead_(ss, CAMPAIGN_ENGINE.CAMPAIGN_TAB, campaignHeaders_());
  const templates = campaignRead_(ss, CAMPAIGN_ENGINE.TEMPLATE_TAB, templateHeaders_());
  const events = campaignRead_(ss, CAMPAIGN_ENGINE.EVENT_TAB, eventHeaders_());
  const leads = campaignRead_(ss, CAMPAIGN_ENGINE.LEAD_TAB, leadHeaders_());

  const campaign = campaigns.find(item => item['Campaign ID'] === campaignId);
  if (!campaign) throw new Error('Campaign ID not found: ' + campaignId);
  const audience = campaign['Audience'];
  const channels = campaignChannels_(campaign['Channel']);
  if (!['All Active Leads', 'Not Applied', 'Applied'].includes(audience)) {
    throw new Error('Unsupported audience: ' + audience);
  }

  const template = campaign['Template ID'] ?
    templates.find(item => item['Template ID'] === campaign['Template ID']) : null;
  const event = campaign['Event ID'] ?
    events.find(item => item['Event ID'] === campaign['Event ID']) : null;
  const recipients = leads.filter(lead => campaignEligible_(lead, audience));
  const timestamp = Utilities.formatDate(new Date(),
    CAMPAIGN_ENGINE.DISPLAY_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const rows = [];

  for (const lead of recipients) {
    const language = campaignLanguage_(lead['Preferred Language']);
    for (const channel of channels) {
      const issues = campaignIssues_(campaign, template, event, lead, channel, language);
      const message = campaignMessage_(campaign, template, channel, language);
      const values = campaignMergeValues_(campaign, event, lead, language);
      const renderedSubject = channel === 'Email' ? campaignRender_(message.subject, values) : {text:'',issues:[]};
      const renderedBody = campaignRender_(message.body, values);
      issues.push(...renderedSubject.issues, ...renderedBody.issues);
      const recipient = channel === 'Email' ? lead['Email'] : lead['Phone'];
      const uniqueIssues = [...new Set(issues)];

      rows.push([
        timestamp, campaignId, campaign['Campaign Name'], lead['Lead ID'],
        lead['Parent Name'], recipient, language, channel, renderedSubject.text,
        renderedBody.text,
        uniqueIssues.length ? 'Needs review' : 'Preview ready',
        uniqueIssues.join('; '),
        ...smsPreviewColumns_(campaign, lead, channel)
      ]);
      if (rows.length > CAMPAIGN_ENGINE.PREVIEW_LIMIT) {
        throw new Error('Preview exceeds ' + CAMPAIGN_ENGINE.PREVIEW_LIMIT +
          ' message rows. Narrow the audience before previewing.');
      }
    }
  }

  if (!rows.length) {
    rows.push([timestamp, campaignId, campaign['Campaign Name'], '', '', '', '', '', '', '',
      'No recipients', 'No active leads match this audience. Blank application status is unknown, not No.', ...Array(8).fill('')]);
  }

  const preview = ss.getSheetByName(CAMPAIGN_ENGINE.PREVIEW_TAB);
  if (!preview) throw new Error('Campaign Preview tab is missing.');
  campaignAssertHeaders_(preview, previewHeaders_());
  const prior = preview.getLastRow();
  if (prior > 1) preview.getRange(2, 1, prior - 1, Math.min(20,preview.getMaxColumns())).clearContent();
  if (preview.getMaxRows() < rows.length + 1) {
    preview.insertRowsAfter(preview.getMaxRows(), rows.length + 1 - preview.getMaxRows());
  }
  preview.getRange(2, 1, rows.length, 20).setValues(rows);
  SpreadsheetApp.flush();

  const flagged = rows.filter(row => row[10] !== 'Preview ready').length;
  console.log('Preview: ' + campaignId + '; ' + rows.length +
    ' message rows; ' + flagged + ' require review. No messages sent.');
  return { campaignId, previewRows: rows.length, needsReview: flagged, messagesSent: 0 };
}

function campaignIssues_(campaign, template, event, lead, channel, language) {
  const issues = [];
  const mode = campaign['Message Mode'];
  if (!['Template', 'Custom', 'Template + Override'].includes(mode)) {
    issues.push('Invalid Message Mode');
  }
  if (mode !== 'Custom' && !template) issues.push('Template ID not found');
  if (mode !== 'Custom' && template && template['Status'] !== 'Approved') {
    issues.push('Template not approved');
  }
  if (campaign['Event ID'] && !event) issues.push('Event ID not found');
  if (event && event['Status'] !== 'Confirmed') issues.push('Event is not confirmed');
  if (campaign['Enabled'] !== 'Yes') issues.push('Campaign disabled');
  if (channel === 'Email' && campaign['Status'] !== 'Ready') issues.push('Campaign is not Ready');
  if (campaign['Trigger'] === 'Scheduled' &&
      (!campaign['Send Date'] || !campaign['Send Time'])) {
    issues.push('Scheduled campaign is missing send date/time');
  }
  if (campaign['Trigger'] === 'New Lead') {
    issues.push('New Lead preview includes historical leads; do not bulk-send welcome messages');
  }
  if (channel === 'Email' && !campaignValidEmail_(lead['Email'])) {
    issues.push('Invalid email');
  }
  if (channel === 'Email' && /^(yes|true|1)$/i.test(lead['Email Opt Out'])) {
    issues.push('Lead opted out of email');
  }
  if (channel === 'SMS' && !campaignValidPhone_(lead['Phone'])) {
    issues.push('Invalid US phone number');
  }
  if (channel === 'SMS') issues.push(...smsPreviewIssues_(campaign,template,event,lead));
  if (language === 'EN' && !/^(english|en)$/i.test(lead['Preferred Language'])) {
    issues.push('Unknown language; defaulted to English');
  }
  return issues;
}

function campaignMessage_(campaign, template, channel, language) {
  const lang = language === 'ES' ? 'ES' : 'EN';
  const mode = campaign['Message Mode'];
  const subjectKey = 'Subject ' + lang + ' (custom/override)';
  const emailKey = 'Email Body ' + lang + ' (custom/override)';
  const smsKey = 'SMS ' + lang + ' (custom/override)';
  const templateSubjectKey = 'Email Subject ' + lang;
  const templateBodyKey = channel === 'Email' ? 'Email Body ' + lang : 'SMS Body ' + lang;
  const customSubject = campaign[subjectKey] || '';
  const customBody = campaign[channel === 'Email' ? emailKey : smsKey] || '';
  const templateSubject = template ? template[templateSubjectKey] || '' : '';
  const templateBody = template ? template[templateBodyKey] || '' : '';

  if (mode === 'Custom') return {subject: customSubject, body: customBody};
  if (mode === 'Template + Override') {
    return {subject: customSubject || templateSubject, body: customBody || templateBody};
  }
  return {subject: templateSubject, body: templateBody};
}

function campaignMergeValues_(campaign, event, lead, language) {
  const date = event ? event['Event Date'] : '';
  return {
    ParentName: lead['Parent Name'],
    StudentName: lead['Student Name'],
    Email: lead['Email'],
    Grade: lead['Current Grade'],
    CampaignName: campaign['Campaign Name'],
    EventName: event ? event['Event Name'] : '',
    EventDate: campaignLocalizeDate_(date, language),
    EventTime: event ? event['Start Time'] : '',
    EventEndTime: event ? event['End Time'] : '',
    EventLocation: event ? event['Location'] : '',
    EventAddress: event ? event['Address'] : '',
    RSVPLink: event ? event['RSVP Link'] : ''
  };
}

function campaignRender_(message, values) {
  const missing = [];
  const text = String(message || '').replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (whole, name) => {
      if (!Object.prototype.hasOwnProperty.call(values, name)) {
        missing.push('Unknown placeholder ' + whole);
        return whole;
      }
      const replacement = String(values[name] || '').trim();
      if (!replacement) {
        missing.push('Missing value for ' + whole);
        return whole;
      }
      return replacement;
    });
  if (!String(message || '').trim()) missing.push('Missing subject or message body');
  return {text, issues: missing};
}

function campaignEligible_(lead, audience) {
  if (String(lead['Active Lead']).trim().toLowerCase() !== 'yes') return false;
  if (audience === 'All Active Leads') return true;
  const applied = String(lead['Applied to Ednovate School']).trim().toLowerCase();
  if (audience === 'Applied') return applied === 'yes';
  if (audience === 'Not Applied') return applied === 'no';
  return false;
}

function campaignChannels_(value) {
  if (value === 'Email') return ['Email'];
  if (value === 'SMS') return ['SMS'];
  if (value === 'Both') return ['Email', 'SMS'];
  throw new Error('Unsupported channel: ' + value);
}

function campaignLanguage_(value) {
  const lang = String(value || '').trim().toLowerCase();
  return /^(es|español|espanol|spanish)/.test(lang) ? 'ES' : 'EN';
}

function campaignLocalizeDate_(input, language) {
  const value = String(input || '').trim();
  if (language !== 'ES' || !value) return value;
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio',
    'agosto','septiembre','octubre','noviembre','diciembre'];
  const short = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  let match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return Number(match[2]) + ' de ' + months[Number(match[1])-1] + ' de ' + match[3];
  match = value.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const index = short.indexOf(match[1].toLowerCase());
    if (index !== -1) return Number(match[2]) + ' de ' + months[index] + ' de ' + match[3];
  }
  return value;
}

function campaignValidEmail_(value) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(value || '').trim());
}
function campaignValidPhone_(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

function campaignRequirePreviewMode_() {
  if (getSetting_('CAMPAIGN_ENGINE_MODE') !== 'PREVIEW_ONLY') {
    throw new Error('Campaign engine must be in PREVIEW_ONLY mode.');
  }
}

function campaignSpreadsheet_() {
  if (typeof CRM === 'undefined' || !CRM.ID) {
    throw new Error('LeadIntake.gs with CRM.ID must be installed in this project.');
  }
  return SpreadsheetApp.openById(CRM.ID);
}

function campaignRead_(ss, tabName, expectedHeaders) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Required tab missing: ' + tabName);
  campaignAssertHeaders_(sheet, expectedHeaders);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, expectedHeaders.length)
    .getDisplayValues()
    .filter(row => row.some(v => String(v || '').trim() !== ''))
    .map(row => Object.fromEntries(expectedHeaders.map((header, index) =>
      [header, String(row[index] || '').trim()])));
}

function campaignAssertHeaders_(sheet, headers) {
  const actual = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  headers.forEach((header, i) => {
    if (String(actual[i]).trim() !== header) {
      throw new Error('Header mismatch in ' + sheet.getName() +
        ' column ' + (i + 1) + ': expected "' + header + '"');
    }
  });
}

function campaignCheckUniqueIds_(rows, field) {
  const ids = rows.map(row => row[field]).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate IDs in ' + field);
}

function campaignHeaders_() {
  return ['Campaign ID','Campaign Name','Trigger','Send Date','Send Time','Channel',
    'Audience','Message Mode','Template ID','Event ID','Event Name (auto)',
    'Event Date (auto)','Event Time (auto)','Event Location (auto)',
    'Subject EN (custom/override)','Email Body EN (custom/override)',
    'Subject ES (custom/override)','Email Body ES (custom/override)',
    'SMS EN (custom/override)','SMS ES (custom/override)','Enabled','Status',
    'Sent Count','Failed Count','Last Run At','Notes'];
}
function eventHeaders_() {
  return ['Event ID','Event Name','Event Type','Event Date','Start Time',
    'End Time','Time Zone','Location','Address','RSVP Link','Status','Notes'];
}
function templateHeaders_() {
  return ['Template ID','Template Name','Use Case','Email Subject EN',
    'Email Body EN','Email Subject ES','Email Body ES','SMS Body EN',
    'SMS Body ES','Status','Notes'];
}
function leadHeaders_() {
  return ['Lead ID','Created At','Parent Name','Student Name','Email','Phone',
    'Current Grade','Preferred Language','Source','Source Record ID',
    'Applied to Ednovate School','SchoolMint Status','Welcome Email Sent',
    'Welcome Email Sent At','Last Campaign Sent','Last Contact At',
    'Active Lead','Notes','Email Opt Out','Email Opt Out At'];
}
function previewHeaders_() {
  return ['Previewed At','Campaign ID','Campaign Name','Lead ID','Parent Name',
    'Recipient','Language','Channel','Subject','Message Preview','Check','Notes'];
}
function logHeaders_() {
  return ['Log ID','Lead ID','Campaign ID','Campaign Name','Channel',
    'Recipient','Sent At','Status','Error','Message ID'];
}
