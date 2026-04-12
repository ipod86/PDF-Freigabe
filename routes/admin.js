// ─── routes/admin.js ─────────────────────────────────────────────────────────
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { execSync } = require('child_process');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { getDb } = require('../database');
const { validatePassword, escapeLike } = require('../security');
const { sendMail } = require('../mailer');

// Alle Admin-Routen brauchen Login
router.use(requireLogin);

// Hilfsfunktion: Admin-Check als Middleware für bestimmte Routen
const adminOnly = requireAdmin;

// Multer für Logo-Upload
const logoDir = path.join(__dirname, '..', 'public', 'uploads', 'logo');
if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (r, f, cb) => cb(null, logoDir),
    filename: (r, f, cb) => cb(null, 'company-logo' + path.extname(f.originalname)),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (r, f, cb) => cb(null, /image\/(png|jpeg|svg\+xml)/.test(f.mimetype)),
});

// Multer für Backup-Restore
const backupUpload = multer({ dest: path.join(os.tmpdir(), 'pdf-freigabe-restore') });

// ─── Übersicht ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => res.render('admin/index', { title: 'Verwaltung' }));
router.get('/statistics', adminOnly, (req, res) => res.render('admin/statistics', { title: 'Statistiken' }));

// ═══════════════════════════════════════════════════════════════════════════
// SACHBEARBEITER
// ═══════════════════════════════════════════════════════════════════════════
router.get('/users', adminOnly, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY name').all();
  const invitations = db.prepare(`
    SELECT i.*, u.name AS invited_by_name
    FROM user_invitations i
    JOIN users u ON u.id = i.invited_by
    WHERE i.expires_at > datetime('now','localtime')
    ORDER BY i.created_at DESC
  `).all();
  res.render('admin/users', { title: 'Sachbearbeiter', users, invitations });
});

router.post('/users', adminOnly, (req, res) => {
  const db = getDb();
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) { req.session.flash = { type: 'error', text: 'Alle Pflichtfelder ausfüllen.' }; return res.redirect('/admin/users'); }
  const pwErr = validatePassword(password);
  if (pwErr) { req.session.flash = { type: 'error', text: pwErr }; return res.redirect('/admin/users'); }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) { req.session.flash = { type: 'error', text: 'E-Mail existiert bereits.' }; return res.redirect('/admin/users'); }
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, bcrypt.hashSync(password, 12), role || 'user');
  req.session.flash = { type: 'success', text: `Sachbearbeiter "${name}" angelegt.` };
  res.redirect('/admin/users');
});

router.post('/users/:id/update', adminOnly, (req, res) => {
  const db = getDb();
  const { name, email, password, role, active } = req.body;
  const isActive = active === 'on' ? 1 : 0;
  if (password) {
    const pwErr = validatePassword(password);
    if (pwErr) { req.session.flash = { type: 'error', text: pwErr }; return res.redirect('/admin/users'); }
    db.prepare(`UPDATE users SET name=?, email=?, password_hash=?, role=?, active=?, updated_at=datetime('now','localtime') WHERE id=?`).run(name, email, bcrypt.hashSync(password, 12), role || 'user', isActive, req.params.id);
  } else {
    db.prepare(`UPDATE users SET name=?, email=?, role=?, active=?, updated_at=datetime('now','localtime') WHERE id=?`).run(name, email, role || 'user', isActive, req.params.id);
  }
  req.session.flash = { type: 'success', text: 'Benutzer aktualisiert.' };
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', adminOnly, (req, res) => {
  const db = getDb();
  if (parseInt(req.params.id) === req.session.user.id) { req.session.flash = { type: 'error', text: 'Eigenen Account nicht löschbar.' }; return res.redirect('/admin/users'); }
  const c = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE creator_id = ?').get(req.params.id).c;
  if (c > 0) { db.prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id); req.session.flash = { type: 'warn', text: `${c} Jobs vorhanden – deaktiviert.` }; }
  else { db.prepare('DELETE FROM users WHERE id=?').run(req.params.id); req.session.flash = { type: 'success', text: 'Gelöscht.' }; }
  res.redirect('/admin/users');
});

router.post('/users/invite', adminOnly, async (req, res) => {
  const db = getDb();
  const { email, role } = req.body;
  const trimmedEmail = (email || '').trim().toLowerCase();

  if (!trimmedEmail) { req.session.flash = { type: 'error', text: 'E-Mail erforderlich.' }; return res.redirect('/admin/users'); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) { req.session.flash = { type: 'error', text: 'Ungültige E-Mail-Adresse.' }; return res.redirect('/admin/users'); }
  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(trimmedEmail)) {
    req.session.flash = { type: 'error', text: 'Diese E-Mail ist bereits als Benutzer registriert.' };
    return res.redirect('/admin/users');
  }

  // Bestehende Einladung für diese E-Mail ersetzen
  db.prepare('DELETE FROM user_invitations WHERE email = ?').run(trimmedEmail);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO user_invitations (email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)').run(trimmedEmail, role || 'user', token, req.session.user.id, expiresAt);

  const baseUrl = (db.prepare('SELECT value FROM settings WHERE key=?').get('base_url')?.value || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const sent = await sendMail('user_invite', trimmedEmail, {
    invite_link: `${baseUrl}/invite/${token}`,
    role_label: (role === 'admin') ? 'Administrator' : 'Sachbearbeiter',
    invited_by: req.session.user.name,
  });

  if (sent) {
    req.session.flash = { type: 'success', text: `Einladung an ${trimmedEmail} gesendet.` };
  } else {
    req.session.flash = { type: 'warn', text: `Einladung gespeichert, aber E-Mail konnte nicht gesendet werden. Link: ${baseUrl}/invite/${token}` };
  }
  res.redirect('/admin/users');
});

router.post('/users/invite/:id/delete', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM user_invitations WHERE id = ?').run(req.params.id);
  req.session.flash = { type: 'success', text: 'Einladung zurückgezogen.' };
  res.redirect('/admin/users');
});

// ═══════════════════════════════════════════════════════════════════════════
// KUNDEN
// ═══════════════════════════════════════════════════════════════════════════
router.get('/customers', (req, res) => {
  res.render('admin/customers', { title: 'Kundenstamm', customers: getDb().prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM contacts WHERE customer_id=c.id AND active=1) AS contact_count,
      (SELECT COUNT(*) FROM jobs WHERE customer_id=c.id) AS job_count,
      (SELECT COUNT(*) FROM customer_users WHERE customer_id=c.id AND active=1) AS portal_count
    FROM customers c ORDER BY c.company`).all() });
});

router.post('/customers', (req, res) => {
  getDb().prepare('INSERT INTO customers (company, notes) VALUES (?, ?)').run(req.body.company, req.body.notes || null);
  req.session.flash = { type: 'success', text: `Kunde "${req.body.company}" angelegt.` };
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', (req, res) => {
  const { company, notes, active } = req.body;
  getDb().prepare(`UPDATE customers SET company=?, notes=?, active=?, updated_at=datetime('now','localtime') WHERE id=?`).run(company, notes || null, active === 'on' ? 1 : 0, req.params.id);
  req.session.flash = { type: 'success', text: 'Kunde aktualisiert.' };
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', (req, res) => {
  const db = getDb(); const c = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE customer_id=?').get(req.params.id).c;
  if (c > 0) { db.prepare('UPDATE customers SET active=0 WHERE id=?').run(req.params.id); req.session.flash = { type: 'warn', text: `${c} Jobs – deaktiviert.` }; }
  else { db.prepare('DELETE FROM contacts WHERE customer_id=?').run(req.params.id); db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id); req.session.flash = { type: 'success', text: 'Gelöscht.' }; }
  res.redirect('/admin/customers');
});

// Ansprechpartner
router.get('/customers/:id/contacts', (req, res) => {
  const db = getDb(); const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  const contacts = db.prepare(`
    SELECT c.*, cu.id AS portal_id, cu.name AS portal_name, cu.email AS portal_email,
           cu.active AS portal_active, cu.last_login AS portal_last_login
    FROM contacts c
    LEFT JOIN customer_users cu ON cu.contact_id = c.id
    WHERE c.customer_id = ?
    ORDER BY c.name
  `).all(req.params.id);
  res.render('admin/contacts', { title: `Ansprechpartner: ${customer.company}`, customer, contacts });
});

router.post('/customers/:id/contacts', (req, res) => {
  const { name, email, phone, position } = req.body;
  getDb().prepare('INSERT INTO contacts (customer_id, name, email, phone, position) VALUES (?,?,?,?,?)').run(req.params.id, name, email, phone || null, position || null);
  req.session.flash = { type: 'success', text: `"${name}" angelegt.` };
  res.redirect(`/admin/customers/${req.params.id}/contacts`);
});

router.post('/contacts/:id/update', (req, res) => {
  const { name, email, phone, position, active, customer_id } = req.body;
  getDb().prepare('UPDATE contacts SET name=?, email=?, phone=?, position=?, active=? WHERE id=?').run(name, email, phone || null, position || null, active === 'on' ? 1 : 0, req.params.id);
  req.session.flash = { type: 'success', text: 'Aktualisiert.' };
  res.redirect(`/admin/customers/${customer_id}/contacts`);
});

router.post('/contacts/:id/delete', (req, res) => {
  const db = getDb(); const co = db.prepare('SELECT customer_id FROM contacts WHERE id=?').get(req.params.id);
  const c = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE contact_id=?').get(req.params.id).c;
  if (c > 0) { db.prepare('UPDATE contacts SET active=0 WHERE id=?').run(req.params.id); req.session.flash = { type: 'warn', text: `${c} Jobs – deaktiviert.` }; }
  else { db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id); req.session.flash = { type: 'success', text: 'Gelöscht.' }; }
  res.redirect(`/admin/customers/${co ? co.customer_id : ''}/contacts`);
});

// ═══════════════════════════════════════════════════════════════════════════
// MAIL-VORLAGEN
// ═══════════════════════════════════════════════════════════════════════════
router.get('/templates', adminOnly, (req, res) => {
  res.render('admin/templates', {
    title: 'Mail-Vorlagen',
    templates: getDb().prepare('SELECT * FROM mail_templates ORDER BY event, name').all(),
  });
});

router.get('/templates/:id', adminOnly, (req, res) => {
  const t = getDb().prepare('SELECT * FROM mail_templates WHERE id=?').get(req.params.id);
  if (!t) return res.redirect('/admin/templates');
  res.render('admin/template_edit', { title: `Vorlage: ${t.name}`, template: t });
});

// WICHTIG: /templates/create MUSS vor /templates/:id stehen
router.post('/templates/create', adminOnly, (req, res) => {
  const { name, event, recipient, subject, description } = req.body;
  const slug = 'custom_' + Date.now();
  const result = getDb().prepare(`INSERT INTO mail_templates (slug, name, event, recipient, subject, body_html, body_text, description, deletable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(slug, name, event || 'manual', recipient || 'customer', subject || '{{job_name}}',
      '<h2>' + (name || 'Vorlage') + '</h2>\n<p>Guten Tag {{contact_name}},</p>\n<p>Inhalt hier bearbeiten...</p>\n<p>Mit freundlichen Grüßen<br>{{company_name}}</p>',
      name + '\n\nGuten Tag {{contact_name}},\n\nInhalt hier...\n\nMit freundlichen Grüßen\n{{company_name}}',
      description || null);
  req.session.flash = { type: 'success', text: `Vorlage "${name}" erstellt.` };
  res.redirect('/admin/templates/' + result.lastInsertRowid);
});

router.post('/templates/:id', adminOnly, (req, res) => {
  const { name, event, recipient, subject, body_html, body_text, description } = req.body;
  getDb().prepare(`UPDATE mail_templates SET name=?, event=?, recipient=?, subject=?, body_html=?, body_text=?, description=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(name || 'Unbenannt', event || 'manual', recipient || 'customer', subject, body_html, body_text, description || null, req.params.id);
  req.session.flash = { type: 'success', text: 'Vorlage gespeichert.' };
  res.redirect('/admin/templates');
});

router.post('/templates/:id/toggle', adminOnly, (req, res) => {
  getDb().prepare('UPDATE mail_templates SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);
  res.redirect('/admin/templates');
});

router.post('/templates/:id/delete', adminOnly, (req, res) => {
  const t = getDb().prepare('SELECT deletable FROM mail_templates WHERE id=?').get(req.params.id);
  if (t && t.deletable) {
    getDb().prepare('DELETE FROM mail_templates WHERE id=?').run(req.params.id);
    req.session.flash = { type: 'success', text: 'Vorlage gelöscht.' };
  } else {
    req.session.flash = { type: 'error', text: 'System-Vorlagen können nicht gelöscht werden.' };
  }
  res.redirect('/admin/templates');
});

// ═══════════════════════════════════════════════════════════════════════════
// EINSTELLUNGEN (inkl. Logo + BaseURL)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/settings', adminOnly, (req, res) => {
  const db = getDb(); const settings = {};
  db.prepare('SELECT * FROM settings').all().forEach(s => { settings[s.key] = s.value; });
  settings.smtp_host = settings.smtp_host || process.env.SMTP_HOST || 'localhost';
  settings.smtp_port = settings.smtp_port || process.env.SMTP_PORT || '587';
  settings.smtp_user = settings.smtp_user || process.env.SMTP_USER || '';
  settings.smtp_pass = settings.smtp_pass || process.env.SMTP_PASS || '';
  settings.smtp_from = settings.smtp_from || process.env.SMTP_FROM || 'freigabe@localhost';
  settings.smtp_from_name = settings.smtp_from_name || process.env.SMTP_FROM_NAME || 'PDF-Freigabe';
  settings.base_url = settings.base_url || process.env.BASE_URL || '';
  res.render('admin/settings', { title: 'Einstellungen', settings });
});

router.post('/settings', adminOnly, logoUpload.single('logo'), (req, res) => {
  const db = getDb();
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?');
  for (const [key, value] of Object.entries(req.body)) {
    if (key === '_csrf') continue;
    // SMTP-Passwort: leeres Feld bedeutet "nicht ändern"
    if (key === 'smtp_pass' && !value) continue;
    upsert.run(key, value, value);
  }
  // Logo gespeichert?
  if (req.file) {
    upsert.run('company_logo', req.file.filename, req.file.filename);
  }
  // SMTP neu laden
  try { require('../mailer').reloadTransporter(); } catch {}
  req.session.flash = { type: 'success', text: 'Einstellungen gespeichert.' };
  res.redirect('/admin/settings');
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT-LOG
// ═══════════════════════════════════════════════════════════════════════════
router.get('/audit', adminOnly, (req, res) => {
  const db = getDb(); const page = Math.max(1, parseInt(req.query.page) || 1); const limit = 50;
  const filter = { action: req.query.action || '', q: req.query.q || '' };
  let where = '1=1'; const params = [];
  if (filter.action) { where += ' AND a.action=?'; params.push(filter.action); }
  if (filter.q) { where += ` AND (a.details LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR j.job_name LIKE ? ESCAPE '\\')`; const s = `%${escapeLike(filter.q)}%`; params.push(s, s, s); }
  const logs = db.prepare(`SELECT a.*, u.name AS user_name, j.uuid AS job_uuid, j.job_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN jobs j ON j.id=a.job_id WHERE ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  res.render('admin/audit', { title: 'Audit-Log', logs, page, limit, filter });
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKUP & RESTORE (Einzelarchiv: DB + PDFs)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/backup', adminOnly, (req, res) => {
  const formatBytes = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'database.sqlite');
  const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const db = getDb();

  let dbSize = '–', uploadsSize = '–', uploadCount = 0;
  try { dbSize = formatBytes(fs.statSync(dbPath).size); } catch {}
  try {
    const files = fs.readdirSync(uploadDir);
    uploadCount = files.length;
    let total = 0;
    files.forEach(f => { try { total += fs.statSync(path.join(uploadDir, f)).size; } catch {} });
    uploadsSize = formatBytes(total);
  } catch {}

  const jobCount = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;

  res.render('admin/backup', {
    title: 'Backup & Restore',
    stats: { dbSize, uploadsSize, uploadCount, jobs: jobCount },
  });
});

router.get('/backup/download', (req, res) => {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'database.sqlite');
  const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const logoDir = path.join(__dirname, '..', 'public', 'uploads', 'logo');
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const archiveName = `pdf-freigabe-backup-${timestamp}.tar.gz`;
  const archivePath = path.join(os.tmpdir(), archiveName);

  try {
    // Temporäres Backup-Verzeichnis
    const tmpDir = path.join(os.tmpdir(), 'pdf-freigabe-backup-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'uploads'), { recursive: true });

    // Datenbank kopieren
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, path.join(tmpDir, 'data', 'database.sqlite'));
    }

    // PDFs kopieren
    if (fs.existsSync(uploadDir)) {
      fs.readdirSync(uploadDir).forEach(f => {
        try { fs.copyFileSync(path.join(uploadDir, f), path.join(tmpDir, 'uploads', f)); } catch {}
      });
    }

    // Logo kopieren
    if (fs.existsSync(logoDir)) {
      fs.mkdirSync(path.join(tmpDir, 'logo'), { recursive: true });
      fs.readdirSync(logoDir).forEach(f => {
        try { fs.copyFileSync(path.join(logoDir, f), path.join(tmpDir, 'logo', f)); } catch {}
      });
    }

    // Archiv erstellen
    execSync(`tar -czf "${archivePath}" -C "${tmpDir}" .`);

    // Aufräumen
    execSync(`rm -rf "${tmpDir}"`);

    res.download(archivePath, archiveName, () => {
      try { fs.unlinkSync(archivePath); } catch {}
    });
  } catch (err) {
    console.error('[BACKUP] Fehler:', err);
    req.session.flash = { type: 'error', text: 'Backup-Fehler: ' + err.message };
    res.redirect('/admin/backup');
  }
});

router.post('/backup/restore', adminOnly, backupUpload.single('backup'), (req, res) => {
  if (!req.file) {
    req.session.flash = { type: 'error', text: 'Keine Datei hochgeladen.' };
    return res.redirect('/admin/backup');
  }

  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'database.sqlite');
    const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    const logoDir = path.join(__dirname, '..', 'public', 'uploads', 'logo');

    // Archiv in temporäres Verzeichnis entpacken
    const tmpDir = path.join(os.tmpdir(), 'pdf-freigabe-restore-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xzf "${req.file.path}" -C "${tmpDir}"`);

    // Prüfen ob gültiges Backup
    const restoredDb = path.join(tmpDir, 'data', 'database.sqlite');
    if (!fs.existsSync(restoredDb)) {
      execSync(`rm -rf "${tmpDir}"`);
      fs.unlinkSync(req.file.path);
      req.session.flash = { type: 'error', text: 'Ungültiges Backup: Keine Datenbank gefunden.' };
      return res.redirect('/admin/backup');
    }

    // Datenbank ersetzen
    if (fs.existsSync(dbPath)) {
      const backupDir = path.join(__dirname, '..', 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      fs.copyFileSync(dbPath, path.join(backupDir, `pre-restore-${ts}.sqlite`));
    }
    // Datenbank schließen, ersetzen, neu öffnen
    const { closeDb, initialize: reinit } = require('../database');
    closeDb();
    fs.copyFileSync(restoredDb, dbPath);
    reinit();

    // PDFs ersetzen
    const restoredUploads = path.join(tmpDir, 'uploads');
    if (fs.existsSync(restoredUploads)) {
      // Alte PDFs löschen
      if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach(f => {
          try { fs.unlinkSync(path.join(uploadDir, f)); } catch {}
        });
      }
      // Neue PDFs kopieren
      fs.readdirSync(restoredUploads).forEach(f => {
        try { fs.copyFileSync(path.join(restoredUploads, f), path.join(uploadDir, f)); } catch {}
      });
    }

    // Logo ersetzen
    const restoredLogo = path.join(tmpDir, 'logo');
    if (fs.existsSync(restoredLogo)) {
      if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
      fs.readdirSync(restoredLogo).forEach(f => {
        try { fs.copyFileSync(path.join(restoredLogo, f), path.join(logoDir, f)); } catch {}
      });
    }

    // Aufräumen
    execSync(`rm -rf "${tmpDir}"`);
    fs.unlinkSync(req.file.path);

    req.session.flash = { type: 'success', text: 'Backup wiederhergestellt! App wird neu gestartet…' };
    res.redirect('/admin/backup');
    // Neustart nach Restore
    const { spawn } = require('child_process');
    const appDir = path.join(__dirname, '..');
    const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
      detached: true,
      stdio: 'ignore',
      cwd: appDir, env: process.env,
    });
    child.unref();
    setTimeout(() => process.exit(0), 800);
    return;
  } catch (err) {
    console.error('[RESTORE] Fehler:', err);
    req.session.flash = { type: 'error', text: 'Fehler: ' + err.message };
  }
  res.redirect('/admin/backup');
});

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEMINFO
// ═══════════════════════════════════════════════════════════════════════════
router.get('/sysinfo', adminOnly, (req, res) => {
  const db = getDb();
  const formatBytes = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(1) + ' GB';
  const formatUptime = (s) => { const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return `${d}d ${h}h ${m}m`; };

  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'database.sqlite');
  const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const sessPath = path.join(__dirname, '..', 'data', 'sessions.sqlite');

  let dbSize = '–', uploadsSize = '–', uploadCount = 0, sessionsSize = '–';
  try { dbSize = formatBytes(fs.statSync(dbPath).size); } catch {}
  try { sessionsSize = formatBytes(fs.statSync(sessPath).size); } catch {}
  try { const files = fs.readdirSync(uploadDir); uploadCount = files.length; let total = 0; files.forEach(f => { try { total += fs.statSync(path.join(uploadDir, f)).size; } catch {} }); uploadsSize = formatBytes(total); } catch {}

  let npmVersion = '–';
  try { npmVersion = execSync('npm -v 2>/dev/null').toString().trim(); } catch {}

  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const deps = Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version: version.replace('^', '') }));

  let diskFree = null, diskTotal = null, diskUsed = null, diskPercent = 0;
  try {
    const dfOut = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
    diskTotal = dfOut[1]; diskUsed = dfOut[2]; diskFree = dfOut[3]; diskPercent = parseInt(dfOut[4]) || 0;
  } catch {}

  const sysinfo = {
    hostname: os.hostname(), os: `${os.type()} ${os.release()}`, arch: os.arch(),
    uptime: formatUptime(os.uptime()), appUptime: formatUptime(process.uptime()),
    totalMem: formatBytes(os.totalmem()), freeMem: formatBytes(os.freemem()),
    appMem: formatBytes(process.memoryUsage().rss), memPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    nodeVersion: process.version, npmVersion, sqliteVersion,
    expressVersion: require('express/package.json').version, appVersion: pkg.version,
    dbSize, uploadsSize, uploadCount, sessionsSize,
    diskFree, diskTotal, diskUsed, diskPercent,
    deps,
    counts: {
      users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      customers: db.prepare('SELECT COUNT(*) AS c FROM customers').get().c,
      contacts: db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c,
      jobs: db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c,
      versions: db.prepare('SELECT COUNT(*) AS c FROM job_versions').get().c,
      auditLogs: db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c,
    },
  };

  res.render('admin/sysinfo', { title: 'Systeminformationen', sysinfo });
});

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE / NPM-OUTDATED
// ═══════════════════════════════════════════════════════════════════════════

router.post('/update', adminOnly, (req, res) => {
  const appDir = path.join(__dirname, '..');
  const logFile = path.join(appDir, 'update.log');
  res.json({ ok: true });

  const log = (msg) => { try { fs.appendFileSync(logFile, msg + '\n'); } catch(_) {} };
  log(`\n\n=== Update gestartet: ${new Date().toISOString()} ===`);

  // Setup-Script kümmert sich um Backup, Dateien kopieren, npm install und Neustart
  const setupScript = path.join(appDir, 'setup.sh');
  const { spawn } = require('child_process');
  const child = spawn('sudo', [setupScript, '--update'], {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    cwd: appDir,
  });
  child.unref();
  // Prozess beenden — setup.sh startet den Service neu
  setTimeout(() => process.exit(0), 500);
});

router.get('/update-log', adminOnly, (req, res) => {
  const logFile = path.join(__dirname, '..', 'update.log');
  try { res.json({ log: fs.readFileSync(logFile, 'utf8').slice(-10000) }); }
  catch(e) { res.json({ log: 'Kein Log vorhanden.' }); }
});

router.get('/npm-outdated', adminOnly, (req, res) => {
  const appDir = path.join(__dirname, '..');
  try {
    const out = execSync('npm outdated --json 2>/dev/null || true', { cwd: appDir, encoding: 'utf8', timeout: 30000 });
    let data = {};
    try { data = JSON.parse(out || '{}'); } catch(e) {}
    res.json({ packages: Object.entries(data).map(([name, i]) => ({ name, current: i.current||'?', wanted: i.wanted||'?', latest: i.latest||'?' })) });
  } catch(e) { res.json({ packages: [], error: e.message }); }
});

router.get('/latest-version', adminOnly, async (req, res) => {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const r = https.get('https://api.github.com/repos/ipod86/PDF-Freigabe/releases/latest',
        { headers: { 'User-Agent': 'pdf-freigabe' } }, (resp) => {
          let body = '';
          resp.on('data', d => body += d);
          resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        });
      r.on('error', reject);
      r.setTimeout(5000, () => { r.destroy(); reject(new Error('timeout')); });
    });
    res.json({ tag_name: data.tag_name || null });
  } catch(e) { res.json({ tag_name: null, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// JOB-VORLAGEN
// ═══════════════════════════════════════════════════════════════════════════
router.get('/job-templates', (req, res) => {
  const db = getDb();
  const templates = db.prepare(`
    SELECT jt.*, c.company AS customer_company, u.name AS creator_name
    FROM job_templates jt
    LEFT JOIN customers c ON c.id = jt.customer_id
    LEFT JOIN users u ON u.id = jt.created_by
    ORDER BY jt.name
  `).all();
  const customers = db.prepare('SELECT id, company FROM customers WHERE active=1 ORDER BY company').all();
  res.render('admin/job_templates', { title: 'Job-Vorlagen', templates, customers });
});

router.post('/job-templates', (req, res) => {
  const db = getDb();
  const { name, customer_id, job_name_prefix, description, internal_comment, visibility, email_customer, email_creator, no_reminder } = req.body;
  if (!name) { req.session.flash = { type: 'error', text: 'Name erforderlich.' }; return res.redirect('/admin/job-templates'); }
  db.prepare(`INSERT INTO job_templates (name, customer_id, job_name_prefix, description, internal_comment, visibility, email_customer, email_creator, no_reminder, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, customer_id || null, job_name_prefix || null, description || null, internal_comment || null,
      visibility || 'team', email_customer === '1' ? 1 : 0, email_creator === '1' ? 1 : 0,
      no_reminder === '1' ? 1 : 0, req.session.user.id);
  req.session.flash = { type: 'success', text: `Vorlage "${name}" erstellt.` };
  res.redirect('/admin/job-templates');
});

router.post('/job-templates/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM job_templates WHERE id=?').run(req.params.id);
  req.session.flash = { type: 'success', text: 'Vorlage gelöscht.' };
  res.redirect('/admin/job-templates');
});

// ═══════════════════════════════════════════════════════════════════════════
// PORTAL-BENUTZER
// ═══════════════════════════════════════════════════════════════════════════
router.post('/customers/:id/portal-user', (req, res) => {
  const db = getDb();
  const { email, name, password } = req.body;
  if (!email || !name || !password) {
    req.session.flash = { type: 'error', text: 'Alle Felder ausfüllen.' };
    return res.redirect('/admin/customers');
  }
  const hash = bcrypt.hashSync(password, 12);
  try {
    db.prepare('INSERT INTO customer_users (customer_id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(req.params.id, email, hash, name);
    req.session.flash = { type: 'success', text: `Portal-Benutzer "${name}" angelegt.` };
  } catch (e) {
    req.session.flash = { type: 'error', text: 'Fehler: ' + e.message };
  }
  res.redirect('/admin/customers');
});

// Portal-Zugang direkt von einem Kontakt anlegen
router.post('/contacts/:id/portal-user', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
  if (!contact) return res.redirect('/admin/customers');
  const { email, name, password } = req.body;
  if (!email || !name || !password) {
    req.session.flash = { type: 'error', text: 'Alle Felder ausfüllen.' };
    return res.redirect(`/admin/customers/${contact.customer_id}/contacts`);
  }
  const hash = bcrypt.hashSync(password, 12);
  try {
    db.prepare('INSERT INTO customer_users (customer_id, contact_id, email, password_hash, name) VALUES (?, ?, ?, ?, ?)').run(contact.customer_id, contact.id, email, hash, name);
    req.session.flash = { type: 'success', text: `Portal-Zugang für "${name}" angelegt.` };
  } catch (e) {
    req.session.flash = { type: 'error', text: 'Fehler: ' + e.message };
  }
  res.redirect(`/admin/customers/${contact.customer_id}/contacts`);
});

router.post('/portal-users/:id/update', adminOnly, (req, res) => {
  const db = getDb();
  const pu = db.prepare('SELECT customer_id, contact_id FROM customer_users WHERE id=?').get(req.params.id);
  if (!pu) return res.redirect('/admin/customers');
  const { name, email } = req.body;
  try {
    db.prepare('UPDATE customer_users SET name=?, email=? WHERE id=?').run(name, email, req.params.id);
    req.session.flash = { type: 'success', text: 'Portal-Zugang aktualisiert.' };
  } catch (e) {
    req.session.flash = { type: 'error', text: 'Fehler: ' + e.message };
  }
  res.redirect(pu.contact_id ? `/admin/customers/${pu.customer_id}/contacts` : '/admin/customers');
});

router.post('/portal-users/:id/delete', adminOnly, (req, res) => {
  const db = getDb();
  const pu = db.prepare('SELECT customer_id, contact_id FROM customer_users WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM customer_users WHERE id=?').run(req.params.id);
  req.session.flash = { type: 'success', text: 'Portal-Zugang gelöscht.' };
  res.redirect(pu && pu.contact_id ? `/admin/customers/${pu.customer_id}/contacts` : '/admin/customers');
});

router.post('/portal-users/:id/reset-password', adminOnly, (req, res) => {
  const db = getDb();
  const pu = db.prepare('SELECT customer_id, contact_id FROM customer_users WHERE id=?').get(req.params.id);
  const { new_password } = req.body;
  if (!new_password) { req.session.flash = { type: 'error', text: 'Passwort eingeben.' }; return res.redirect('/admin/customers'); }
  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE customer_users SET password_hash=? WHERE id=?').run(hash, req.params.id);
  req.session.flash = { type: 'success', text: 'Passwort zurückgesetzt.' };
  res.redirect(pu && pu.contact_id ? `/admin/customers/${pu.customer_id}/contacts` : '/admin/customers');
});

module.exports = router;
