// Secure alerting module — Gmail SMTP + Twilio SMS
const nodemailer = require('nodemailer');
const https = require('https');

// Create Gmail transporter (checks env vars first, then could be overridden)
function getMailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (pass.length < 8) return null; // App passwords are 16 chars
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    secure: true
  });
}

// Send email alert
async function sendEmail(subject, htmlBody) {
  const transporter = getMailTransporter();
  if (!transporter) {
    console.log('  ⚠️  Email alert skipped — GMAIL_USER or GMAIL_APP_PASSWORD not set');
    return false;
  }
  const recipients = (process.env.ALERT_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    console.log('  ⚠️  Email alert skipped — no ALERT_EMAILS configured');
    return false;
  }
  try {
    await transporter.sendMail({
      from: '"IT Services Monitor" <' + process.env.GMAIL_USER + '>',
      to: recipients.join(', '),
      subject: subject,
      html: htmlBody
    });
    console.log('  📧 Email sent to:', recipients.join(', '));
    return true;
  } catch (e) {
    console.error('  ❌ Email error:', e.message);
    return false;
  }
}

// Send SMS via Twilio REST API (no SDK needed — more secure, fewer dependencies)
async function sendSMS(message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.log('  ⚠️  SMS alert skipped — Twilio credentials not set');
    return false;
  }
  const phones = (process.env.ALERT_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
  if (phones.length === 0) {
    console.log('  ⚠️  SMS alert skipped — no ALERT_PHONES configured');
    return false;
  }

  let allSent = true;
  for (const to of phones) {
    try {
      const postData = 'To=' + encodeURIComponent(to) + '&From=' + encodeURIComponent(from) + '&Body=' + encodeURIComponent(message);
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.twilio.com',
          port: 443,
          path: '/2010-04-01/Accounts/' + sid + '/Messages.json',
          method: 'POST',
          auth: sid + ':' + token,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('  📱 SMS sent to:', to);
              resolve(true);
            } else {
              console.error('  ❌ SMS error for', to, ':', body);
              resolve(false);
            }
          });
        });
        req.on('error', (e) => { console.error('  ❌ SMS request error:', e.message); resolve(false); });
        req.write(postData);
        req.end();
      });
    } catch (e) {
      console.error('  ❌ SMS failed for', to, ':', e.message);
      allSent = false;
    }
  }
  return allSent;
}

// Send monitoring alert (both email + SMS)
async function sendMonitorAlert(monitor, result) {
  const isDown = result.status === 'down';
  const emoji = isDown ? '🔴' : '✅';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';
  const time = new Date().toLocaleString();

  // Email (HTML)
  const subject = emoji + ' [' + statusText + '] ' + monitor.name + ' (' + (monitor.target || 'unknown') + ')';
  const html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">' +
    '<div style="background:' + (isDown ? '#fee2e2' : '#d1fae5') + ';border-left:4px solid ' + (isDown ? '#ef4444' : '#10b981') + ';padding:16px;border-radius:0 8px 8px 0;margin-bottom:16px;">' +
    '<h2 style="margin:0 0 8px;color:' + (isDown ? '#991b1b' : '#065f46') + ';">' + emoji + ' Monitor ' + statusText + '</h2>' +
    '<p style="margin:0;font-size:14px;color:#374151;"><strong>' + (monitor.name || '') + '</strong></p></div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
    '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Target</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">' + (monitor.target || '—') + '</td></tr>' +
    '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Type</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;">' + (monitor.type || '—') + '</td></tr>' +
    '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Status</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:700;color:' + (isDown ? '#ef4444' : '#10b981') + ';">' + statusText + '</td></tr>' +
    '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Response Time</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;">' + (result.responseMs || 0) + 'ms</td></tr>' +
    (result.error ? '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Error</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#ef4444;">' + result.error + '</td></tr>' : '') +
    '<tr><td style="padding:8px;color:#6b7280;">Time</td><td style="padding:8px;">' + time + '</td></tr>' +
    '</table>' +
    '<p style="margin-top:16px;font-size:12px;color:#9ca3af;">— IT Services Manager Monitoring</p></div>';

  // SMS (plain text, short)
  const sms = emoji + ' ' + statusText + ': ' + (monitor.name || '') + ' (' + (monitor.target || '') + ')' +
    (result.error ? ' — ' + result.error : '') + ' at ' + time;

  // Send both in parallel
  const [emailOk, smsOk] = await Promise.all([
    sendEmail(subject, html),
    sendSMS(sms)
  ]);

  return { emailOk, smsOk };
}

module.exports = { sendEmail, sendSMS, sendMonitorAlert };
