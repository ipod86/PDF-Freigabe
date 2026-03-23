// ─── server.js ───────────────────────────────────────────────────────────────
// Security-gehärteter Express 5 Server
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express     = require('express');
const session     = require('express-session');
const cookieParser = require('cookie-parser');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// ─── Globale Fehlerbehandlung ───────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  if (!IS_PROD) console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled Rejection:', err);
});

// ─── Verzeichnisse ──────────────────────────────────────────────────────────
const dataDir   = path.join(__dirname, 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(dataDir))   fs.mkdirSync(dataDir,   { recursive: true });
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir,  { recursive: true });

// ─── Session-Secret validieren ──────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'dev-secret-change-me') {
  if (IS_PROD) {
    console.error('[SECURITY] FATAL: Kein sicheres SESSION_SECRET gesetzt!');
    console.error('  Bitte in .env setzen: SESSION_SECRET=$(openssl rand -hex 48)');
    process.exit(1);
  } else {
    console.warn('[SECURITY] WARNUNG: Kein sicheres SESSION_SECRET – nur in Entwicklung akzeptabel!');
  }
}

// ─── Datenbank ──────────────────────────────────────────────────────────────
const { initialize } = require('./database');
initialize();

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Trust Proxy (für Reverse Proxy / Caddy / nginx)
// ═══════════════════════════════════════════════════════════════════════════
// Ermöglicht korrekte IP-Erkennung und secure cookies hinter einem Proxy
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Request-Logging (nicht-verbose in Produktion)
// ═══════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  if (/^\/(css|js|img|fonts|vendor|favicon)/.test(req.path)) return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ts = new Date().toLocaleTimeString('de-DE');
    // In Produktion: nur Warnungen und Fehler
    if (IS_PROD && res.statusCode < 400) return;
    console.log(`[${ts}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Helmet (HTTP Security Headers)
// ═══════════════════════════════════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,  // WICHTIG: Defaults enthalten upgrade-insecure-requests
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "blob:"],
      fontSrc:    ["'self'"],
      connectSrc: ["'self'"],
      frameSrc:   ["'self'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
      // KEIN upgrade-insecure-requests! Sonst geht HTTP nicht.
    }
  },
  hsts: false,                    // Caddy/nginx setzt HSTS, nicht die App
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,  // Verursacht Warnungen bei HTTP
  crossOriginResourcePolicy: false,
  originAgentCluster: false,       // Verhindert Agent-Cluster-Warnung bei HTTP
}));

app.use(compression());

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Body Parser mit strikten Limits
// ═══════════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 50 }));
app.use(cookieParser());

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════
// Login: max 10 Versuche pro 15 Minuten
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Zu viele Anmeldeversuche. Bitte 15 Minuten warten.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Kunden-Freigabeseite: max 30 Requests pro 15 Minuten
const approveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Zu viele Anfragen. Bitte später erneut versuchen.',
  standardHeaders: true,
  legacyHeaders: false,
});

// API: max 200 Requests pro 15 Minuten
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Sessions
// ═══════════════════════════════════════════════════════════════════════════
let sessionConfig = {
  secret: SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  name: 'sid',  // Nicht den default 'connect.sid' verwenden (Fingerprinting)
  resave: false,
  saveUninitialized: true,   // Nötig damit Login-Seite ein CSRF-Token bekommt
  cookie: {
    secure: false,    // Auf false lassen! Bei HTTPS hinter Proxy: trust proxy + sameSite reichen
    httpOnly: true,   // Kein JS-Zugriff auf Session-Cookie
    maxAge: 8 * 60 * 60 * 1000,  // 8 Stunden
    sameSite: 'lax',  // CSRF-Schutz auf Cookie-Ebene
  }
};

try {
  const SQLiteStore = require('connect-sqlite3')(session);
  sessionConfig.store = new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir });
  console.log('[INIT] Session-Store: SQLite');
} catch (err) {
  console.warn('[INIT] SQLite-Store fehlgeschlagen:', err.message);
}

app.use(session(sessionConfig));

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: CSRF-Schutz
// Strategie:
// 1. Token in Session gespeichert + als Cookie gesetzt (JS kann es lesen)
// 2. Formulare senden Token als _csrf hidden field
// 3. AJAX sendet Token als X-CSRF-Token header
// 4. Multipart-Routen: geschützt durch SameSite=lax + requireLogin
//    (Multer parst den Body erst nach CSRF-Middleware, daher _csrf
//     nicht lesbar → SameSite=lax verhindert cross-site POSTs)
// ═══════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  if (!req.session) return next();

  // Kein CSRF-Token für öffentliche Approve-Seiten (vermeidet unnötige Sessions)
  if (req.path.startsWith('/approve/') && req.method === 'GET') return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  // Cookie setzen damit JS den Token für AJAX-Requests lesen kann
  res.cookie('csrf-token', req.session.csrfToken, {
    httpOnly: false,
    sameSite: 'strict',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    path: '/',
  });

  // Nur POST/PUT/DELETE prüfen
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Öffentliche Routen ohne CSRF
  if (req.path.startsWith('/approve/')) return next();

  // Multipart-Formulare: Body ist vor Multer nicht lesbar → kein _csrf verfügbar.
  // Schutz erfolgt durch SameSite=lax Session-Cookie (cross-site POSTs werden geblockt).
  if (req.is('multipart/form-data')) return next();

  // Token aus Header (für AJAX) oder Body (für reguläre Formulare).
  const token = req.headers['x-csrf-token'] || req.body?._csrf;

  if (!token || token !== req.session.csrfToken) {
    console.warn(`[CSRF] Abgelehnt: ${req.method} ${req.path}`);
    const contentType = req.headers['content-type'] || '';
    if (req.xhr || contentType.includes('application/json')) {
      return res.status(403).json({ error: 'CSRF-Token ungültig. Bitte Seite neu laden.' });
    }
    req.session.flash = { type: 'error', text: 'Sitzung abgelaufen – bitte erneut versuchen.' };
    return res.redirect(req.get('referer') || '/');
  }

  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// View Engine & Static Files
// ═══════════════════════════════════════════════════════════════════════════
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Statische Dateien mit Caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: IS_PROD ? '7d' : 0,
  etag: true,
  lastModified: true,
}));

// ═══════════════════════════════════════════════════════════════════════════
// Globale Template-Variablen
// ═══════════════════════════════════════════════════════════════════════════
const APP_VERSION = require('./package.json').version || '1';

app.use((req, res, next) => {
  res.locals.user    = req.session?.user || null;
  res.locals.path    = req.path;
  res.locals.v       = APP_VERSION;  // Cache-Buster für CSS/JS
  res.locals.flash   = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;

  // BaseURL: DB-Setting > .env > auto-detect
  try {
    const { getDb: gdb } = require('./database');
    const db = gdb();
    const row = db.prepare("SELECT value FROM settings WHERE key='base_url'").get();
    res.locals.baseUrl = (row && row.value) ? row.value : (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`);
    res.locals.companyLogo = db.prepare("SELECT value FROM settings WHERE key='company_logo'").get()?.value || null;
    res.locals.companyName = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'PDF-Freigabe';
  } catch {
    res.locals.baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.locals.companyLogo = null;
    res.locals.companyName = 'PDF-Freigabe';
  }

  if (req.session?.user) {
    try {
      const { getDb } = require('./database');
      res.locals.notificationCount = getDb().prepare(
        'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0'
      ).get(req.session.user.id)?.c || 0;
    } catch { res.locals.notificationCount = 0; }
  } else {
    res.locals.notificationCount = 0;
  }
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// Routen (mit Rate Limiters)
// ═══════════════════════════════════════════════════════════════════════════

// Datenschutz (öffentlich, kein Login)
app.get('/datenschutz', (req, res) => {
  try {
    const { getDb: gdb } = require('./database');
    const db = gdb();
    const text = db.prepare("SELECT value FROM settings WHERE key='privacy_policy'").get()?.value || '';
    const companyName = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Unternehmen';
    const companyLogo = db.prepare("SELECT value FROM settings WHERE key='company_logo'").get()?.value || null;
    const primaryColor = db.prepare("SELECT value FROM settings WHERE key='primary_color'").get()?.value || '#4361ee';
    res.render('datenschutz', { title: 'Datenschutz', privacyText: text, companyName, companyLogo, primaryColor });
  } catch {
    res.render('datenschutz', { title: 'Datenschutz', privacyText: '', companyName: 'Unternehmen', companyLogo: null, primaryColor: '#4361ee' });
  }
});

// Impressum (öffentlich, kein Login)
app.get('/impressum', (req, res) => {
  try {
    const { getDb: gdb } = require('./database');
    const db = gdb();
    const text = db.prepare("SELECT value FROM settings WHERE key='imprint'").get()?.value || '';
    const companyName = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'Unternehmen';
    const companyLogo = db.prepare("SELECT value FROM settings WHERE key='company_logo'").get()?.value || null;
    const primaryColor = db.prepare("SELECT value FROM settings WHERE key='primary_color'").get()?.value || '#4361ee';
    res.render('impressum', { title: 'Impressum', imprintText: text, companyName, companyLogo, primaryColor });
  } catch {
    res.render('impressum', { title: 'Impressum', imprintText: '', companyName: 'Unternehmen', companyLogo: null, primaryColor: '#4361ee' });
  }
});

app.post('/login', loginLimiter);    // Rate Limit VOR dem Auth-Router
app.use('/',          require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/jobs',      require('./routes/jobs'));
app.use('/approve',   approveLimiter, require('./routes/approve'));
app.use('/admin',     require('./routes/admin'));
app.use('/api',       require('./routes/api'));
app.use('/webhooks',  require('./routes/webhooks'));

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: 404 – keine Pfad-Informationen leaken
// ═══════════════════════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Nicht gefunden',
    message: 'Die angeforderte Seite existiert nicht.',
    code: 404,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: Error Handler – keine Stack Traces in Produktion
// ═══════════════════════════════════════════════════════════════════════════
app.use((err, req, res, _next) => {
  console.error('[ERROR]', IS_PROD ? err.message : err.stack);
  res.status(500).render('error', {
    title: 'Serverfehler',
    message: IS_PROD ? 'Ein interner Fehler ist aufgetreten.' : err.message,
    code: 500,
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log(`  ║  PDF-Freigabetool v1.0  (${IS_PROD ? 'PRODUKTION' : 'ENTWICKLUNG'})       ║`);
  console.log(`  ║  Port: ${PORT} | http://0.0.0.0:${PORT}                 ║`);
  console.log('  ╠═══════════════════════════════════════════════════╣');
  console.log(`  ║  Session:   ${SESSION_SECRET ? '✓ Eigenes Secret' : '⚠ Standard-Secret'}         ║`);
  console.log(`  ║  CSP:       ✓ Aktiv                              ║`);
  console.log(`  ║  CSRF:      ✓ Double Submit Cookie               ║`);
  console.log(`  ║  Rate-Limit: ✓ Login, Approve, API               ║`);
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
