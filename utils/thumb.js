// ─── utils/thumb.js ──────────────────────────────────────────────────────────
// Generiert JPEG-Vorschaubilder (Seite 1) aus PDF-Dateien via pdftoppm.
// Thumbnails werden in UPLOAD_DIR/thumbs/ gecacht.
// ─────────────────────────────────────────────────────────────────────────────
const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const THUMB_DIR  = path.join(UPLOAD_DIR, 'thumbs');

function ensureThumbDir() {
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
}

function thumbPath(storedName) {
  return path.join(THUMB_DIR, path.basename(storedName, '.pdf') + '.jpg');
}

/**
 * Gibt den Pfad zum Thumbnail zurück. Generiert es falls nötig.
 * Gibt null zurück wenn pdftoppm nicht verfügbar oder Datei fehlt.
 */
function getOrCreateThumb(storedName) {
  const pdfPath  = path.join(UPLOAD_DIR, storedName);
  const jpgPath  = thumbPath(storedName);

  if (!fs.existsSync(pdfPath)) return null;
  if (fs.existsSync(jpgPath))  return jpgPath;

  try {
    ensureThumbDir();
    const outPrefix = path.join(THUMB_DIR, path.basename(storedName, '.pdf'));
    execSync(`pdftoppm -r 150 -jpeg -f 1 -l 1 "${pdfPath}" "${outPrefix}"`, { timeout: 15000 });

    // pdftoppm benennt die Datei {prefix}-1.jpg oder {prefix}-01.jpg usw.
    const generated = fs.readdirSync(THUMB_DIR)
      .filter(f => f.startsWith(path.basename(storedName, '.pdf') + '-') && f.endsWith('.jpg'))
      .map(f => path.join(THUMB_DIR, f))[0];

    if (generated) {
      fs.renameSync(generated, jpgPath);
      return jpgPath;
    }
  } catch (_) {
    // pdftoppm nicht installiert oder Fehler → kein Thumbnail
  }
  return null;
}

module.exports = { getOrCreateThumb, THUMB_DIR };
