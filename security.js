// ─── security.js ─────────────────────────────────────────────────────────────
// Zentrale Sicherheitsfunktionen
// ──────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

/**
 * Prüft ob eine hochgeladene Datei tatsächlich ein PDF ist (Magic Bytes)
 * Der MIME-Type vom Client ist nicht vertrauenswürdig.
 */
function validatePdfFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    // PDF Magic Bytes: %PDF-
    return buf.toString('ascii').startsWith('%PDF-');
  } catch {
    return false;
  }
}

/**
 * Validiert hochgeladene Dateien (Array von multer files)
 * Löscht ungültige Dateien und gibt nur valide zurück.
 */
function filterValidPdfs(files, uploadDir) {
  const valid = [];
  for (const file of files) {
    const filePath = path.join(uploadDir || '', file.path || file.destination + '/' + file.filename);
    if (validatePdfFile(filePath)) {
      valid.push(file);
    } else {
      console.warn(`[SECURITY] Ungültige PDF abgelehnt: ${file.originalname}`);
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
  return valid;
}

/**
 * Passwort-Policy prüfen
 * @returns {string|null} Fehlermeldung oder null wenn OK
 */
function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Passwort muss mindestens 8 Zeichen lang sein.';
  }
  if (password.length > 128) {
    return 'Passwort darf maximal 128 Zeichen lang sein.';
  }
  // Mindestens ein Buchstabe und eine Zahl
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Passwort muss Buchstaben und Zahlen enthalten.';
  }
  return null;
}

/**
 * Escaped Sonderzeichen für LIKE-Queries
 * Verhindert, dass Benutzer mit % und _ beliebige Muster matchen
 */
function escapeLike(str) {
  if (!str) return str;
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Sanitiert einen String für sichere Ausgabe
 * (EJS escaped standardmäßig, aber für Kontexte wie PDFKit nötig)
 */
function sanitizeString(str, maxLength = 1000) {
  if (!str) return '';
  return String(str)
    .substring(0, maxLength)
    .replace(/[<>]/g, '')  // HTML-Tags entfernen
    .trim();
}

/**
 * Generiert einen sicheren Dateinamen (kein Path Traversal)
 */
function safeFilename(original) {
  // Nur Basisname (kein Pfad), gefährliche Zeichen entfernen
  const base = path.basename(original || 'datei.pdf');
  return base.replace(/[^\w\s\-_.äöüÄÖÜß]/g, '_').substring(0, 200);
}

module.exports = {
  validatePdfFile,
  filterValidPdfs,
  validatePassword,
  escapeLike,
  sanitizeString,
  safeFilename,
};
