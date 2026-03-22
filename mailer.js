// ─── mailer.js ───────────────────────────────────────────────────────────────
require('dotenv').config();
const nodemailer = require('nodemailer');

let transporter;

function getSetting(key, fallback) {
  try {
    const { getDb } = require('./database');
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return (row && row.value) ? row.value : fallback;
  } catch {
    return fallback;
  }
}

function createTransporter() {
  const host = getSetting('smtp_host', process.env.SMTP_HOST || 'localhost');
  const port = parseInt(getSetting('smtp_port', process.env.SMTP_PORT || '587'));
  const user = getSetting('smtp_user', process.env.SMTP_USER || '');
  const pass = getSetting('smtp_pass', process.env.SMTP_PASS || '');

  const config = { host, port, secure: port === 465 };

  if (user) {
    config.auth = { user, pass };
  }

  if (host === 'localhost' && port === 25) {
    config.secure = false;
    config.tls = { rejectUnauthorized: false };
  }

  console.log(`[MAIL] Transporter: ${host}:${port} (${user || 'keine Auth'})`);
  return nodemailer.createTransport(config);
}

function getTransporter() {
  if (!transporter) transporter = createTransporter();
  return transporter;
}

function reloadTransporter() {
  transporter = createTransporter();
  console.log('[MAIL] Transporter neu geladen');
}

// Einfache Template-Engine
function renderTemplate(template, vars) {
  let result = template;
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => {
    return vars[key] ? content : '';
  });
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return result;
}

async function sendMail(templateSlug, recipientEmail, vars) {
  try {
    const { getDb } = require('./database');
    const db = getDb();

    const template = db.prepare('SELECT * FROM mail_templates WHERE slug = ? AND active = 1').get(templateSlug);
    if (!template) {
      console.error(`[MAIL] Template nicht gefunden oder inaktiv: ${templateSlug}`);
      return false;
    }

    return await _sendTemplate(template, recipientEmail, vars);
  } catch (err) {
    console.error(`[MAIL] Fehler bei ${recipientEmail}:`, err.message);
    return false;
  }
}

/**
 * Sendet alle aktiven Vorlagen für ein Ereignis
 * Routet automatisch an den richtigen Empfänger (Kunde/Sachbearbeiter)
 * @param {string} event - z.B. 'approval_created', 'approval_approved'
 * @param {object} recipients - { customer: 'kunde@email.de', creator: 'sachbearbeiter@email.de' }
 * @param {object} vars - Template-Variablen
 * @returns {number} Anzahl gesendeter Mails
 */
async function sendMailByEvent(event, recipients, vars) {
  try {
    const { getDb } = require('./database');
    const db = getDb();

    const templates = db.prepare('SELECT * FROM mail_templates WHERE event = ? AND active = 1').all(event);
    if (templates.length === 0) {
      console.log(`[MAIL] Keine aktiven Vorlagen für Event: ${event}`);
      return 0;
    }

    // Abwärtskompatibilität: wenn recipients ein String ist → als customer behandeln
    if (typeof recipients === 'string') {
      recipients = { customer: recipients, creator: recipients };
    }

    let sent = 0;
    for (const template of templates) {
      const target = template.recipient || 'customer';
      let email;

      if (target === 'customer') email = recipients.customer;
      else if (target === 'creator') email = recipients.creator;
      else if (target === 'both') email = null; // Sende an beide
      else email = recipients.customer;

      if (target === 'both') {
        if (recipients.customer) { const ok = await _sendTemplate(template, recipients.customer, vars); if (ok) sent++; }
        if (recipients.creator && recipients.creator !== recipients.customer) { const ok = await _sendTemplate(template, recipients.creator, vars); if (ok) sent++; }
      } else if (email) {
        const ok = await _sendTemplate(template, email, vars);
        if (ok) sent++;
      }
    }
    return sent;
  } catch (err) {
    console.error(`[MAIL] Event-Fehler (${event}):`, err.message);
    return 0;
  }
}

async function _sendTemplate(template, recipientEmail, vars) {
  try {
    vars.company_name = vars.company_name || getSetting('company_name', 'Unternehmen');

    // Automatische Variablen
    const baseUrl = getSetting('base_url', process.env.BASE_URL || 'http://localhost:3000');
    vars.privacy_link = vars.privacy_link || `${baseUrl}/datenschutz`;
    vars.imprint_link = vars.imprint_link || `${baseUrl}/impressum`;
    vars.base_url = vars.base_url || baseUrl;

    const subject = renderTemplate(template.subject, vars);
    let html    = renderTemplate(template.body_html, vars);
    const text    = renderTemplate(template.body_text, vars) + `\n\nImpressum: ${vars.imprint_link}\nDatenschutz: ${vars.privacy_link}`;

    // Impressum + Datenschutz Footer an HTML anhängen
    html += `\n<p style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;"><a href="${vars.imprint_link}" style="color:#9ca3af;">Impressum</a> · <a href="${vars.privacy_link}" style="color:#9ca3af;">Datenschutzerklärung</a></p>`;

    const fromName = getSetting('smtp_from_name', process.env.SMTP_FROM_NAME || 'PDF-Freigabe');
    const fromAddr = getSetting('smtp_from', process.env.SMTP_FROM || 'freigabe@localhost');

    const info = await getTransporter().sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to: recipientEmail,
      subject, html, text,
    });

    console.log(`[MAIL] Gesendet an ${recipientEmail}: ${subject} (${info.messageId})`);
    return true;
  } catch (err) {
    console.error(`[MAIL] Fehler bei ${recipientEmail}:`, err.message);
    return false;
  }
}

module.exports = { sendMail, sendMailByEvent, getTransporter, reloadTransporter, renderTemplate };
