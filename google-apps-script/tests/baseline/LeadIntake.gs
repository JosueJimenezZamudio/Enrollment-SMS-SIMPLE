const CRM = Object.freeze({
  ID: '1KUmlLfCJIkrmui-FHDn3mnbqEJ0n2yp-QJwU-Ja-8x4',
  MASTER_TAB: 'Master Leads',
  SETTINGS_TAB: 'Settings',
  HEADERS: [
    'Lead ID', 'Created At', 'Parent Name', 'Student Name',
    'Email', 'Phone', 'Current Grade', 'Preferred Language',
    'Source', 'Source Record ID', 'Applied to Ednovate School',
    'SchoolMint Status', 'Welcome Email Sent', 'Welcome Email Sent At',
    'Last Campaign Sent', 'Last Contact At', 'Active Lead', 'Notes'
  ]
});

function handleOriginalFormSubmit(e) {
  if (!e || !e.source || !e.range) {
    throw new Error('Run this function through a real spreadsheet form submission.');
  }

  const sourceId = getSetting_('SOURCE_SPREADSHEET_ID');
  const sourceTab = getSetting_('SOURCE_TAB');
  if (e.source.getId() !== sourceId) return;
  if (e.range.getSheet().getName() !== sourceTab) return;
  if (e.range.getRow() < 2) return;

  const response = e.range.getSheet()
    .getRange(e.range.getRow(), 1, 1, 6).getDisplayValues()[0];

  const submittedDate = canonicalTimestamp_(response[0]).slice(0, 10);
  const cutoff = getSetting_('LEAD_CUTOFF_DATE');
  if (!cutoff) throw new Error('Missing LEAD_CUTOFF_DATE setting.');
  if (submittedDate < cutoff) return;

  const outcome = upsertLead_(googleFormLead_(response));
  console.log(JSON.stringify(outcome));

if (outcome.action === 'created') {
  try {
    welcomeImmediateAfterFormSubmit_(outcome, response);
  } catch (err) {
    console.error('Welcome email test: ' + err);
  }
}

}

function googleFormLead_(response) {
  return {
    source: 'Google Form',
    sourceRecordId: formFingerprint_(response),
    createdAt: response[0] || '',
    parentName: response[1] || '',
    studentName: '',
    email: normalizeEmail_(response[2]),
    phone: normalizePhone_(response[3]),
    currentGrade: response[4] || '',
    preferredLanguage: response[5] || ''
  };
}

// Stable only while the submission's timestamp and fields remain unchanged.
function formFingerprint_(response) {
  const canonical = [
    'Google Form',
    canonicalTimestamp_(response[0]),
    normalizeText_(response[1]),
    normalizeEmail_(response[2]),
    normalizePhone_(response[3]),
    normalizeText_(response[4]),
    normalizeText_(response[5])
  ].join('\u001F');

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonical,
    Utilities.Charset.UTF_8
  );
  const hex = digest.map(byte =>
    ('0' + (byte & 0xff).toString(16)).slice(-2)
  ).join('');
  return 'FORM-' + hex.slice(0, 32);
}

function upsertLead_(lead) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = SpreadsheetApp.openById(CRM.ID).getSheetByName(CRM.MASTER_TAB);
    if (!sheet) throw new Error('Master Leads tab not found.');
    verifyMasterHeaders_(sheet);

    const source = String(lead.source || '').trim();
    const sourceId = String(lead.sourceRecordId || '').trim();
    if (!source || !sourceId) {
      throw new Error('Source and Source Record ID are required.');
    }

    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const previous = sheet.getRange(2, 9, lastRow - 1, 2).getDisplayValues();
      const index = previous.findIndex(row =>
        row[0].trim() === source && row[1].trim() === sourceId
      );
      if (index !== -1) {
        return {
          action: 'already_exists',
          leadId: sheet.getRange(index + 2, 1).getDisplayValue(),
          crmRow: index + 2
        };
      }
    }

    const leadId = 'LEAD-' + Utilities.getUuid();
    const values = [
      leadId, lead.createdAt || '', lead.parentName || '',
      lead.studentName || '', normalizeEmail_(lead.email),
      normalizePhone_(lead.phone), lead.currentGrade || '',
      lead.preferredLanguage || '', source, sourceId,
      '', '', '', '', '', '', 'Yes', ''
    ];

    sheet.getRange(lastRow + 1, 1, 1, values.length).setValues([values]);
    SpreadsheetApp.flush();
    return { action: 'created', leadId, crmRow: lastRow + 1 };
  } finally {
    lock.releaseLock();
  }
}

function migrateExistingFormSourceIds() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const original = SpreadsheetApp.openById(getSetting_('SOURCE_SPREADSHEET_ID'));
    const source = original.getSheetByName(getSetting_('SOURCE_TAB'));
    const master = SpreadsheetApp.openById(CRM.ID).getSheetByName(CRM.MASTER_TAB);
    if (!source || !master) throw new Error('A required tab is missing.');
    verifyMasterHeaders_(master);

    const count = master.getLastRow() - 1;
    if (count <= 0) {
      console.log('No leads to migrate.');
      return;
    }
    const records = master.getRange(2, 1, count, 10).getDisplayValues();
    const resultIds = records.map(record => [record[9]]);
    let migrated = 0;

    records.forEach((record, i) => {
      if (record[8] !== 'Google Form') return;
      const priorId = String(record[9]).trim();
      if (!/^\d+$/.test(priorId)) return;

      const sourceRow = Number(priorId);
      if (sourceRow < 2 || sourceRow > source.getLastRow()) {
        throw new Error('Invalid source row for CRM row ' + (i + 2));
      }
      const originalCells = source.getRange(sourceRow, 1, 1, 6)
        .getDisplayValues()[0];

      const matches =
        canonicalTimestamp_(originalCells[0]) === canonicalTimestamp_(record[1]) &&
        normalizeText_(originalCells[1]) === normalizeText_(record[2]) &&
        normalizeEmail_(originalCells[2]) === normalizeEmail_(record[4]);
      if (!matches) {
        throw new Error('Source mismatch at CRM row ' + (i + 2) +
          '. No changes made.');
      }

      resultIds[i][0] = formFingerprint_(originalCells);
      migrated++;
    });

    const ids = records.map((record, i) =>
      String(record[8]).trim() + '\u001F' + String(resultIds[i][0]).trim()
    );
    if (new Set(ids).size !== ids.length) {
      throw new Error('Duplicate source record identifiers detected. No changes made.');
    }

    if (migrated) {
      master.getRange(2, 10, count, 1).setValues(resultIds);
      SpreadsheetApp.flush();
    }
    console.log('Migrated ' + migrated + ' existing Source Record IDs.');
  } finally {
    lock.releaseLock();
  }
}

function verifyCRMSetup() {
  const sourceId = getSetting_('SOURCE_SPREADSHEET_ID');
  const sourceTab = getSetting_('SOURCE_TAB');
  const source = SpreadsheetApp.openById(sourceId);
  if (!source.getSheetByName(sourceTab)) throw new Error('Source tab missing.');

  const master = SpreadsheetApp.openById(CRM.ID).getSheetByName(CRM.MASTER_TAB);
  if (!master) throw new Error('CRM Master Leads missing.');
  verifyMasterHeaders_(master);

  const matching = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === 'handleOriginalFormSubmit' &&
    trigger.getTriggerSourceId() === sourceId
  );
  console.log('Destination CRM: ' + CRM.ID);
  console.log('CRM leads: ' + (master.getLastRow() - 1));
  console.log('Matching triggers in THIS project: ' + matching.length);
  console.log('No email or SMS sending exists in this script.');
}

function installOriginalFormTrigger() {
  const sourceId = getSetting_('SOURCE_SPREADSHEET_ID');
  const matching = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === 'handleOriginalFormSubmit' &&
    trigger.getTriggerSourceId() === sourceId
  );
  if (matching.length) {
    console.log('Trigger already installed in this project.');
    return;
  }
  ScriptApp.newTrigger('handleOriginalFormSubmit')
    .forSpreadsheet(sourceId)
    .onFormSubmit()
    .create();
  console.log('Installed one spreadsheet form-submit trigger.');
}

function verifyMasterHeaders_(sheet) {
  const actual = sheet.getRange(1, 1, 1, CRM.HEADERS.length)
    .getDisplayValues()[0];
  for (let i = 0; i < CRM.HEADERS.length; i++) {
    if (String(actual[i]).trim() !== CRM.HEADERS[i]) {
      throw new Error('Master Leads header mismatch: column ' + (i + 1));
    }
  }
}

function getSetting_(key) {
  const sheet = SpreadsheetApp.openById(CRM.ID).getSheetByName(CRM.SETTINGS_TAB);
  if (!sheet) throw new Error('Settings tab missing.');
  const count = sheet.getLastRow() - 1;
  if (count < 1) return '';
  const found = sheet.getRange(2, 1, count, 2).getDisplayValues()
    .find(row => row[0] === key);
  return found ? String(found[1]).trim() : '';
}

function normalizeText_(v) {
  return String(v || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
function normalizeEmail_(v) { return String(v || '').trim().toLowerCase(); }
function normalizePhone_(v) {
  let value = String(v || '').replace(/\D/g, '');
  if (value.length === 11 && value.startsWith('1')) value = value.slice(1);
  return value;
}
function canonicalTimestamp_(v) {
  const input = String(v || '').trim();
  const parts = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*(AM|PM))?$/i);
  if (!parts) throw new Error('Unrecognized source timestamp: ' + input);
  let hour = Number(parts[4]);
  const ampm = (parts[7] || '').toUpperCase();
  if (ampm === 'AM') hour = hour % 12;
  if (ampm === 'PM') hour = (hour % 12) + 12;
  const pad = x => String(x).padStart(2, '0');
  return parts[3] + '-' + pad(parts[1]) + '-' + pad(parts[2]) + 'T' +
    pad(hour) + ':' + pad(parts[5]) + ':' + pad(parts[6] || '0');
}
