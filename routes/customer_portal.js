// ─── routes/customer_portal.js ───────────────────────────────────────────────
// Kunden-Portal: Login, Dashboard, Freigaben ansehen
// ──────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database');

const portalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function requireCustomerLogin(req, res, next) {
  if (!req.session.customerUser) return res.redirect('/portal/login');
  next();
}

// GET /portal/login
router.get('/login', (req, res) => {
  if (req.session.customerUser) return res.redirect('/portal');
  const db = getDb();
  const settings = {};
  try { db.prepare('SELECT key, value FROM settings').all().forEach(r => settings[r.key] = r.value); } catch {}
  res.render('portal/login', {
    title: 'Kunden-Portal',
    error: req.query.error === '1',
    user: null,
    companyName: settings.company_name || 'PDF-Freigabe',
    companyLogo: settings.company_logo || null,
    primaryColor: settings.primary_color || '#4361ee',
  });
});

// POST /portal/login
router.post('/login', portalLimiter, (req, res) => {
  const db = getDb();
  const { email, password } = req.body;
  const cu = db.prepare('SELECT * FROM customer_users WHERE email = ? AND active = 1').get(email);
  if (!cu || !bcrypt.compareSync(password, cu.password_hash)) {
    return res.redirect('/portal/login?error=1');
  }
  db.prepare("UPDATE customer_users SET last_login = datetime('now','localtime') WHERE id = ?").run(cu.id);
  req.session.customerUser = { id: cu.id, customer_id: cu.customer_id, email: cu.email, name: cu.name };
  req.session.save(() => res.redirect('/portal'));
});

// GET /portal/logout
router.get('/logout', (req, res) => {
  delete req.session.customerUser;
  res.redirect('/portal/login');
});

// GET /portal
router.get('/', requireCustomerLogin, (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT j.*, u.name AS creator_name, co.name AS contact_name
    FROM jobs j
    JOIN users u ON u.id = j.creator_id
    JOIN contacts co ON co.id = j.contact_id
    WHERE j.customer_id = ? AND j.archived = 0
    ORDER BY j.created_at DESC
  `).all(req.session.customerUser.customer_id);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerUser.customer_id);
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => settings[r.key] = r.value);

  let baseUrl = settings.base_url || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  res.render('portal/dashboard', {
    title: 'Meine Freigaben',
    jobs,
    customer,
    customerUser: req.session.customerUser,
    companyName: settings.company_name || 'PDF-Freigabe',
    companyLogo: settings.company_logo || null,
    primaryColor: settings.primary_color || '#4361ee',
    baseUrl,
    user: null,
  });
});

module.exports = router;
module.exports.requireCustomerLogin = requireCustomerLogin;
