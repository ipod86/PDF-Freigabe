// ─── routes/auth.js ──────────────────────────────────────────────────────────
// Security: Session Fixation Protection, Constant-Time Password Check
// ──────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');

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
