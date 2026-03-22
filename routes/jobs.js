// ─── routes/jobs.js ──────────────────────────────────────────────────────────
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireLogin } = require('../middleware/auth');
const { getDb } = require('../database');
const { sendMail, sendMailByEvent } = require('../mailer');
const { validatePdfFile, sanitizeString } = require('../security');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer: PDFs als UUID speichern, max 50MB
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uuidv4() + '.pdf'),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },  // 50 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Nur PDF-Dateien erlaubt.'));
    }
    cb(null, true);
  },
});

// ─── Freigabe erstellen (Formular) ──────────────────────────────────────────
router.get('/create', requireLogin, (req, res) => {
  const db = getDb();
  const customers = db.prepare(`
    SELECT c.*, GROUP_CONCAT(co.id || '|' || co.name || '|' || co.email, ';;') AS contacts_raw
    FROM customers c
    LEFT JOIN contacts co ON co.customer_id = c.id AND co.active = 1
    WHERE c.active = 1
    GROUP BY c.id
    ORDER BY c.company
  `).all();

  // Kontakte parsen
  customers.forEach(c => {
    c.contacts = (c.contacts_raw || '').split(';;').filter(Boolean).map(s => {
      const [id, name, email] = s.split('|');
      return { id: parseInt(id), name, email };
    });
  });

  res.render('jobs/create', { title: 'Freigabe erstellen', customers });
});

// ─── Freigabe speichern ─────────────────────────────────────────────────────
router.post('/create', requireLogin, (req, res, next) => {
  // Multer: bis zu 20 PDFs akzeptieren
  upload.array('pdfs', 20)(req, res, (err) => {
    if (err) {
      console.error('[JOBS] Upload-Fehler:', err.message);
      req.session.flash = { type: 'error', text: 'Upload-Fehler: ' + err.message };
      return res.redirect('/jobs/create');
    }

    try {
      const db = getDb();
      const { customer_id, contact_id, job_name, description, internal_comment, visibility } = req.body;
      let files = req.files || [];

      // SECURITY: PDF Magic Bytes prüfen (MIME-Type allein reicht nicht)
      files = files.filter(f => {
        const filePath = path.join(UPLOAD_DIR, f.filename);
        if (!validatePdfFile(filePath)) {
          console.warn(`[SECURITY] Keine gültige PDF: ${f.originalname}`);
          try { fs.unlinkSync(filePath); } catch {}
          return false;
        }
        return true;
      });

      console.log('[JOBS] Freigabe erstellen:', { job_name, customer_id, contact_id, files: files.length });

      if (files.length === 0) {
        req.session.flash = { type: 'error', text: 'Bitte mindestens eine PDF-Datei hochladen.' };
        return res.redirect('/jobs/create');
      }

      if (!customer_id || !contact_id || !job_name) {
        req.session.flash = { type: 'error', text: 'Bitte alle Pflichtfelder ausfüllen.' };
        return res.redirect('/jobs/create');
      }

      const jobUuid       = uuidv4();
      const accessToken   = uuidv4();
      const emailCustomer = req.body.email_customer === '1' ? 1 : 0;
      const emailCreator  = req.body.email_creator === '1' ? 1 : 0;
      const noReminder    = req.body.no_reminder === '1' ? 1 : 0;
      const accessPw      = req.body.access_password || null;
      const dueDate       = req.body.due_date || null;
      const followupDate  = req.body.followup_date || null;
      const followupNote  = req.body.followup_note || null;

  const result = db.prepare(`
    INSERT INTO jobs (uuid, creator_id, customer_id, contact_id, job_name, description, internal_comment, visibility, access_token, access_password, email_customer, email_creator, no_reminder, due_date, followup_date, followup_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobUuid,
    req.session.user.id,
    parseInt(customer_id),
    parseInt(contact_id),
    job_name,
    description || null,
    internal_comment || null,
    visibility || 'team',
    accessToken,
    accessPw,
    emailCustomer,
    emailCreator,
    noReminder,
    dueDate,
    followupDate,
    followupNote
  );

  const jobId = result.lastInsertRowid;

  // Erste Datei = Hauptversion (für Vorschau & Abwärtskompatibilität)
  const mainFile = files[0];
  db.prepare(`
    INSERT INTO job_versions (job_id, version_number, original_name, stored_name, file_size, uploaded_by)
    VALUES (?, 1, ?, ?, ?, ?)
  `).run(jobId, mainFile.originalname, mainFile.filename, mainFile.size, req.session.user.id);

  // Alle Dateien als Einzelfreigaben in job_files (Version 1)
  const insertFile = db.prepare(`
    INSERT INTO job_files (job_id, version_number, original_name, stored_name, file_size, sort_order)
    VALUES (?, 1, ?, ?, ?, ?)
  `);
  files.forEach((file, i) => {
    insertFile.run(jobId, file.originalname, file.filename, file.size, i + 1);
  });

  // Audit-Log
  db.prepare(`
    INSERT INTO audit_log (job_id, user_id, action, details)
    VALUES (?, ?, 'created', ?)
  `).run(jobId, req.session.user.id, `Freigabe erstellt: ${job_name} (${files.length} PDF${files.length > 1 ? 's' : ''})`);

  // BaseURL aus DB oder .env
  let baseUrl;
  try {
    const bRow = db.prepare("SELECT value FROM settings WHERE key='base_url'").get();
    baseUrl = (bRow && bRow.value) ? bRow.value : (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`);
  } catch { baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`; }
  const approvalLink = `${baseUrl}/approve/${accessToken}`;

  // Mail senden (basierend auf Einstellungen)
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(parseInt(contact_id));
  const mailRecipients = {
    customer: emailCustomer && contact ? contact.email : null,
    creator: emailCreator ? req.session.user.email : null,
  };

  if (emailCustomer && contact) {
    sendMailByEvent('approval_created', mailRecipients, {
      contact_name: contact.name,
      job_name,
      description: description || '',
      due_date: dueDate ? new Date(dueDate).toLocaleDateString('de-DE') : '',
      access_password: accessPw || '',
      approval_link: approvalLink,
      creator_name: req.session.user.name,
      creator_email: req.session.user.email,
    });

    db.prepare(`
      INSERT INTO audit_log (job_id, user_id, action, details)
      VALUES (?, ?, 'email_sent', ?)
    `).run(jobId, req.session.user.id, `Freigabe-Mail an ${contact.email} gesendet`);
  }

  if (emailCustomer) {
    req.session.flash = { type: 'success', text: 'Freigabe erstellt und E-Mail versendet.' };
    res.redirect(`/jobs/${jobUuid}`);
  } else {
    req.session.flash = { type: 'success', text: 'Freigabe erstellt (ohne Kunden-Mail).' };
    res.redirect(`/jobs/${jobUuid}?share=1`);
  }

    } catch (createErr) {
      console.error('[JOBS] Fehler beim Erstellen:', createErr);
      req.session.flash = { type: 'error', text: 'Fehler beim Erstellen: ' + createErr.message };
      res.redirect('/jobs/create');
    }
  }); // Ende multer callback
}); // Ende route

// ─── Freigabe-Detailansicht ─────────────────────────────────────────────────
router.get('/:uuid', requireLogin, (req, res) => {
  const db = getDb();

  const job = db.prepare(`
    SELECT j.*,
      u.name  AS creator_name, u.email AS creator_email,
      cu.company AS customer_company,
      co.name AS contact_name, co.email AS contact_email
    FROM jobs j
    JOIN users u      ON u.id  = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co  ON co.id = j.contact_id
    WHERE j.uuid = ?
  `).get(req.params.uuid);

  if (!job) {
    req.session.flash = { type: 'error', text: 'Freigabe nicht gefunden.' };
    return res.redirect('/dashboard');
  }

  // Alle Versionen
  const versions = db.prepare(`
    SELECT v.*, u.name AS uploaded_by_name
    FROM job_versions v
    JOIN users u ON u.id = v.uploaded_by
    WHERE v.job_id = ?
    ORDER BY v.version_number DESC
  `).all(job.id);

  // Audit-Log
  const logs = db.prepare(`
    SELECT a.*, u.name AS user_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.job_id = ?
    ORDER BY a.created_at DESC
  `).all(job.id);

  // Multi-Dateien: aktuelle Version
  let files = [];
  try { files = db.prepare('SELECT * FROM job_files WHERE job_id = ? AND version_number = ? ORDER BY sort_order').all(job.id, job.current_version); } catch {}

  // Alle Dateien nach Version gruppiert (für Versionshistorie)
  let allFiles = {};
  try {
    const af = db.prepare('SELECT * FROM job_files WHERE job_id = ? ORDER BY version_number DESC, sort_order').all(job.id);
    af.forEach(f => {
      if (!allFiles[f.version_number]) allFiles[f.version_number] = [];
      allFiles[f.version_number].push(f);
    });
  } catch {}

  res.render('jobs/detail', { title: job.job_name, job, versions, logs, files, allFiles });
});

// ─── Neue Version: Formularseite ────────────────────────────────────────────
router.get('/:uuid/version', requireLogin, (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT j.*, u.name AS creator_name, cu.company AS customer_company,
      co.name AS contact_name, co.email AS contact_email
    FROM jobs j JOIN users u ON u.id = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co ON co.id = j.contact_id
    WHERE j.uuid = ?
  `).get(req.params.uuid);

  if (!job) {
    req.session.flash = { type: 'error', text: 'Freigabe nicht gefunden.' };
    return res.redirect('/dashboard');
  }

  // Aktuelle Dateien laden
  let currentFiles = [];
  try { currentFiles = db.prepare('SELECT * FROM job_files WHERE job_id = ? AND version_number = ? ORDER BY sort_order').all(job.id, job.current_version); } catch {}

  res.render('jobs/version', {
    title: `Neue Version: ${job.job_name}`,
    job,
    currentFiles,
  });
});

// ─── Neue Version hochladen (Multi-File) ────────────────────────────────────
router.post('/:uuid/version', requireLogin, upload.array('pdfs', 20), (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  const files = req.files || [];

  if (!job || files.length === 0) {
    req.session.flash = { type: 'error', text: 'Keine Dateien hochgeladen.' };
    return res.redirect(`/jobs/${req.params.uuid}/version`);
  }

  const newVersion = job.current_version + 1;
  const description = req.body.description || null;
  const internalComment = req.body.internal_comment || null;
  const emailCustomer = req.body.email_customer === '1' ? 1 : 0;
  const emailCreator = req.body.email_creator === '1' ? 1 : 0;
  const dueDate = req.body.due_date || null;
  const followupDate = req.body.followup_date || null;
  const followupNote = req.body.followup_note || null;

  // Erste Datei = Hauptversion (für job_versions Abwärtskompatibilität)
  db.prepare(`
    INSERT INTO job_versions (job_id, version_number, original_name, stored_name, file_size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(job.id, newVersion, files[0].originalname, files[0].filename, files[0].size, req.session.user.id);

  // Neue Dateien mit Versionsnummer anlegen (alte bleiben erhalten!)
  const insertFile = db.prepare(`
    INSERT INTO job_files (job_id, version_number, original_name, stored_name, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  files.forEach((file, i) => {
    insertFile.run(job.id, newVersion, file.originalname, file.filename, file.size, i + 1);
  });

  db.prepare(`
    UPDATE jobs SET current_version = ?, status = 'pending', status_changed_at = NULL,
    customer_comment = NULL, description = ?, internal_comment = ?,
    email_customer = ?, email_creator = ?,
    due_date = ?, followup_date = ?, followup_note = ?,
    updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(newVersion, description, internalComment, emailCustomer, emailCreator, dueDate, followupDate, followupNote, job.id);

  db.prepare(`
    INSERT INTO audit_log (job_id, user_id, action, details)
    VALUES (?, ?, 'version_uploaded', ?)
  `).run(job.id, req.session.user.id, `Version ${newVersion}: ${files.length} Datei(en) hochgeladen`);

  // Mail senden
  if (emailCustomer || emailCreator) {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(job.contact_id);
    let baseUrl;
    try { const r = db.prepare("SELECT value FROM settings WHERE key='base_url'").get(); baseUrl = r?.value; } catch {}
    baseUrl = baseUrl || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

    if (contact) {
      sendMailByEvent('version_uploaded', {
        customer: emailCustomer ? contact.email : null,
        creator: emailCreator ? req.session.user.email : null,
      }, {
        contact_name: contact.name,
        job_name: `${job.job_name} (V${newVersion})`,
        description: description || '',
        due_date: dueDate ? new Date(dueDate).toLocaleDateString('de-DE') : '',
        access_password: job.access_password || '',
        approval_link: `${baseUrl}/approve/${job.access_token}`,
        creator_name: req.session.user.name,
        creator_email: req.session.user.email,
      });
    }
  }

  req.session.flash = { type: 'success', text: `Version ${newVersion} erstellt${emailCustomer ? ' und Kunde benachrichtigt' : ''}.` };
  res.redirect(`/jobs/${req.params.uuid}${emailCustomer ? '' : '?share=1'}`);
});

// ─── PDF-Download ───────────────────────────────────────────────────────────
router.get('/:uuid/download{/:version}', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  if (!job) return res.status(404).send('Nicht gefunden');

  const version = req.params.version
    ? parseInt(req.params.version)
    : job.current_version;

  const file = db.prepare(`
    SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?
  `).get(job.id, version);

  if (!file) return res.status(404).send('Datei nicht gefunden');

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  // Original-Dateinamen wiederherstellen
  const downloadName = version > 1
    ? file.original_name.replace('.pdf', `_V${version}.pdf`)
    : file.original_name;

  res.download(filePath, downloadName);
});

// ─── PDF-Vorschau (für PDF.js) ──────────────────────────────────────────────
router.get('/:uuid/preview{/:version}', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  if (!job) return res.status(404).send('Nicht gefunden');

  const version = req.params.version
    ? parseInt(req.params.version)
    : job.current_version;

  const file = db.prepare(`
    SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?
  `).get(job.id, version);

  if (!file) return res.status(404).send('Datei nicht gefunden');

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(filePath).pipe(res);
});

// ─── Einzeldatei-Vorschau (intern) ──────────────────────────────────────────
router.get('/:uuid/file/:fileId/preview', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  if (!job) return res.status(404).send('Nicht gefunden');

  const file = db.prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(parseInt(req.params.fileId), job.id);
  if (!file) return res.status(404).send('Datei nicht gefunden');

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(filePath).pipe(res);
});

// ─── Einzeldatei-Download (intern) ──────────────────────────────────────────
router.get('/:uuid/file/:fileId/download', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  if (!job) return res.status(404).send('Nicht gefunden');

  const file = db.prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(parseInt(req.params.fileId), job.id);
  if (!file) return res.status(404).send('Datei nicht gefunden');

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');

  res.download(filePath, file.original_name);
});

// ─── Freigabeprotokoll als PDF ──────────────────────────────────────────────
router.get('/:uuid/protocol', requireLogin, (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  if (!job) return res.status(404).send('Nicht gefunden');

  try {
    const { generateProtocol } = require('../protocol');
    const filename = `Freigabeprotokoll_${job.job_name.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    generateProtocol(job.id, res);

    db.prepare(`INSERT INTO audit_log (job_id, user_id, action, details) VALUES (?, ?, 'protocol_downloaded', ?)`).run(job.id, req.session.user.id, 'Freigabeprotokoll heruntergeladen');
  } catch (err) {
    console.error('[PROTOCOL] Fehler:', err);
    req.session.flash = { type: 'error', text: 'Fehler bei PDF-Erstellung: ' + err.message };
    res.redirect(`/jobs/${req.params.uuid}`);
  }
});

// ─── Protokoll per Mail senden ──────────────────────────────────────────────
router.post('/:uuid/protocol/send', requireLogin, (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT j.*, co.name AS contact_name, co.email AS contact_email,
      u.name AS creator_name, u.email AS creator_email
    FROM jobs j JOIN contacts co ON co.id = j.contact_id JOIN users u ON u.id = j.creator_id
    WHERE j.uuid = ?
  `).get(req.params.uuid);
  if (!job) return res.status(404).json({ error: 'Nicht gefunden' });

  try {
    const { generateProtocol } = require('../protocol');
    const { PassThrough } = require('stream');
    const { getTransporter } = require('../mailer');

    // PDF in Buffer generieren
    const chunks = [];
    const passthrough = new PassThrough();
    passthrough.on('data', chunk => chunks.push(chunk));

    passthrough.on('end', async () => {
      const pdfBuffer = Buffer.concat(chunks);
      const companyName = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Unternehmen';
      const fromName = db.prepare("SELECT value FROM settings WHERE key='smtp_from_name'").get()?.value || 'PDF-Freigabe';
      const fromAddr = db.prepare("SELECT value FROM settings WHERE key='smtp_from'").get()?.value || process.env.SMTP_FROM || 'freigabe@localhost';

      const recipients = [job.creator_email, job.contact_email].filter(Boolean);
      const statusText = job.status === 'approved' ? 'Freigegeben' : job.status === 'rejected' ? 'Abgelehnt' : 'Offen';

      try {
        await getTransporter().sendMail({
          from: `"${fromName}" <${fromAddr}>`,
          to: recipients.join(', '),
          subject: `Freigabeprotokoll: ${job.job_name} (${statusText})`,
          text: `Anbei das Freigabeprotokoll für "${job.job_name}".\n\nStatus: ${statusText}\nDatum: ${new Date().toLocaleString('de-DE')}\n\n${companyName}`,
          html: `<h2>Freigabeprotokoll</h2><p>Anbei das Protokoll für <strong>${job.job_name}</strong>.</p><p>Status: <strong>${statusText}</strong></p><p>${companyName}</p>`,
          attachments: [{
            filename: `Freigabeprotokoll_${job.job_name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          }],
        });

        db.prepare(`INSERT INTO audit_log (job_id, user_id, action, details) VALUES (?, ?, 'protocol_sent', ?)`).run(job.id, req.session.user.id, `Protokoll an ${recipients.join(', ')} gesendet`);
        res.json({ success: true, recipients });
      } catch (err) {
        res.json({ success: false, error: err.message });
      }
    });

    generateProtocol(job.id, passthrough);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Multi-PDF Upload ───────────────────────────────────────────────────────
router.post('/:uuid/files', requireLogin, upload.array('pdfs', 20), (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);

  if (!job || !req.files || req.files.length === 0) {
    req.session.flash = { type: 'error', text: 'Keine Dateien hochgeladen.' };
    return res.redirect(`/jobs/${req.params.uuid}`);
  }

  const maxSort = db.prepare('SELECT MAX(sort_order) AS m FROM job_files WHERE job_id = ? AND version_number = ?').get(job.id, job.current_version)?.m || 0;

  const insert = db.prepare(`
    INSERT INTO job_files (job_id, version_number, original_name, stored_name, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  req.files.forEach((file, i) => {
    insert.run(job.id, job.current_version, file.originalname, file.filename, file.size, maxSort + i + 1);
  });

  db.prepare(`INSERT INTO audit_log (job_id, user_id, action, details) VALUES (?, ?, 'files_uploaded', ?)`).run(job.id, req.session.user.id, `${req.files.length} Datei(en) hochgeladen`);

  req.session.flash = { type: 'success', text: `${req.files.length} Datei(en) hochgeladen.` };
  res.redirect(`/jobs/${req.params.uuid}`);
});

// ─── Bulk: Mehrere Jobs löschen ─────────────────────────────────────────────
router.post('/bulk/delete', requireLogin, (req, res) => {
  const db = getDb();
  let { job_ids } = req.body;

  if (typeof job_ids === 'string') job_ids = [job_ids];
  if (!Array.isArray(job_ids) || job_ids.length === 0) {
    req.session.flash = { type: 'error', text: 'Keine Jobs ausgewählt.' };
    return res.redirect('/dashboard');
  }

  let deleted = 0;
  for (const uuid of job_ids) {
    const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(uuid);
    if (!job) continue;
    if (job.creator_id !== req.session.user.id && req.session.user.role !== 'admin') continue;

    const versions = db.prepare('SELECT stored_name FROM job_versions WHERE job_id = ?').all(job.id);
    for (const v of versions) {
      const fp = path.join(UPLOAD_DIR, v.stored_name);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    db.prepare('DELETE FROM job_versions WHERE job_id = ?').run(job.id);
    db.prepare('DELETE FROM audit_log WHERE job_id = ?').run(job.id);
    db.prepare('DELETE FROM notifications WHERE job_id = ?').run(job.id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    deleted++;
  }

  req.session.flash = { type: 'success', text: `${deleted} Freigabe(n) gelöscht.` };
  res.redirect('/dashboard');
});

// ─── Bulk: Status zurücksetzen (Erneut senden) ─────────────────────────────
router.post('/bulk/resend', requireLogin, (req, res) => {
  const db = getDb();
  let { job_ids } = req.body;

  if (typeof job_ids === 'string') job_ids = [job_ids];
  if (!Array.isArray(job_ids) || job_ids.length === 0) {
    req.session.flash = { type: 'error', text: 'Keine Jobs ausgewählt.' };
    return res.redirect('/dashboard');
  }

  let sent = 0;
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  for (const uuid of job_ids) {
    const job = db.prepare(`
      SELECT j.*, co.name AS contact_name, co.email AS contact_email
      FROM jobs j JOIN contacts co ON co.id = j.contact_id
      WHERE j.uuid = ? AND j.status = 'pending'
    `).get(uuid);

    if (!job) continue;

    sendMail('new_approval', job.contact_email, {
      contact_name: job.contact_name,
      job_name: job.job_name,
      description: job.description || '',
      approval_link: `${baseUrl}/approve/${job.access_token}`,
      creator_name: req.session.user.name,
      creator_email: req.session.user.email,
    });

    db.prepare(`
      INSERT INTO audit_log (job_id, user_id, action, details)
      VALUES (?, ?, 'email_resent', ?)
    `).run(job.id, req.session.user.id, `Bulk: Mail erneut an ${job.contact_email}`);

    sent++;
  }

  req.session.flash = { type: 'success', text: `${sent} Mail(s) erneut gesendet.` };
  res.redirect('/dashboard');
});

// ─── Job löschen ────────────────────────────────────────────────────────────
router.post('/:uuid/delete', requireLogin, (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);

  if (!job) {
    req.session.flash = { type: 'error', text: 'Job nicht gefunden.' };
    return res.redirect('/dashboard');
  }

  // Nur Ersteller oder Admin
  if (job.creator_id !== req.session.user.id && req.session.user.role !== 'admin') {
    req.session.flash = { type: 'error', text: 'Keine Berechtigung.' };
    return res.redirect('/dashboard');
  }

  // Dateien löschen
  const versions = db.prepare('SELECT stored_name FROM job_versions WHERE job_id = ?').all(job.id);
  for (const v of versions) {
    const fp = path.join(UPLOAD_DIR, v.stored_name);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  db.prepare('DELETE FROM job_versions WHERE job_id = ?').run(job.id);
  db.prepare('DELETE FROM audit_log WHERE job_id = ?').run(job.id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);

  req.session.flash = { type: 'success', text: 'Freigabe gelöscht.' };
  res.redirect('/dashboard');
});

// ─── Job duplizieren ────────────────────────────────────────────────────────
router.post('/:uuid/duplicate', requireLogin, (req, res) => {
  const db = getDb();
  const original = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);

  if (!original) {
    req.session.flash = { type: 'error', text: 'Job nicht gefunden.' };
    return res.redirect('/dashboard');
  }

  // Original-PDF kopieren
  const origVersion = db.prepare(`
    SELECT * FROM job_versions WHERE job_id = ? AND version_number = ?
  `).get(original.id, original.current_version);

  let newStoredName = null;
  if (origVersion) {
    const srcPath = path.join(UPLOAD_DIR, origVersion.stored_name);
    if (fs.existsSync(srcPath)) {
      newStoredName = uuidv4() + '.pdf';
      fs.copyFileSync(srcPath, path.join(UPLOAD_DIR, newStoredName));
    }
  }

  const newUuid = uuidv4();
  const newToken = uuidv4();
  const newName = `${original.job_name} (Kopie)`;

  const result = db.prepare(`
    INSERT INTO jobs (uuid, creator_id, customer_id, contact_id, job_name, description, internal_comment, visibility, access_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newUuid, req.session.user.id, original.customer_id, original.contact_id,
    newName, original.description, original.internal_comment, original.visibility, newToken
  );

  const newJobId = result.lastInsertRowid;

  // PDF-Version kopieren
  if (origVersion && newStoredName) {
    db.prepare(`
      INSERT INTO job_versions (job_id, version_number, original_name, stored_name, file_size, uploaded_by)
      VALUES (?, 1, ?, ?, ?, ?)
    `).run(newJobId, origVersion.original_name, newStoredName, origVersion.file_size, req.session.user.id);
  }

  // Audit
  db.prepare(`
    INSERT INTO audit_log (job_id, user_id, action, details)
    VALUES (?, ?, 'created', ?)
  `).run(newJobId, req.session.user.id, `Dupliziert von "${original.job_name}"`);

  req.session.flash = { type: 'success', text: `Job dupliziert: "${newName}". Bitte prüfen und ggf. Kunden neu benachrichtigen.` };
  res.redirect(`/jobs/${newUuid}`);
});

module.exports = router;
