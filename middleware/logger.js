// ─── middleware/logger.js ─────────────────────────────────────────────────────
// Request-Logging
// ──────────────────────────────────────────────────────────────────────────────

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const url = req.originalUrl;

    // Statische Assets nicht loggen
    if (url.startsWith('/css/') || url.startsWith('/js/') || url.startsWith('/img/') || url === '/favicon.ico') {
      return;
    }

    const status = res.statusCode;
    const method = req.method.padEnd(4);
    const color = status >= 500 ? '\x1b[31m'   // rot
                : status >= 400 ? '\x1b[33m'   // gelb
                : status >= 300 ? '\x1b[36m'   // cyan
                : '\x1b[32m';                  // grün
    const reset = '\x1b[0m';

    console.log(`  ${color}${method}${reset} ${url} ${color}${status}${reset} ${duration}ms`);
  });

  next();
}

module.exports = { requestLogger };
