// ─── middleware/csrf.js ───────────────────────────────────────────────────────
// CSRF-Schutz – Token pro Session mit Rotation
// ──────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Pfade die KEINEN CSRF-Check brauchen
const EXEMPT_PATHS = [
  '/login',          // Login-Formular (eigene Auth-Logik)
  '/approve/',       // Kunden-Seite (öffentlich, Token-basiert)
  '/api/',           // JSON-API (eigene Auth-Header)
];

function csrfProtection(req, res, next) {
  // Sicherstellen dass Session existiert
  if (!req.session) {
    console.error('[CSRF] Keine Session vorhanden!');
    return next();
  }

  // Token erzeugen wenn noch keiner existiert
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateToken();
  }

  // Token im Template verfügbar machen
  res.locals.csrfToken = req.session.csrfToken;

  // Bei GET/HEAD/OPTIONS keine Prüfung
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Ausgenommene Pfade überspringen
  const isExempt = EXEMPT_PATHS.some(p => req.path === p || req.path.startsWith(p));
  if (isExempt) {
    return next();
  }

  // Token prüfen
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    console.warn(`[CSRF] Token-Mismatch auf ${req.method} ${req.path} (erwartet: ${req.session.csrfToken?.slice(0,8)}..., erhalten: ${token?.slice(0,8) || 'keiner'})`);
    req.session.flash = { type: 'error', text: 'Sitzung abgelaufen – bitte erneut versuchen.' };

    // Neuen Token generieren damit der nächste Versuch klappt
    req.session.csrfToken = generateToken();
    res.locals.csrfToken = req.session.csrfToken;

    const referer = req.get('referer') || '/dashboard';
    return res.redirect(referer);
  }

  // Nach erfolgreicher Prüfung neuen Token generieren (Rotation)
  req.session.csrfToken = generateToken();
  next();
}

module.exports = { csrfProtection };
