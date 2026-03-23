// ─── database.js ─────────────────────────────────────────────────────────────
// SQLite-Datenbankschicht mit vollständigem Schema
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'database.sqlite');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function initialize() {
  const db = getDb();

  db.exec(`
    -- Sachbearbeiter / Benutzer
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT (datetime('now','localtime')),
      updated_at    DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Kundenstamm (Firma)
    CREATE TABLE IF NOT EXISTS customers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company     TEXT NOT NULL,
      notes       TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  DATETIME DEFAULT (datetime('now','localtime')),
      updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Ansprechpartner je Kunde
    CREATE TABLE IF NOT EXISTS contacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT,
      position    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Freigabe-Jobs
    CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid            TEXT NOT NULL UNIQUE,
      creator_id      INTEGER NOT NULL REFERENCES users(id),
      customer_id     INTEGER NOT NULL REFERENCES customers(id),
      contact_id      INTEGER NOT NULL REFERENCES contacts(id),
      job_name        TEXT NOT NULL,
      description     TEXT,
      internal_comment TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      visibility      TEXT NOT NULL DEFAULT 'team',
      current_version INTEGER NOT NULL DEFAULT 1,
      customer_comment TEXT,
      status_changed_at DATETIME,
      reminder_sent_at  DATETIME,
      reminder_count    INTEGER NOT NULL DEFAULT 0,
      access_token    TEXT NOT NULL UNIQUE,
      access_password TEXT,
      email_customer  INTEGER NOT NULL DEFAULT 1,
      email_creator   INTEGER NOT NULL DEFAULT 1,
      no_reminder     INTEGER NOT NULL DEFAULT 0,
      due_date        DATE,
      followup_date   DATE,
      followup_note   TEXT,
      created_at      DATETIME DEFAULT (datetime('now','localtime')),
      updated_at      DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- PDF-Versionen pro Job
    CREATE TABLE IF NOT EXISTS job_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      version_number  INTEGER NOT NULL,
      original_name   TEXT NOT NULL,
      stored_name     TEXT NOT NULL,
      file_size       INTEGER NOT NULL DEFAULT 0,
      mime_type       TEXT NOT NULL DEFAULT 'application/pdf',
      uploaded_by     INTEGER NOT NULL REFERENCES users(id),
      created_at      DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(job_id, version_number)
    );

    -- Multi-PDF: Einzelne Dateien pro Job und Version
    CREATE TABLE IF NOT EXISTS job_files (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      version_number  INTEGER NOT NULL DEFAULT 1,
      original_name   TEXT NOT NULL,
      stored_name     TEXT NOT NULL,
      file_size       INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      customer_comment TEXT,
      status_changed_at DATETIME,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Aktivitätsprotokoll (Audit Log)
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      details     TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Mail-Vorlagen (flexibles Event-System)
    CREATE TABLE IF NOT EXISTS mail_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      event       TEXT NOT NULL DEFAULT 'manual',
      recipient   TEXT NOT NULL DEFAULT 'customer',
      subject     TEXT NOT NULL,
      body_html   TEXT NOT NULL,
      body_text   TEXT NOT NULL,
      description TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      deletable   INTEGER NOT NULL DEFAULT 1,
      updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- App-Einstellungen
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Benachrichtigungen (In-App)
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id      INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,   -- 'approved' | 'rejected' | 'reminder' | 'version' | 'system'
      title       TEXT NOT NULL,
      message     TEXT,
      read        INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Webhooks für externe Integrationen
    CREATE TABLE IF NOT EXISTS webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      url         TEXT NOT NULL,
      events      TEXT NOT NULL DEFAULT 'all',
      method      TEXT NOT NULL DEFAULT 'POST',
      secret      TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      last_triggered DATETIME,
      last_status    INTEGER,
      created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- Indizes
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_creator ON jobs(creator_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_token ON jobs(access_token);
    CREATE INDEX IF NOT EXISTS idx_jobs_uuid ON jobs(uuid);
    CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);
    CREATE INDEX IF NOT EXISTS idx_versions_job ON job_versions(job_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
  `);

  // ─── Migrationen für bestehende Datenbanken ───────────────────────────
  const safeAlter = (sql) => { try { db.exec(sql); } catch {} };
  safeAlter("ALTER TABLE jobs ADD COLUMN access_password TEXT");
  safeAlter("ALTER TABLE jobs ADD COLUMN email_sent INTEGER NOT NULL DEFAULT 1");
  safeAlter("ALTER TABLE jobs ADD COLUMN email_customer INTEGER NOT NULL DEFAULT 1");
  safeAlter("ALTER TABLE jobs ADD COLUMN email_creator INTEGER NOT NULL DEFAULT 1");
  safeAlter("ALTER TABLE jobs ADD COLUMN no_reminder INTEGER NOT NULL DEFAULT 0");
  safeAlter("ALTER TABLE jobs ADD COLUMN due_date DATE");
  safeAlter("ALTER TABLE jobs ADD COLUMN followup_date DATE");
  safeAlter("ALTER TABLE jobs ADD COLUMN followup_note TEXT");
  safeAlter("ALTER TABLE webhooks ADD COLUMN method TEXT NOT NULL DEFAULT 'POST'");
  safeAlter("ALTER TABLE job_files ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1");
  safeAlter("ALTER TABLE mail_templates ADD COLUMN event TEXT NOT NULL DEFAULT 'manual'");
  safeAlter("ALTER TABLE mail_templates ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  safeAlter("ALTER TABLE mail_templates ADD COLUMN deletable INTEGER NOT NULL DEFAULT 1");
  safeAlter("ALTER TABLE mail_templates ADD COLUMN recipient TEXT NOT NULL DEFAULT 'customer'");

  // Neue Feature-Migrationen
  safeAlter("ALTER TABLE jobs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  safeAlter("ALTER TABLE jobs ADD COLUMN archived_at DATETIME");
  safeAlter("ALTER TABLE jobs ADD COLUMN expires_at DATETIME");
  safeAlter("ALTER TABLE jobs ADD COLUMN signature_required INTEGER NOT NULL DEFAULT 0");
  safeAlter("ALTER TABLE jobs ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'any'");

  // Neue Tabellen
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      job_name_prefix TEXT,
      description TEXT,
      internal_comment TEXT,
      visibility TEXT NOT NULL DEFAULT 'team',
      email_customer INTEGER NOT NULL DEFAULT 1,
      email_creator INTEGER NOT NULL DEFAULT 1,
      no_reminder INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS custom_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      field_key TEXT NOT NULL UNIQUE,
      field_type TEXT NOT NULL DEFAULT 'text',
      options TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS job_custom_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
      value TEXT,
      UNIQUE(job_id, field_id)
    );

    CREATE TABLE IF NOT EXISTS job_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      access_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      customer_comment TEXT,
      status_changed_at DATETIME,
      notified_at DATETIME,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS job_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      recipient_token TEXT NOT NULL,
      signer_name TEXT,
      signature_data TEXT NOT NULL,
      signed_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS customer_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_login DATETIME,
      password_reset_token TEXT,
      password_reset_expires DATETIME,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
  `);

  // Migration: email_sent → email_customer (alte Daten übernehmen)
  try { db.exec("UPDATE jobs SET email_customer = email_sent WHERE email_customer = 1 AND email_sent = 0"); } catch {}

  // Wiedervorlage-Template hinzufügen wenn noch nicht vorhanden
  try {
    const hasFollowup = db.prepare("SELECT id FROM mail_templates WHERE slug='followup_reminder'").get();
    if (!hasFollowup) {
      db.prepare(`INSERT INTO mail_templates (slug, name, event, recipient, subject, body_html, body_text, description, deletable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run('followup_reminder', 'Wiedervorlage-Erinnerung', 'followup', 'creator',
          'Wiedervorlage: {{job_name}}',
          '<h2>Wiedervorlage</h2><p>Guten Tag {{creator_name}},</p><p>für den Auftrag <strong>{{job_name}}</strong> ({{customer_company}}) ist eine Wiedervorlage fällig.</p>{{#if followup_note}}<p>Notiz: <em>{{followup_note}}</em></p>{{/if}}<p><a href="{{job_link}}" style="display:inline-block;padding:12px 32px;background:#6366f1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Zum Auftrag</a></p>',
          'Wiedervorlage: {{job_name}}\n\nAuftrag: {{job_name}} ({{customer_company}})\n{{#if followup_note}}Notiz: {{followup_note}}\n{{/if}}\nLink: {{job_link}}',
          'Interne Erinnerung an den Sachbearbeiter bei fälliger Wiedervorlage.');
    }
  } catch {}

  // ─── Standard-Admin anlegen ───────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPass  = process.env.ADMIN_PASS  || 'admin123';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPass, 12);
    db.prepare(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run('Administrator', adminEmail, hash);
    console.log(`[DB] Admin-Benutzer angelegt: ${adminEmail}`);
  }

  // ─── Standard Mail-Vorlagen ───────────────────────────────────────────────
  // Events: approval_created, approval_approved, approval_rejected,
  //         customer_confirmation, reminder, version_uploaded, manual
  const templates = [
    {
      slug: 'new_approval',
      name: 'Neue Freigabe',
      event: 'approval_created',
      recipient: 'customer',
      subject: 'Freigabe angefordert: {{job_name}}',
      description: 'Wird an den Kunden gesendet, wenn eine neue Freigabe erstellt wird.',
      deletable: 0,
      body_html: `<h2>Freigabe angefordert</h2>
<p>Guten Tag {{contact_name}},</p>
<p>für den Auftrag <strong>{{job_name}}</strong> liegt eine neue Druckfreigabe zur Prüfung vor.</p>
{{#if due_date}}<p>⏰ <strong>Fällig bis: {{due_date}}</strong></p>{{/if}}
{{#if description}}<p><em>Hinweis: {{description}}</em></p>{{/if}}
<p><a href="{{approval_link}}" style="display:inline-block;padding:12px 32px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Freigabe prüfen</a></p>
{{#if access_password}}<p>🔒 Passwort für den Zugang: <strong>{{access_password}}</strong></p>{{/if}}
<p>Bei Fragen wenden Sie sich an {{creator_name}} ({{creator_email}}).</p>
<p>Mit freundlichen Grüßen<br>{{company_name}}</p>`,
      body_text: `Freigabe angefordert\n\nGuten Tag {{contact_name}},\n\nfür den Auftrag "{{job_name}}" liegt eine neue Druckfreigabe zur Prüfung vor.\n{{#if due_date}}Fällig bis: {{due_date}}\n{{/if}}\nLink: {{approval_link}}\n{{#if access_password}}Passwort: {{access_password}}\n{{/if}}\nBei Fragen: {{creator_name}} ({{creator_email}})\n\nMit freundlichen Grüßen\n{{company_name}}`
    },
    {
      slug: 'approval_confirmed',
      name: 'Freigabe erteilt (an Sachbearbeiter)',
      event: 'approval_approved',
      recipient: 'creator',
      subject: '✅ Freigabe erteilt: {{job_name}}',
      description: 'Benachrichtigt den Sachbearbeiter über eine erteilte Freigabe.',
      deletable: 0,
      body_html: `<h2>✅ Freigabe erteilt</h2>
<p>Guten Tag {{creator_name}},</p>
<p>der Kunde <strong>{{contact_name}}</strong> ({{customer_company}}) hat die Freigabe für <strong>{{job_name}}</strong> erteilt.</p>
{{#if customer_comment}}<p>Kommentar: <em>{{customer_comment}}</em></p>{{/if}}
<p><a href="{{job_link}}" style="display:inline-block;padding:12px 32px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Zum Auftrag</a></p>`,
      body_text: `Freigabe erteilt\n\nKunde: {{contact_name}} ({{customer_company}})\nAuftrag: {{job_name}}\n{{#if customer_comment}}Kommentar: {{customer_comment}}{{/if}}\n\nLink: {{job_link}}`
    },
    {
      slug: 'approval_rejected',
      name: 'Freigabe abgelehnt (an Sachbearbeiter)',
      event: 'approval_rejected',
      recipient: 'creator',
      subject: '❌ Freigabe abgelehnt: {{job_name}}',
      description: 'Benachrichtigt den Sachbearbeiter über eine abgelehnte Freigabe.',
      deletable: 0,
      body_html: `<h2>❌ Freigabe abgelehnt</h2>
<p>Guten Tag {{creator_name}},</p>
<p>der Kunde <strong>{{contact_name}}</strong> ({{customer_company}}) hat die Freigabe für <strong>{{job_name}}</strong> leider abgelehnt.</p>
{{#if customer_comment}}<p>Kommentar: <em>{{customer_comment}}</em></p>{{/if}}
<p><a href="{{job_link}}" style="display:inline-block;padding:12px 32px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Zum Auftrag</a></p>`,
      body_text: `Freigabe abgelehnt\n\nKunde: {{contact_name}} ({{customer_company}})\nAuftrag: {{job_name}}\n{{#if customer_comment}}Kommentar: {{customer_comment}}{{/if}}\n\nLink: {{job_link}}`
    },
    {
      slug: 'customer_confirmation',
      name: 'Bestätigung für Kunde',
      event: 'customer_confirmation',
      recipient: 'customer',
      subject: 'Ihre Freigabe: {{job_name}}',
      description: 'Bestätigung an den Kunden nach Freigabe/Ablehnung.',
      deletable: 0,
      body_html: `<h2>Vielen Dank für Ihre Rückmeldung</h2>
<p>Guten Tag {{contact_name}},</p>
<p>wir bestätigen den Eingang Ihrer Rückmeldung zum Auftrag <strong>{{job_name}}</strong>.</p>
<p>Status: <strong>{{status_text}}</strong></p>
{{#if customer_comment}}<p>Ihr Kommentar: <em>{{customer_comment}}</em></p>{{/if}}
<p>Bei Fragen wenden Sie sich gerne an uns.</p>
<p>Mit freundlichen Grüßen<br>{{company_name}}</p>`,
      body_text: `Vielen Dank\n\nAuftrag: {{job_name}}\nStatus: {{status_text}}\n{{#if customer_comment}}Ihr Kommentar: {{customer_comment}}{{/if}}\n\nMit freundlichen Grüßen\n{{company_name}}`
    },
    {
      slug: 'reminder',
      name: 'Erinnerung',
      event: 'reminder',
      recipient: 'customer',
      subject: 'Erinnerung: Freigabe ausstehend für {{job_name}}',
      description: 'Automatische Erinnerung bei offenen Freigaben.',
      deletable: 0,
      body_html: `<h2>Freundliche Erinnerung</h2>
<p>Guten Tag {{contact_name}},</p>
<p>die Freigabe für den Auftrag <strong>{{job_name}}</strong> steht noch aus. Wir bitten Sie, diese zeitnah zu prüfen, damit wir mit der Produktion fortfahren können.</p>
{{#if due_date}}<p>⏰ <strong>Fällig bis: {{due_date}}</strong></p>{{/if}}
<p><a href="{{approval_link}}" style="display:inline-block;padding:12px 32px;background:#f59e0b;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Jetzt prüfen</a></p>
{{#if access_password}}<p>🔒 Passwort: <strong>{{access_password}}</strong></p>{{/if}}
<p>Mit freundlichen Grüßen<br>{{company_name}}</p>`,
      body_text: `Erinnerung: Freigabe ausstehend\n\nAuftrag: {{job_name}}\n{{#if due_date}}Fällig bis: {{due_date}}\n{{/if}}\nLink: {{approval_link}}\n{{#if access_password}}Passwort: {{access_password}}\n{{/if}}\nMit freundlichen Grüßen\n{{company_name}}`
    },
    {
      slug: 'portal_invite',
      name: 'Portal-Einladung',
      event: 'portal_invite',
      recipient: 'customer',
      subject: 'Ihr Zugang zum Kunden-Portal: {{company_name}}',
      description: 'Wird an Kunden gesendet, wenn ein Portal-Zugang angelegt wird.',
      deletable: 0,
      body_html: `<h2>Ihr Kunden-Portal-Zugang</h2>
<p>Guten Tag {{contact_name}},</p>
<p>wir haben für Sie einen persönlichen Zugang zum Kunden-Portal eingerichtet.</p>
<p><strong>Ihre Zugangsdaten:</strong></p>
<p>E-Mail: <strong>{{portal_email}}</strong><br>
Passwort: <strong>{{portal_password}}</strong></p>
<p><a href="{{portal_link}}" style="display:inline-block;padding:12px 32px;background:#4361ee;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Zum Portal</a></p>
<p>Bitte ändern Sie Ihr Passwort nach der ersten Anmeldung.</p>
<p>Mit freundlichen Grüßen<br>{{company_name}}</p>`,
      body_text: `Kunden-Portal-Zugang\n\nGuten Tag {{contact_name}},\n\nIhre Zugangsdaten:\nE-Mail: {{portal_email}}\nPasswort: {{portal_password}}\n\nPortal: {{portal_link}}\n\nMit freundlichen Grüßen\n{{company_name}}`
    },
    {
      slug: 'version_uploaded',
      name: 'Neue Version hochgeladen',
      event: 'version_uploaded',
      recipient: 'customer',
      subject: 'Neue Version: {{job_name}}',
      description: 'Wird an den Kunden gesendet wenn eine korrigierte Version hochgeladen wird.',
      deletable: 0,
      body_html: `<h2>Korrigierte Version verfügbar</h2>
<p>Guten Tag {{contact_name}},</p>
<p>für den Auftrag <strong>{{job_name}}</strong> wurde eine korrigierte Version bereitgestellt.</p>
{{#if description}}<p><em>Hinweis: {{description}}</em></p>{{/if}}
{{#if due_date}}<p>⏰ <strong>Fällig bis: {{due_date}}</strong></p>{{/if}}
<p><a href="{{approval_link}}" style="display:inline-block;padding:12px 32px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Neue Version prüfen</a></p>
{{#if access_password}}<p>🔒 Passwort: <strong>{{access_password}}</strong></p>{{/if}}
<p>Mit freundlichen Grüßen<br>{{company_name}}</p>`,
      body_text: `Neue Version: {{job_name}}\n\nGuten Tag {{contact_name}},\n\neine korrigierte Version steht bereit.\n\nLink: {{approval_link}}\n{{#if access_password}}Passwort: {{access_password}}\n{{/if}}\nMit freundlichen Grüßen\n{{company_name}}`
    }
  ];

  const insertTpl = db.prepare(`
    INSERT OR IGNORE INTO mail_templates (slug, name, event, recipient, subject, body_html, body_text, description, deletable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of templates) {
    insertTpl.run(t.slug, t.name, t.event, t.recipient || 'customer', t.subject, t.body_html, t.body_text, t.description, t.deletable);
  }

  // Events bei bestehenden Templates setzen (Migration)
  const eventMap = { new_approval:'approval_created', approval_confirmed:'approval_approved', approval_rejected:'approval_rejected', customer_confirmation:'customer_confirmation', reminder:'reminder' };
  for (const [slug, event] of Object.entries(eventMap)) {
    db.prepare("UPDATE mail_templates SET event=?, deletable=0 WHERE slug=? AND event='manual'").run(event, slug);
  }

  // Empfänger bei bestehenden Templates setzen (Migration)
  const recipientMap = { approval_confirmed:'creator', approval_rejected:'creator' };
  for (const [slug, recipient] of Object.entries(recipientMap)) {
    db.prepare("UPDATE mail_templates SET recipient=? WHERE slug=? AND recipient='customer'").run(recipient, slug);
  }

  // Standard-Einstellungen
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('company_name', 'Meine Firma GmbH');
  insertSetting.run('reminder_days', '3');
  insertSetting.run('max_reminders', '3');
  insertSetting.run('reminder_first_days', '3');
  insertSetting.run('reminder_interval_days', '1');
  insertSetting.run('reminder_max_count', '3');
  insertSetting.run('auto_archive_months', '0');
  insertSetting.run('auto_delete_months', '0');
  insertSetting.run('primary_color', '#4361ee');
  insertSetting.run('accent_color', '#2563eb');
  insertSetting.run('imprint', `<h1>Impressum</h1>
<h2>Angaben gemäß § 5 DDG</h2>
<p><strong>Meine Firma GmbH</strong><br>
Musterstraße 1<br>
12345 Musterstadt</p>

<h2>Vertreten durch</h2>
<p>Max Mustermann (Geschäftsführer)</p>

<h2>Kontakt</h2>
<p>Telefon: +49 123 456789<br>
E-Mail: info@meinefirma.de</p>

<h2>Registereintrag</h2>
<p>Eintragung im Handelsregister<br>
Registergericht: Amtsgericht Musterstadt<br>
Registernummer: HRB 12345</p>

<h2>Umsatzsteuer-ID</h2>
<p>Umsatzsteuer-Identifikationsnummer gemäß § 27 a Umsatzsteuergesetz:<br>
DE 123456789</p>

<h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
<p>Max Mustermann<br>
Musterstraße 1<br>
12345 Musterstadt</p>

<h2>Streitschlichtung</h2>
<p>Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:
<a href="https://ec.europa.eu/consumers/odr/" target="_blank">https://ec.europa.eu/consumers/odr/</a></p>
<p>Wir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>`);
  insertSetting.run('privacy_policy', `<h1>Datenschutzerklärung</h1>
<h2>1. Verantwortlicher</h2>
<p><strong>Meine Firma GmbH</strong><br>
Musterstraße 1<br>
12345 Musterstadt<br>
E-Mail: datenschutz@meinefirma.de</p>

<h2>2. Zweck der Datenverarbeitung</h2>
<p>Dieses Tool dient der digitalen Druckfreigabe. Wir verarbeiten Ihre Daten ausschließlich zur Abwicklung des Freigabeprozesses zwischen Ihnen und unserem Unternehmen (Art. 6 Abs. 1 lit. b DSGVO – Vertragserfüllung).</p>

<h2>3. Welche Daten werden verarbeitet?</h2>
<ul>
<li><strong>Name und E-Mail-Adresse</strong> – zur Zustellung des Freigabe-Links und Kommunikation</li>
<li><strong>Ihr Kommentar</strong> – falls Sie bei der Freigabe/Ablehnung eine Anmerkung hinterlassen</li>
<li><strong>Zeitstempel</strong> – wann die Freigabe erteilt oder abgelehnt wurde</li>
</ul>

<h2>4. Welche Daten werden NICHT verarbeitet?</h2>
<ul>
<li>Keine IP-Adressen</li>
<li>Kein Browser-Fingerprinting oder Tracking</li>
<li>Keine Weitergabe an Drittanbieter</li>
<li>Keine externen Dienste (Schriftarten, Analyse-Tools etc. werden lokal gehostet)</li>
</ul>

<h2>5. Cookies</h2>
<p>Dieses Tool verwendet ausschließlich technisch notwendige Cookies:</p>
<ul>
<li><strong>Sitzungs-Cookie (sid)</strong> – für die Funktionalität der Anwendung</li>
<li><strong>Sicherheits-Cookie (csrf-token)</strong> – zum Schutz vor Cross-Site-Request-Forgery</li>
</ul>
<p>Diese Cookies enthalten keine personenbezogenen Daten und werden nach Schließen des Browsers bzw. nach Ablauf der Sitzung gelöscht. Eine Einwilligung ist für technisch notwendige Cookies nicht erforderlich (§ 25 Abs. 2 TDDDG).</p>

<h2>6. Speicherdauer</h2>
<p>Ihre Daten werden für die Dauer des Auftragsverhältnisses gespeichert und anschließend gemäß den gesetzlichen Aufbewahrungsfristen aufbewahrt. Freigabeprotokolle werden entsprechend der handelsrechtlichen Aufbewahrungspflichten archiviert.</p>

<h2>7. Ihre Rechte</h2>
<p>Sie haben das Recht auf:</p>
<ul>
<li>Auskunft über Ihre gespeicherten Daten (Art. 15 DSGVO)</li>
<li>Berichtigung unrichtiger Daten (Art. 16 DSGVO)</li>
<li>Löschung Ihrer Daten (Art. 17 DSGVO)</li>
<li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
<li>Datenübertragbarkeit (Art. 20 DSGVO)</li>
<li>Widerspruch gegen die Verarbeitung (Art. 21 DSGVO)</li>
<li>Beschwerde bei einer Aufsichtsbehörde (Art. 77 DSGVO)</li>
</ul>

<h2>8. Kontakt</h2>
<p>Bei Fragen zum Datenschutz wenden Sie sich bitte an: <strong>datenschutz@meinefirma.de</strong></p>

<p><em>Stand: ${new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}</em></p>`);

  console.log('[DB] Datenbank initialisiert');
  return db;
}

module.exports = { getDb, closeDb, initialize };
