// ─── middleware/auth.js ───────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'warn', text: 'Bitte melden Sie sich an.' };
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.session.flash = { type: 'error', text: 'Keine Berechtigung.' };
    return res.redirect('/dashboard');
  }
  next();
}

module.exports = { requireLogin, requireAdmin };
