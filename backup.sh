#!/bin/bash
###############################################################################
#  PDF-Freigabetool – Datenbank-Backup Script
#  Aufruf: bash backup.sh
#  Cronjob: 0 2 * * * cd /opt/pdf-freigabe && bash backup.sh
###############################################################################
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pdf-freigabe}"
BACKUP_DIR="${APP_DIR}/backups"
DB_PATH="${APP_DIR}/data/database.sqlite"
UPLOAD_DIR="${APP_DIR}/uploads"
MAX_BACKUPS=14  # 2 Wochen aufheben

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

log() { echo -e "${GREEN}[✔]${NC} $1"; }
err() { echo -e "${RED}[✘]${NC} $1"; exit 1; }

# Backup-Verzeichnis erstellen
mkdir -p "${BACKUP_DIR}"

# ─── Datenbank-Backup ────────────────────────────────────────────────────────
if [[ -f "${DB_PATH}" ]]; then
  BACKUP_FILE="${BACKUP_DIR}/db_${TIMESTAMP}.sqlite"
  sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"
  gzip "${BACKUP_FILE}"
  log "Datenbank gesichert: db_${TIMESTAMP}.sqlite.gz"
else
  err "Datenbank nicht gefunden: ${DB_PATH}"
fi

# ─── Upload-Verzeichnis sichern ──────────────────────────────────────────────
if [[ -d "${UPLOAD_DIR}" ]]; then
  UPLOAD_COUNT=$(find "${UPLOAD_DIR}" -name "*.pdf" | wc -l)
  if [[ ${UPLOAD_COUNT} -gt 0 ]]; then
    tar -czf "${BACKUP_DIR}/uploads_${TIMESTAMP}.tar.gz" -C "$(dirname ${UPLOAD_DIR})" "$(basename ${UPLOAD_DIR})"
    log "Uploads gesichert: uploads_${TIMESTAMP}.tar.gz (${UPLOAD_COUNT} PDFs)"
  else
    log "Keine PDFs vorhanden – Upload-Backup übersprungen"
  fi
fi

# ─── Alte Backups aufräumen ──────────────────────────────────────────────────
cd "${BACKUP_DIR}"
DB_COUNT=$(ls -1 db_*.sqlite.gz 2>/dev/null | wc -l)
if [[ ${DB_COUNT} -gt ${MAX_BACKUPS} ]]; then
  ls -1t db_*.sqlite.gz | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f
  log "Alte DB-Backups bereinigt (behalte ${MAX_BACKUPS})"
fi

UPLOAD_BACKUP_COUNT=$(ls -1 uploads_*.tar.gz 2>/dev/null | wc -l)
if [[ ${UPLOAD_BACKUP_COUNT} -gt ${MAX_BACKUPS} ]]; then
  ls -1t uploads_*.tar.gz | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f
  log "Alte Upload-Backups bereinigt (behalte ${MAX_BACKUPS})"
fi

# ─── Zusammenfassung ─────────────────────────────────────────────────────────
TOTAL_SIZE=$(du -sh "${BACKUP_DIR}" | awk '{print $1}')
echo -e "${CYAN}[i]${NC} Backup-Verzeichnis: ${BACKUP_DIR} (${TOTAL_SIZE})"
log "Backup abgeschlossen: ${TIMESTAMP}"
