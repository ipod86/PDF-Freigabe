// ─── routes/api.js ───────────────────────────────────────────────────────────
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { requireLogin } = require('../middleware/auth');
const { getDb } = require('../database');

// Health Check
router.get('/health', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB' });
  } catch (err) { res.status(503).json({ status: 'error', message: err.message }); }
});

// Kontakte Dropdown
router.get('/contacts/:customerId', requireLogin, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id, name, email FROM contacts WHERE customer_id = ? AND active = 1 ORDER BY name').all(req.params.customerId));
});

// Stats
router.get('/stats', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
    FROM jobs WHERE visibility = 'team' OR creator_id = ?
  `).get(userId);
  res.json(stats);
});

// Erweiterte Stats
router.get('/stats/detailed', requireLogin, (req, res) => {
  const db = getDb();
  const uid = req.session.user.id;

  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS total,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
    FROM jobs WHERE created_at >= date('now','-12 months') AND (visibility='team' OR creator_id=?)
    GROUP BY month ORDER BY month ASC
  `).all(uid);

  const topCustomers = db.prepare(`
    SELECT cu.company, COUNT(*) AS job_count,
      SUM(CASE WHEN j.status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN j.status='rejected' THEN 1 ELSE 0 END) AS rejected
    FROM jobs j JOIN customers cu ON cu.id = j.customer_id
    WHERE (j.visibility='team' OR j.creator_id=?)
    GROUP BY cu.id ORDER BY job_count DESC LIMIT 10
  `).all(uid);

  const avgTime = db.prepare(`
    SELECT ROUND(AVG(julianday(status_changed_at) - julianday(created_at)), 1) AS avg_days
    FROM jobs WHERE status IN ('approved','rejected') AND status_changed_at IS NOT NULL
      AND (visibility='team' OR creator_id=?)
  `).get(uid);

  const byCreator = db.prepare(`
    SELECT u.name, COUNT(*) AS total,
      SUM(CASE WHEN j.status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN j.status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN j.status='pending' THEN 1 ELSE 0 END) AS pending
    FROM jobs j JOIN users u ON u.id = j.creator_id
    WHERE (j.visibility='team' OR j.creator_id=?)
    GROUP BY u.id ORDER BY total DESC
  `).all(uid);

  const versionStats = db.prepare(`
    SELECT ROUND(AVG(current_version), 1) AS avg_versions, MAX(current_version) AS max_versions,
      SUM(CASE WHEN current_version > 1 THEN 1 ELSE 0 END) AS corrected_jobs, COUNT(*) AS total_jobs
    FROM jobs WHERE (visibility='team' OR creator_id=?)
  `).get(uid);

  res.json({ monthly, topCustomers, avgResponseDays: avgTime?.avg_days, byCreator, versionStats });
});

// CSV-Export
router.get('/export/csv', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const status = req.query.status;
  let where = "(j.visibility = 'team' OR j.creator_id = ?)";
  const params = [userId];
  if (status && ['pending','approved','rejected'].includes(status)) { where += ' AND j.status = ?'; params.push(status); }

  const jobs = db.prepare(`
    SELECT j.id, j.job_name, j.status, j.created_at, j.status_changed_at, j.current_version,
      j.customer_comment, j.visibility, u.name AS creator_name, cu.company AS customer_company,
      co.name AS contact_name, co.email AS contact_email, j.description, j.internal_comment, j.reminder_count
    FROM jobs j JOIN users u ON u.id = j.creator_id JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co ON co.id = j.contact_id WHERE ${where} ORDER BY j.created_at DESC
  `).all(...params);

  const headers = ['ID','Auftragsname','Status','Erstellt am','Status-Datum','Version','Ersteller','Firma','Ansprechpartner','E-Mail','Besonderheiten','Interner Kommentar','Kunden-Kommentar','Sichtbarkeit','Erinnerungen'];
  const esc = s => `"${(s || '').replace(/"/g, '""')}"`;
  const statusMap = { pending:'Offen', approved:'Freigegeben', rejected:'Abgelehnt' };
  const rows = jobs.map(j => [j.id, esc(j.job_name), statusMap[j.status]||j.status, j.created_at||'', j.status_changed_at||'',
    `V${j.current_version}`, esc(j.creator_name), esc(j.customer_company), esc(j.contact_name), j.contact_email,
    esc(j.description), esc(j.internal_comment), esc(j.customer_comment), j.visibility==='team'?'Team':'Privat', j.reminder_count].join(';'));

  const csv = '\uFEFF' + headers.join(';') + '\n' + rows.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="freigaben_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// Mail erneut senden
router.post('/resend/:jobId', requireLogin, (req, res) => {
  const db = getDb();
  const { sendMailByEvent } = require('../mailer');
  const job = db.prepare(`
    SELECT j.*, co.name AS contact_name, co.email AS contact_email, u.name AS creator_name, u.email AS creator_email
    FROM jobs j JOIN contacts co ON co.id = j.contact_id JOIN users u ON u.id = j.creator_id WHERE j.id = ?
  `).get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Nicht gefunden' });

  let baseUrl;
  try { baseUrl = db.prepare("SELECT value FROM settings WHERE key='base_url'").get()?.value; } catch {}
  baseUrl = baseUrl || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  sendMailByEvent('approval_created', { customer: job.contact_email, creator: job.creator_email }, {
    contact_name: job.contact_name, job_name: job.job_name, description: job.description || '',
    due_date: job.due_date ? new Date(job.due_date).toLocaleDateString('de-DE') : '',
    access_password: job.access_password || '',
    approval_link: `${baseUrl}/approve/${job.access_token}`,
    creator_name: job.creator_name, creator_email: job.creator_email,
  });

  db.prepare(`INSERT INTO audit_log (job_id, user_id, action, details) VALUES (?, ?, 'email_resent', ?)`).run(job.id, req.session.user.id, `Mail erneut an ${job.contact_email}`);
  res.json({ success: true });
});

// Passwort ändern
router.post('/change-password', requireLogin, (req, res) => {
  const db = getDb();
  const { validatePassword } = require('../security');
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Beide Felder ausfüllen.' });
  const pwErr = validatePassword(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash))
    return res.status(400).json({ error: 'Aktuelles Passwort falsch.' });

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now','localtime') WHERE id=?`).run(hash, user.id);
  db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'password_changed', 'Passwort geändert')`).run(user.id);
  res.json({ success: true });
});

// Kundensuche
router.get('/search/customers', requireLogin, (req, res) => {
  const db = getDb();
  const { escapeLike } = require('../security');
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  res.json(db.prepare(`
    SELECT c.id, c.company, (SELECT COUNT(*) FROM contacts WHERE customer_id = c.id AND active=1) AS contacts
    FROM customers c WHERE c.active = 1 AND c.company LIKE ? ESCAPE '\\' ORDER BY c.company LIMIT 20
  `).all(`%${escapeLike(q)}%`));
});

// Benachrichtigungen
router.get('/notifications', requireLogin, (req, res) => {
  const { getAll, getUnread } = require('../notifications');
  res.json(req.query.unread === '1' ? getUnread(req.session.user.id) : getAll(req.session.user.id));
});

router.post('/notifications/read/:id', requireLogin, (req, res) => {
  require('../notifications').markRead(parseInt(req.params.id), req.session.user.id);
  res.json({ success: true });
});

router.post('/notifications/read-all', requireLogin, (req, res) => {
  require('../notifications').markAllRead(req.session.user.id);
  res.json({ success: true });
});

// Email-Test (AJAX)
router.post('/email-test', requireLogin, async (req, res) => {
  const { getTransporter } = require('../mailer');
  const { recipient } = req.body;
  if (!recipient) return res.status(400).json({ error: 'Empfänger fehlt.' });
  try {
    const db = getDb();
    const fromName = db.prepare("SELECT value FROM settings WHERE key='smtp_from_name'").get()?.value || 'PDF-Freigabe';
    const fromAddr = db.prepare("SELECT value FROM settings WHERE key='smtp_from'").get()?.value || 'freigabe@localhost';
    const info = await getTransporter().sendMail({
      from: `"${fromName}" <${fromAddr}>`, to: recipient,
      subject: 'Testmail vom PDF-Freigabetool',
      text: 'Dies ist eine Testmail. E-Mail-Versand funktioniert korrekt.',
      html: '<h2>Testmail</h2><p>E-Mail-Versand funktioniert korrekt.</p>',
    });
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
