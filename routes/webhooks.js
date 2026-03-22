// ─── routes/webhooks.js ──────────────────────────────────────────────────────
const router = require('express').Router();
const crypto = require('crypto');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { getDb } = require('../database');

/**
 * SSRF-Schutz: Nur öffentliche http/https-URLs erlauben.
 * Blockiert localhost, private IPs (RFC 1918), Link-Local, Loopback usw.
 */
function isSafeWebhookUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  // Bekannte lokale Namen
  if (['localhost', 'localhost.localdomain', '0.0.0.0', ''].includes(host)) return false;
  // IP-basierte Prüfung
  try {
    const { isIPv4, isIPv6 } = require('net');
    if (isIPv4(host) || isIPv6(host)) {
      // Einfache String-Checks für private/reservierte Bereiche
      if (/^127\./.test(host)) return false;              // Loopback
      if (/^10\./.test(host)) return false;               // RFC 1918
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false; // RFC 1918
      if (/^192\.168\./.test(host)) return false;         // RFC 1918
      if (/^169\.254\./.test(host)) return false;         // Link-Local (AWS metadata)
      if (/^::1$/.test(host)) return false;               // IPv6 Loopback
      if (/^fd/.test(host) || /^fc/.test(host)) return false; // IPv6 ULA
      if (host === '0.0.0.0') return false;
    }
  } catch { /* kein IP-Adressenformat — hostname erlaubt */ }
  return true;
}

router.get('/', requireLogin, requireAdmin, (req, res) => {
  res.render('admin/webhooks', { title: 'Webhooks', hooks: getDb().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() });
});

router.post('/', requireLogin, requireAdmin, (req, res) => {
  const { name, url, events, method } = req.body;
  if (!isSafeWebhookUrl(url)) {
    req.session.flash = { type: 'error', text: 'Ungültige URL. Nur öffentliche http/https-URLs sind erlaubt (keine lokalen IPs oder privaten Netzwerke).' };
    return res.redirect('/webhooks');
  }
  const secret = crypto.randomBytes(20).toString('hex');
  getDb().prepare('INSERT INTO webhooks (name, url, events, method, secret) VALUES (?, ?, ?, ?, ?)').run(name, url, events || 'all', method || 'POST', secret);
  req.session.flash = { type: 'success', text: `Webhook "${name}" erstellt.` };
  res.redirect('/webhooks');
});

router.post('/:id/delete', requireLogin, requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM webhooks WHERE id=?').run(req.params.id);
  req.session.flash = { type: 'success', text: 'Webhook gelöscht.' };
  res.redirect('/webhooks');
});

router.post('/:id/toggle', requireLogin, requireAdmin, (req, res) => {
  getDb().prepare('UPDATE webhooks SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);
  res.redirect('/webhooks');
});

async function triggerWebhooks(event, payload) {
  try {
    const db = getDb();
    const hooks = db.prepare("SELECT * FROM webhooks WHERE active=1 AND (events='all' OR events LIKE ?)").all(`%${event}%`);
    for (const hook of hooks) {
      try {
        const method = (hook.method || 'POST').toUpperCase();
        const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
        const headers = { 'Content-Type': 'application/json', 'User-Agent': 'PDF-Freigabe-Webhook/1.0', 'X-Webhook-Event': event };

        if (hook.secret) {
          headers['X-Webhook-Signature'] = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
        }

        let url = hook.url;
        // Nochmalige SSRF-Prüfung zur Laufzeit (URL könnte aus älteren Einträgen kommen)
        if (!isSafeWebhookUrl(url)) {
          console.warn(`[WEBHOOK] Übersprungen – unsichere URL "${url}" für Hook "${hook.name}"`);
          continue;
        }
        let fetchOpts = { method, headers, signal: AbortSignal.timeout(10000) };

        if (method === 'GET') {
          // Bei GET: Daten als Query-Parameter anhängen
          const params = new URLSearchParams({ event, job_name: payload.job_name || '', status: payload.status || '' });
          url += (url.includes('?') ? '&' : '?') + params.toString();
        } else {
          fetchOpts.body = body;
        }

        const response = await fetch(url, fetchOpts);
        db.prepare(`UPDATE webhooks SET last_triggered=datetime('now','localtime'), last_status=? WHERE id=?`).run(response.status, hook.id);
      } catch (err) {
        console.error(`[WEBHOOK] Fehler "${hook.name}":`, err.message);
        db.prepare(`UPDATE webhooks SET last_triggered=datetime('now','localtime'), last_status=0 WHERE id=?`).run(hook.id);
      }
    }
  } catch (err) { console.error('[WEBHOOK]', err.message); }
}

module.exports = router;
module.exports.triggerWebhooks = triggerWebhooks;
