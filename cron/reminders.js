// ─── cron/reminders.js ───────────────────────────────────────────────────────
// Automatisches Mahnwesen + Wiedervorlagen
// Ausführen: node cron/reminders.js (oder per Cronjob)
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb, initialize } = require('../database');
const { sendMail, sendMailByEvent } = require('../mailer');

async function run() {
  initialize();
  const db = getDb();

  const reminderDays = parseInt(
    (db.prepare("SELECT value FROM settings WHERE key='reminder_days'").get() || {}).value || '3'
  );
  const maxReminders = parseInt(
    (db.prepare("SELECT value FROM settings WHERE key='max_reminders'").get() || {}).value || '3'
  );

  let baseUrl;
  try { baseUrl = db.prepare("SELECT value FROM settings WHERE key='base_url'").get()?.value; } catch {}
  baseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:3000';

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. KUNDEN-ERINNERUNGEN (offene Freigaben)
  // ═══════════════════════════════════════════════════════════════════════════
  const pendingJobs = db.prepare(`
    SELECT j.*,
      u.name AS creator_name, u.email AS creator_email,
      co.name AS contact_name, co.email AS contact_email,
      cu.company AS customer_company
    FROM jobs j
    JOIN users u ON u.id = j.creator_id
    JOIN contacts co ON co.id = j.contact_id
    JOIN customers cu ON cu.id = j.customer_id
    WHERE j.status = 'pending'
      AND j.email_customer = 1
      AND j.no_reminder = 0
      AND j.reminder_count < ?
      AND (
        (j.reminder_sent_at IS NULL AND julianday('now') - julianday(j.created_at) >= ?)
        OR
        (j.reminder_sent_at IS NOT NULL AND julianday('now') - julianday(j.reminder_sent_at) >= ?)
      )
  `).all(maxReminders, reminderDays, reminderDays);

  console.log(`[REMINDER] ${pendingJobs.length} Kunden-Erinnerungen fällig`);

  for (const job of pendingJobs) {
    const sent = await sendMailByEvent('reminder', {
      customer: job.contact_email,
      creator: job.email_creator ? job.creator_email : null,
    }, {
      contact_name: job.contact_name,
      job_name: job.job_name,
      customer_company: job.customer_company,
      approval_link: `${baseUrl}/approve/${job.access_token}`,
      access_password: job.access_password || '',
      due_date: job.due_date ? new Date(job.due_date).toLocaleDateString('de-DE') : '',
      creator_name: job.creator_name,
      creator_email: job.creator_email,
      job_link: `${baseUrl}/jobs/${job.uuid}`,
    });

    if (sent > 0) {
      db.prepare(`UPDATE jobs SET reminder_sent_at = datetime('now','localtime'), reminder_count = reminder_count + 1 WHERE id = ?`).run(job.id);
      db.prepare(`INSERT INTO audit_log (job_id, action, details) VALUES (?, 'reminder_sent', ?)`).run(job.id, `Erinnerung #${job.reminder_count + 1} an ${job.contact_email}`);
      console.log(`[REMINDER] → ${job.contact_email}: "${job.job_name}"`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. WIEDERVORLAGEN (interne Erinnerungen an Sachbearbeiter)
  // ═══════════════════════════════════════════════════════════════════════════
  const followups = db.prepare(`
    SELECT j.*,
      u.name AS creator_name, u.email AS creator_email,
      cu.company AS customer_company,
      co.name AS contact_name
    FROM jobs j
    JOIN users u ON u.id = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co ON co.id = j.contact_id
    WHERE j.followup_date IS NOT NULL
      AND j.followup_date <= date('now', 'localtime')
      AND j.status = 'pending'
  `).all();

  console.log(`[FOLLOWUP] ${followups.length} Wiedervorlagen fällig`);

  for (const job of followups) {
    // Mail an Sachbearbeiter
    if (job.email_creator) {
      await sendMailByEvent('followup', {
        customer: null,
        creator: job.creator_email,
      }, {
        creator_name: job.creator_name,
        job_name: job.job_name,
        customer_company: job.customer_company,
        contact_name: job.contact_name,
        followup_note: job.followup_note || '',
        job_link: `${baseUrl}/jobs/${job.uuid}`,
      });
    }

    // In-App-Benachrichtigung
    try {
      db.prepare(`INSERT INTO notifications (user_id, job_id, type, title, message) VALUES (?, ?, 'reminder', ?, ?)`)
        .run(job.creator_id, job.id,
          `Wiedervorlage: ${job.job_name}`,
          `${job.customer_company}${job.followup_note ? ' – ' + job.followup_note : ''}`);
    } catch {}

    // Wiedervorlage-Datum löschen (einmalig)
    db.prepare(`UPDATE jobs SET followup_date = NULL WHERE id = ?`).run(job.id);
    db.prepare(`INSERT INTO audit_log (job_id, user_id, action, details) VALUES (?, ?, 'followup_triggered', ?)`).run(job.id, job.creator_id, `Wiedervorlage ausgelöst${job.followup_note ? ': ' + job.followup_note : ''}`);
    console.log(`[FOLLOWUP] → ${job.creator_name}: "${job.job_name}"`);
  }

  console.log('[CRON] Fertig');
  process.exit(0);
}

run().catch(err => {
  console.error('[CRON] Fehler:', err);
  process.exit(1);
});
