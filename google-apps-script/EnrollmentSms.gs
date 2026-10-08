function queueEnrollmentSms_(input) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('SMS_EDGE_FUNCTION_URL');
  const secret = props.getProperty('SMS_INGEST_SECRET');

  if (!url || !secret) {
    throw new Error('Missing SMS_EDGE_FUNCTION_URL or SMS_INGEST_SECRET in Script Properties.');
  }

  const payload = {
    phone: input.phone,
    message: input.message,
    leadId: input.leadId || null,
    eventType: input.eventType || null,
    dedupeKey: input.dedupeKey || null,
    scheduledAt: input.scheduledAt || new Date().toISOString()
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-enrollment-sms-secret': secret
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  let body = {};
  try { body = JSON.parse(text); } catch (e) {}

  if (code < 200 || code >= 300) {
    throw new Error('SMS queue request failed (' + code + '): ' + text);
  }

  return body;
}

function testEnrollmentSms_() {
  const result = queueEnrollmentSms_({
    phone: 'REPLACE_WITH_YOUR_PHONE',
    message: 'Test from the enrollment messaging system.',
    leadId: 'manual-test',
    eventType: 'manual_test',
    dedupeKey: 'manual-test-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss')
  });
  Logger.log(JSON.stringify(result));
}
