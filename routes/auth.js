// ─── routes/auth.js ──────────────────────────────────────────────────────────
// Security: Session Fixation Protection, Constant-Time Password Check
// ──────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { validatePassword } = require('../security');

router.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Anmelden' });
});

router.post('/login', (req, res) => {
  const email    = (req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password || '';

  // Validierung
  if (!email || !password) {
    req.session.flash = { type: 'error', text: 'E-Mail und Passwort erforderlich.' };
    return res.redirect('/login');
  }

  // E-Mail-Format prüfen (einfacher Schutz gegen Injection)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = { type: 'error', text: 'Ungültige E-Mail-Adresse.' };
    return res.redirect('/login');
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ? AND active = 1').get(email);

  // Constant-Time: Auch bei nicht-existierendem Benutzer hashen
  // (verhindert Timing-Angriffe zur Benutzer-Enumeration)
  if (!user) {
    bcrypt.compareSync(password, '$2a$12$000000000000000000000000000000000000000000');
    req.session.flash = { type: 'error', text: 'E-Mail oder Passwort ungültig.' };
    return res.redirect('/login');
  }

  const match = bcrypt.compareSync(password, user.password_hash);
  if (!match) {
    req.session.flash = { type: 'error', text: 'E-Mail oder Passwort ungültig.' };
    return res.redirect('/login');
  }

  // ═══ Session Fixation Protection ═══
  // Alte Session-Daten merken, dann Session regenerieren
  const flash = req.session.flash;
  req.session.regenerate((err) => {
    if (err) {
      console.error('[AUTH] Session-Regenerate Fehler:', err);
      req.session.flash = { type: 'error', text: 'Sitzungsfehler – bitte erneut versuchen.' };
      return res.redirect('/login');
    }

    // Benutzer in der neuen Session speichern
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };

    req.session.save((err) => {
      if (err) {
        console.error('[AUTH] Session-Save Fehler:', err);
        return res.redirect('/login');
      }
      console.log(`[AUTH] Login: ${user.name} (${user.role})`);
      res.redirect('/dashboard');
    });
  });
});

router.get('/invite/:token', (req, res) => {
  const db = getDb();
  const invite = db.prepare("SELECT * FROM user_invitations WHERE token = ? AND expires_at > datetime('now','localtime')").get(req.params.token);
  if (!invite) {
    req.session.flash = { type: 'error', text: 'Einladungslink ungültig oder abgelaufen.' };
    return res.redirect('/login');
  }
  res.render('invite', { title: 'Konto einrichten', invite });
});

router.post('/invite/:token', (req, res) => {
  const db = getDb();
  const invite = db.prepare("SELECT * FROM user_invitations WHERE token = ? AND expires_at > datetime('now','localtime')").get(req.params.token);
  if (!invite) {
    req.session.flash = { type: 'error', text: 'Einladungslink ungültig oder abgelaufen.' };
    return res.redirect('/login');
  }

  const name     = (req.body.name || '').trim();
  const password = req.body.password || '';

  if (!name) {
    req.session.flash = { type: 'error', text: 'Bitte geben Sie Ihren Namen ein.' };
    return res.redirect(`/invite/${req.params.token}`);
  }
  const pwErr = validatePassword(password);
  if (pwErr) {
    req.session.flash = { type: 'error', text: pwErr };
    return res.redirect(`/invite/${req.params.token}`);
  }
  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(invite.email.toLowerCase())) {
    req.session.flash = { type: 'error', text: 'Für diese E-Mail existiert bereits ein Konto.' };
    return res.redirect('/login');
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, invite.email, hash, invite.role);
  db.prepare('DELETE FROM user_invitations WHERE id = ?').run(invite.id);

  console.log(`[AUTH] Neues Konto über Einladung: ${invite.email} (${invite.role})`);
  req.session.flash = { type: 'success', text: 'Konto erfolgreich eingerichtet. Bitte melden Sie sich an.' };
  res.redirect('/login');
});

router.get('/logout', (req, res) => {
  const name = req.session?.user?.name;
  req.session.destroy((err) => {
    // Session-Cookie löschen
    res.clearCookie('sid');
    res.clearCookie('csrf-token');
    if (name) console.log(`[AUTH] Logout: ${name}`);
    res.redirect('/login');
  });
});

router.get('/profile', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('profile', { title: 'Mein Profil' });
});

router.get('/notifications', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { getAll, getUnread } = require('../notifications');
  const notifications = getAll(req.session.user.id, 100);
  const unreadCount = getUnread(req.session.user.id).length;
  res.render('notifications', { title: 'Benachrichtigungen', notifications, unreadCount });
});

module.exports = router;
