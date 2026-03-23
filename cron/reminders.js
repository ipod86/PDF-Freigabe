// ─── cron/reminders.js ───────────────────────────────────────────────────────
// Automatisches Mahnwesen + Wiedervorlagen + Auto-Archivierung + Auto-Löschung
// Ausführen: node cron/reminders.js (oder per Cronjob)
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb, initialize } = require('../database');
const { sendMail, sendMailByEvent } = require('../mailer');

async function run() {
  initialize();
  const db = getDb();

  const firstDays = parseInt(
    (db.prepare("SELECT value FROM settings WHERE key='reminder_first_days'").get() || {}).value || '3'
  );
  const intervalDays = parseInt(
    (db.prepare("SELECT value FROM settings WHERE key='reminder_interval_days'").get() || {}).value || '1'
  );
  const maxCount = parseInt(
    (db.prepare("SELECT value FROM settings WHERE key='reminder_max_count'").get() || {}).value || '3'
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
      AND j.archived = 0
      AND j.reminder_count < ?
      AND (
        (j.reminder_count = 0 AND julianday('now') - julianday(j.created_at) >= ?)
        OR
        (j.reminder_count > 0 AND julianday('now') - julianday(j.reminder_sent_at) >= ?)
      )
  `).all(maxCount, firstDays, intervalDays);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. AUTO-ARCHIVIERUNG
  // ═══════════════════════════════════════════════════════════════════════════
  const autoArchiveMonths = parseInt(db.prepare("SELECT value FROM settings WHERE key='auto_archive_months'").get()?.value || '0');
  if (autoArchiveMonths > 0) {
    const archived = db.prepare(`
      UPDATE jobs SET archived=1, archived_at=datetime('now','localtime')
      WHERE archived=0 AND status != 'pending'
      AND julianday('now') - julianday(created_at) >= ?
    `).run(autoArchiveMonths * 30);
    if (archived.changes > 0) console.log(`[CLEANUP] ${archived.changes} Jobs archiviert`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. AUTO-LÖSCHUNG archivierter Jobs
  // ═══════════════════════════════════════════════════════════════════════════
  const autoDeleteMonths = parseInt(db.prepare("SELECT value FROM settings WHERE key='auto_delete_months'").get()?.value || '0');
  if (autoDeleteMonths > 0) {
    const toDelete = db.prepare(`
      SELECT id FROM jobs WHERE archived=1
      AND julianday('now') - julianday(archived_at) >= ?
    `).all(autoDeleteMonths * 30);

    const UPLOAD_DIR = process.env.UPLOAD_DIR || require('path').join(__dirname, '..', 'uploads');
    const fs = require('fs');

    for (const job of toDelete) {
      const versions = db.prepare('SELECT stored_name FROM job_versions WHERE job_id = ?').all(job.id);
      for (const v of versions) {
        const fp = require('path').join(UPLOAD_DIR, v.stored_name);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
      }
      db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    }
    if (toDelete.length > 0) console.log(`[CLEANUP] ${toDelete.length} Jobs gelöscht`);
  }

  console.log('[CRON] Fertig');
  process.exit(0);
}

run().catch(err => {
  console.error('[CRON] Fehler:', err);
  process.exit(1);
});
