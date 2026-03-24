// ─── routes/approve.js ───────────────────────────────────────────────────────
// Öffentliches Kunden-Interface für Freigabe/Ablehnung
// ──────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const { getDb } = require('../database');
const { sendMail, sendMailByEvent } = require('../mailer');

let notifyApproval, triggerWebhooks;
try { notifyApproval = require('../notifications').notifyApproval; } catch {}
try { triggerWebhooks = require('./webhooks').triggerWebhooks; } catch {}

// ─── Hilfsfunktion: Job laden ───────────────────────────────────────────────
function loadJob(token) {
  const db = getDb();
  return db.prepare(`
    SELECT j.*,
      u.name AS creator_name, u.email AS creator_email,
      cu.company AS customer_company,
      co.name AS contact_name, co.email AS contact_email
    FROM jobs j
    JOIN users u      ON u.id  = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co  ON co.id = j.contact_id
    WHERE j.access_token = ?
  `).get(token);
}

// ─── Hilfsfunktion: Job anhand Recipient-Token laden ────────────────────────
function loadJobByRecipientToken(token) {
  const db = getDb();
  return db.prepare(`
    SELECT j.*,
      u.name AS creator_name, u.email AS creator_email,
      cu.company AS customer_company,
      co.name AS contact_name, co.email AS contact_email,
      jr.id AS recipient_id, jr.status AS recipient_status, jr.access_token AS recipient_token
    FROM job_recipients jr
    JOIN jobs j ON j.id = jr.job_id
    JOIN users u ON u.id = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co ON co.id = jr.contact_id
    WHERE jr.access_token = ?
  `).get(token);
}

// ─── Passwort-Seite ─────────────────────────────────────────────────────────
router.get('/:token/auth', (req, res) => {
  const job = loadJob(req.params.token);
  if (!job) return res.status(404).render('approve/not_found', { title: 'Nicht gefunden', user: null });

  const companyRow = getDb().prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  const logoRow = getDb().prepare("SELECT value FROM settings WHERE key = 'company_logo'").get();
  res.render('approve/password', {
    title: `Zugang: ${job.job_name}`,
    token: req.params.token,
    jobName: job.job_name,
    companyName: companyRow ? companyRow.value : 'Unternehmen',
    companyLogo: logoRow ? logoRow.value : null,
    error: req.query.error === '1',
    user: null,
  });
});

router.post('/:token/auth', (req, res) => {
  const job = loadJob(req.params.token);
  if (!job) return res.status(404).render('approve/not_found', { title: 'Nicht gefunden', user: null });

  if (req.body.password === job.access_password) {
    // Passwort korrekt → in Session merken
    if (!req.session.approvedTokens) req.session.approvedTokens = [];
    req.session.approvedTokens.push(req.params.token);
    req.session.save(() => {
      res.redirect(`/approve/${req.params.token}`);
    });
  } else {
    res.redirect(`/approve/${req.params.token}/auth?error=1`);
  }
});

// ─── Kunden-Seite anzeigen ──────────────────────────────────────────────────
router.get('/:token', (req, res) => {
  const db = getDb();
  let job = loadJob(req.params.token);
  let isRecipientToken = false;

  if (!job) {
    // Versuche als Recipient-Token
    job = loadJobByRecipientToken(req.params.token);
    if (job) isRecipientToken = true;
  }

  if (!job) {
    return res.status(404).render('approve/not_found', { title: 'Nicht gefunden', user: null, reason: null });
  }

  // Ablaufdatum prüfen
  if (job.expires_at && new Date(job.expires_at) < new Date()) {
    return res.status(410).render('approve/not_found', { title: 'Link abgelaufen', reason: 'expired', user: null });
  }

  // Portal-Login: Passwort überspringen wenn Kunde eingeloggt und zum Job gehört
  const portalUser = req.session?.customerUser;
  const portalSkipPassword = portalUser && portalUser.customer_id === job.customer_id;

  // Passwort-Prüfung
  if (job.access_password && !portalSkipPassword) {
    const approved = req.session?.approvedTokens || [];
    if (!approved.includes(req.params.token)) {
      return res.redirect(`/approve/${req.params.token}/auth`);
    }
  }

  // Version-Infos
  const currentVersion = db.prepare(`
    SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?
  `).get(job.id, job.current_version);

  const allVersions = db.prepare(`
    SELECT version_number, created_at FROM job_versions WHERE job_id = ? ORDER BY version_number DESC
  `).all(job.id);

  // Audit: Kunde hat geöffnet
  db.prepare(`
    INSERT INTO audit_log (job_id, action, details)
    VALUES (?, 'customer_viewed', ?)
  `).run(job.id, `Kunden-Seite geöffnet von ${job.contact_name}`);

  const companyRow = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  const logoRow = db.prepare("SELECT value FROM settings WHERE key = 'company_logo'").get();

  // Multi-Dateien (nur aktuelle Version)
  let files = [];
  try { files = db.prepare('SELECT * FROM job_files WHERE job_id = ? AND version_number = ? ORDER BY sort_order').all(job.id, job.current_version); } catch {}

  const primaryColor = db.prepare("SELECT value FROM settings WHERE key = 'primary_color'").get()?.value || '#4361ee';
  const accentColor = db.prepare("SELECT value FROM settings WHERE key = 'accent_color'").get()?.value || '#2563eb';

  // Unterschrift prüfen
  let existingSignature = null;
  try { existingSignature = db.prepare('SELECT * FROM job_signatures WHERE job_id = ? AND recipient_token = ?').get(job.id, req.params.token); } catch {}

  res.render('approve/index', {
    title: `Freigabe: ${job.job_name}`,
    job,
    currentVersion,
    allVersions,
    files,
    companyName: companyRow ? companyRow.value : 'Unternehmen',
    companyLogo: logoRow ? logoRow.value : null,
    primaryColor,
    accentColor,
    existingSignature,
    isRecipientToken,
    user: null,
  });
});

// ─── Unterschrift speichern ──────────────────────────────────────────────────
router.post('/:token/sign', (req, res) => {
  const db = getDb();
  let job = loadJob(req.params.token);
  if (!job) job = loadJobByRecipientToken(req.params.token);
  if (!job) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!job.signature_required) return res.status(400).json({ error: 'Keine Unterschrift erforderlich' });

  const { signature_data, signer_name } = req.body;
  if (!signature_data || !signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Ungültige Unterschriftsdaten' });
  }

  // Größenlimit: max 2MB
  if (signature_data.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'Unterschrift zu groß' });
  }

  db.prepare(`
    INSERT OR REPLACE INTO job_signatures (job_id, recipient_token, signer_name, signature_data)
    VALUES (?, ?, ?, ?)
  `).run(job.id, req.params.token, signer_name || null, signature_data);

  res.json({ success: true });
});

// ─── Freigabe / Ablehnung verarbeiten ───────────────────────────────────────
router.post('/:token', (req, res) => {
  const db = getDb();
  const { action, comment } = req.body;
  let job = loadJob(req.params.token);
  let isRecipientToken = false;
  if (!job) {
    job = loadJobByRecipientToken(req.params.token);
    if (job) isRecipientToken = true;
  }

  if (!job) return res.status(404).json({ error: 'Nicht gefunden' });

  // Ablaufdatum prüfen
  if (job.expires_at && new Date(job.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Link abgelaufen' });
  }

  // Bei Recipient-Token: recipient status prüfen
  if (isRecipientToken) {
    if (job.recipient_status !== 'pending') return res.status(400).json({ error: 'Bereits bearbeitet.' });
  } else {
    if (job.status !== 'pending') return res.status(400).json({ error: 'Bereits bearbeitet.' });
  }

  // Passwort-Prüfung
  if (job.access_password) {
    const approved = req.session?.approvedTokens || [];
    if (!approved.includes(req.params.token)) {
      return res.status(403).json({ error: 'Nicht autorisiert.' });
    }
  }

  // Unterschrift-Pflicht prüfen
  if (job.signature_required) {
    const sig = db.prepare('SELECT id FROM job_signatures WHERE job_id = ? AND recipient_token = ?').get(job.id, req.params.token);
    if (!sig) {
      return res.status(400).json({ error: 'Bitte zuerst unterschreiben.' });
    }
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  const statusText = status === 'approved' ? 'Freigegeben' : 'Abgelehnt';

  if (isRecipientToken) {
    // Nur recipient-Status aktualisieren
    db.prepare(`UPDATE job_recipients SET status=?, customer_comment=?, status_changed_at=datetime('now','localtime') WHERE access_token=?`).run(status, comment || null, req.params.token);

    // Gesamtstatus berechnen (approval_mode)
    const allRecipients = db.prepare('SELECT status FROM job_recipients WHERE job_id=?').all(job.id);
    const mainJob = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
    let newJobStatus = null;

    if (mainJob.approval_mode === 'any') {
      // Einer genehmigt reicht
      if (allRecipients.some(r => r.status === 'approved')) newJobStatus = 'approved';
      else if (allRecipients.every(r => r.status === 'rejected')) newJobStatus = 'rejected';
    } else {
      // Alle müssen genehmigen
      if (allRecipients.every(r => r.status === 'approved')) newJobStatus = 'approved';
      else if (allRecipients.some(r => r.status === 'rejected')) newJobStatus = 'rejected';
    }

    if (newJobStatus) {
      db.prepare(`UPDATE jobs SET status=?, customer_comment=?, status_changed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(newJobStatus, comment || null, job.id);
    }
  } else {
    db.prepare(`
      UPDATE jobs SET status = ?, customer_comment = ?,
      status_changed_at = datetime('now','localtime'),
      updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(status, comment || null, job.id);
  }

  db.prepare(`
    INSERT INTO audit_log (job_id, action, details)
    VALUES (?, ?, ?)
  `).run(job.id, `customer_${status}`, `${job.contact_name} hat ${statusText.toLowerCase()}: ${comment || '(kein Kommentar)'}`);

  let baseUrl;
  try { const r = db.prepare("SELECT value FROM settings WHERE key='base_url'").get(); baseUrl = r?.value; } catch {}
  baseUrl = baseUrl || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  const mailVars = {
    creator_name: job.creator_name, contact_name: job.contact_name,
    customer_company: job.customer_company, job_name: job.job_name,
    customer_comment: comment || '', status_text: statusText,
    access_password: job.access_password || '',
    job_link: `${baseUrl}/jobs/${job.uuid}`,
    approval_link: `${baseUrl}/approve/${job.access_token}`,
    due_date: job.due_date ? new Date(job.due_date).toLocaleDateString('de-DE') : '',
  };

  const mailRecipients = {
    customer: job.email_customer ? job.contact_email : null,
    creator: job.email_creator ? job.creator_email : null,
  };

  // Mails senden (Templates bestimmen automatisch den Empfänger)
  const event = status === 'approved' ? 'approval_approved' : 'approval_rejected';
  sendMailByEvent(event, mailRecipients, mailVars);
  sendMailByEvent('customer_confirmation', mailRecipients, mailVars);

  db.prepare(`
    INSERT INTO audit_log (job_id, action, details)
    VALUES (?, 'email_sent', ?)
  `).run(job.id, `Benachrichtigungen versendet (${statusText})`);

  // In-App-Benachrichtigung
  if (notifyApproval) notifyApproval(job, status, comment);

  // Webhooks
  if (triggerWebhooks) triggerWebhooks(status, {
    job_id: job.id, job_uuid: job.uuid, job_name: job.job_name, status,
    customer_company: job.customer_company, contact_name: job.contact_name,
    comment: comment || null,
  });

  res.json({ success: true, status, statusText });
});

// ─── Einzeldatei-Freigabe (Multi-PDF) ───────────────────────────────────────
router.post('/:token/file/:fileId', (req, res) => {
  const db = getDb();
  const { action, comment } = req.body;
  const job = loadJob(req.params.token);  // Voller JOIN mit creator_email, contact_name etc.
  if (!job) return res.status(404).json({ error: 'Nicht gefunden' });

  // Passwort-Gate
  if (job.access_password) {
    const approved = req.session?.approvedTokens || [];
    if (!approved.includes(req.params.token)) return res.status(403).json({ error: 'Nicht autorisiert.' });
  }

  const fileId = parseInt(req.params.fileId);
  const file = db.prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(fileId, job.id);
  if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });
  if (file.status !== 'pending') return res.status(400).json({ error: 'Bereits bearbeitet.' });

  const status = action === 'approve' ? 'approved' : 'rejected';
  db.prepare(`UPDATE job_files SET status = ?, customer_comment = ?, status_changed_at = datetime('now','localtime') WHERE id = ?`).run(status, comment || null, fileId);

  db.prepare(`INSERT INTO audit_log (job_id, action, details) VALUES (?, ?, ?)`).run(
    job.id, `file_${status}`, `${file.original_name}: ${status === 'approved' ? 'freigegeben' : 'abgelehnt'}${comment ? ' – ' + comment : ''}`
  );

  // Prüfen ob alle Dateien der aktuellen Version bearbeitet sind
  const pending = db.prepare('SELECT COUNT(*) AS c FROM job_files WHERE job_id = ? AND version_number = ? AND status = ?').get(job.id, job.current_version, 'pending').c;
  const anyRejected = db.prepare('SELECT COUNT(*) AS c FROM job_files WHERE job_id = ? AND version_number = ? AND status = ?').get(job.id, job.current_version, 'rejected').c > 0;

  let jobComplete = false;
  if (pending === 0) {
    // Alle bearbeitet → Gesamtstatus setzen
    const finalStatus = anyRejected ? 'rejected' : 'approved';
    const finalText = finalStatus === 'approved' ? 'Freigegeben' : 'Abgelehnt';
    db.prepare(`UPDATE jobs SET status = ?, status_changed_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`).run(finalStatus, job.id);
    jobComplete = true;

    // E-Mails senden
    let baseUrl;
    try { const r = db.prepare("SELECT value FROM settings WHERE key='base_url'").get(); baseUrl = r?.value || process.env.BASE_URL; } catch {}
    baseUrl = baseUrl || `http://localhost:${process.env.PORT || 3000}`;

    const mailVars = {
      creator_name: job.creator_name, contact_name: job.contact_name,
      customer_company: job.customer_company, job_name: job.job_name,
      customer_comment: `Einzelfreigabe: ${finalText}`, status_text: finalText,
      access_password: job.access_password || '',
      job_link: `${baseUrl}/jobs/${job.uuid}`,
      approval_link: `${baseUrl}/approve/${job.access_token}`,
      due_date: job.due_date ? new Date(job.due_date).toLocaleDateString('de-DE') : '',
    };

    const fRecipients = {
      customer: job.email_customer ? job.contact_email : null,
      creator: job.email_creator ? job.creator_email : null,
    };
    const fEvent = finalStatus === 'approved' ? 'approval_approved' : 'approval_rejected';
    sendMailByEvent(fEvent, fRecipients, mailVars);
    sendMailByEvent('customer_confirmation', fRecipients, mailVars);

    db.prepare(`INSERT INTO audit_log (job_id, action, details) VALUES (?, 'email_sent', ?)`).run(job.id, `Benachrichtigungen versendet (${finalText})`);
    if (notifyApproval) notifyApproval(job, finalStatus, `Einzelfreigabe abgeschlossen: ${finalText}`);
    if (triggerWebhooks) triggerWebhooks(finalStatus, { job_id: job.id, job_uuid: job.uuid, job_name: job.job_name, status: finalStatus, customer_company: job.customer_company, contact_name: job.contact_name });
  }

  res.json({ success: true, status, fileStatus: status, jobComplete, pendingCount: pending });
});

// ─── Thumbnail Seite 1 für Kunden ───────────────────────────────────────────
const { getOrCreateThumb } = require('../utils/thumb');

router.get('/:token/thumb', (req, res) => {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE access_token = ?').get(req.params.token);
  if (!job) return res.status(404).send('Nicht gefunden');
  const file = db.prepare('SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?').get(job.id, job.current_version);
  if (!file) return res.status(404).send('Datei nicht gefunden');
  const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const jpg = getOrCreateThumb(file.stored_name);
  if (!jpg) return res.status(404).send('Kein Thumbnail');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(jpg).pipe(res);
});

router.get('/:token/file/:fileId/thumb', (req, res) => {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE access_token = ?').get(req.params.token);
  if (!job) return res.status(404).send('Nicht gefunden');
  const file = db.prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(parseInt(req.params.fileId), job.id);
  if (!file) return res.status(404).send('Datei nicht gefunden');
  const jpg = getOrCreateThumb(file.stored_name);
  if (!jpg) return res.status(404).send('Kein Thumbnail');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(jpg).pipe(res);
});

// ─── Einzeldatei-Vorschau für Kunden ────────────────────────────────────────
router.get('/:token/file/:fileId/preview', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE access_token = ?').get(req.params.token);
  if (!job) return res.status(404).send('Nicht gefunden');

  const file = db.prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(parseInt(req.params.fileId), job.id);
  if (!file) return res.status(404).send('Datei nicht gefunden');

  const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(filePath).pipe(res);
});

// ─── PDF-Download für Kunden ────────────────────────────────────────────────
router.get('/:token/download', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE access_token = ?').get(req.params.token);
  if (!job) return res.status(404).send('Nicht gefunden');

  const file = db.prepare(`
    SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?
  `).get(job.id, job.current_version);
  if (!file) return res.status(404).send('Datei nicht gefunden');

  const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  db.prepare(`
    INSERT INTO audit_log (job_id, action, details)
    VALUES (?, 'customer_download', ?)
  `).run(job.id, 'Kunde hat PDF heruntergeladen');

  res.download(filePath, file.original_name);
});

// ─── PDF-Vorschau für Kunden ────────────────────────────────────────────────
router.get('/:token/preview', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE access_token = ?').get(req.params.token);
  if (!job) return res.status(404).send('Nicht gefunden');

  const file = db.prepare(`
    SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?
  `).get(job.id, job.current_version);
  if (!file) return res.status(404).send('Datei nicht gefunden');

  const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
