#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  PDF-Freigabetool – Installations- & Update-Script
#  Für Debian 12+ / Ubuntu 22.04+
#
#  Verwendung:
#    sudo ./setup.sh          (erkennt automatisch ob Update nötig)
#    sudo ./setup.sh --update (Update ohne Nachfrage)
#    sudo ./setup.sh --fresh  (Erstinstallation erzwingen)
# ═══════════════════════════════════════════════════════════════
set -e

# ─── Farben ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ─── Root-Check ──────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Bitte als root ausführen: sudo ./setup.sh"
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="pdf-freigabe"
INSTALL_DIR="/opt/pdf-freigabe"
BACKUP_DIR="/tmp/pdf-freigabe-update-backup-$(date +%s)"

# ═══════════════════════════════════════════════════════════════════════════
# INSTALLATION IN /opt (Service-User braucht Zugriff)
# ═══════════════════════════════════════════════════════════════════════════
GIT_REPO="git@github.com:ipod86/PDF-Freigabe.git"

if [ "$APP_DIR" != "$INSTALL_DIR" ]; then
  # ─── Weg 1: /opt ist bereits ein git-Repo → git pull ─────────────────────
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Git-Repo in $INSTALL_DIR gefunden → git pull..."
    git -C "$INSTALL_DIR" reset --hard HEAD
    git -C "$INSTALL_DIR" pull
    ok "Code aktualisiert via git pull"
    APP_DIR="$INSTALL_DIR"
    echo ""

  # ─── Weg 2: /opt existiert noch nicht → git clone ────────────────────────
  elif [ ! -d "$INSTALL_DIR" ]; then
    info "Klone $GIT_REPO nach $INSTALL_DIR..."
    git clone "$GIT_REPO" "$INSTALL_DIR"
    ok "Repository geklont"
    APP_DIR="$INSTALL_DIR"
    echo ""

  # ─── Weg 3: /opt existiert aber kein git → cp (Fallback, wie bisher) ─────
  else
    info "App wird nach $INSTALL_DIR kopiert (kein git-Repo dort)..."
    info "(Service-User '$APP_USER' braucht Zugriff — /root ist nicht geeignet)"

    # Daten sichern
    if [ -d "$INSTALL_DIR/data" ]; then
      mkdir -p "$BACKUP_DIR"
      cp -r "$INSTALL_DIR/data" "$BACKUP_DIR/data" 2>/dev/null || true
      cp -r "$INSTALL_DIR/uploads" "$BACKUP_DIR/uploads" 2>/dev/null || true
      cp "$INSTALL_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null || true
      cp -r "$INSTALL_DIR/backups" "$BACKUP_DIR/backups" 2>/dev/null || true
      if [ -d "$INSTALL_DIR/public/uploads/logo" ]; then
        mkdir -p "$BACKUP_DIR/logo"
        cp -r "$INSTALL_DIR/public/uploads/logo/." "$BACKUP_DIR/logo/" 2>/dev/null || true
      fi
      ok "Bestehende Daten aus $INSTALL_DIR gesichert"
    fi

    # Code-Verzeichnisse aktualisieren (nie data/uploads anfassen!)
    rm -rf "$INSTALL_DIR/node_modules" "$INSTALL_DIR/routes" "$INSTALL_DIR/views" \
           "$INSTALL_DIR/middleware" "$INSTALL_DIR/cron" "$INSTALL_DIR/public" 2>/dev/null || true
    mkdir -p "$INSTALL_DIR"
    cp -a "$APP_DIR/." "$INSTALL_DIR/"
    rm -rf "$INSTALL_DIR/node_modules"

    # Daten wiederherstellen
    if [ -d "$BACKUP_DIR/data" ]; then
      mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/uploads" "$INSTALL_DIR/backups"
      cp -r "$BACKUP_DIR/data/." "$INSTALL_DIR/data/" 2>/dev/null || true
      cp -r "$BACKUP_DIR/uploads/." "$INSTALL_DIR/uploads/" 2>/dev/null || true
      cp "$BACKUP_DIR/.env" "$INSTALL_DIR/.env" 2>/dev/null || true
      cp -r "$BACKUP_DIR/backups/." "$INSTALL_DIR/backups/" 2>/dev/null || true
      if [ -d "$BACKUP_DIR/logo" ]; then
        mkdir -p "$INSTALL_DIR/public/uploads/logo"
        cp -r "$BACKUP_DIR/logo/." "$INSTALL_DIR/public/uploads/logo/" 2>/dev/null || true
      fi
      rm -rf "$BACKUP_DIR"
      ok "Daten wiederhergestellt"
    fi

    APP_DIR="$INSTALL_DIR"
    ok "App installiert in $INSTALL_DIR"
    echo ""
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# MODUS ERKENNEN
# ═══════════════════════════════════════════════════════════════════════════
UPDATE_MODE=false

# Explizite Flags
if [ "$1" = "--update" ] || [ "$1" = "-u" ]; then
  UPDATE_MODE=true
elif [ "$1" = "--fresh" ] || [ "$1" = "-f" ]; then
  UPDATE_MODE=false
else
  # Auto-Erkennung: Bestehende Installation? (prüft aktuellen UND Ziel-Pfad)
  EXISTING=false
  FOUND_ITEMS=""
  CHECK_DIR="$APP_DIR"
  [ -d "$INSTALL_DIR/data" ] && CHECK_DIR="$INSTALL_DIR"

  if [ -f "$CHECK_DIR/data/database.sqlite" ]; then
    EXISTING=true
    DB_SIZE=$(du -sh "$CHECK_DIR/data/database.sqlite" 2>/dev/null | cut -f1)
    FOUND_ITEMS="$FOUND_ITEMS\n    📁 Datenbank ($DB_SIZE)"
  fi

  if [ -d "$CHECK_DIR/uploads" ] && [ "$(ls -A "$CHECK_DIR/uploads" 2>/dev/null)" ]; then
    EXISTING=true
    PDF_COUNT=$(ls "$CHECK_DIR/uploads" 2>/dev/null | wc -l)
    FOUND_ITEMS="$FOUND_ITEMS\n    📄 $PDF_COUNT PDF-Dateien"
  fi

  if [ -f "$CHECK_DIR/.env" ]; then
    EXISTING=true
    FOUND_ITEMS="$FOUND_ITEMS\n    ⚙️  .env-Konfiguration"
  fi

  if systemctl is-active --quiet pdf-freigabe 2>/dev/null; then
    EXISTING=true
    FOUND_ITEMS="$FOUND_ITEMS\n    🟢 Service läuft"
  elif systemctl is-enabled --quiet pdf-freigabe 2>/dev/null; then
    EXISTING=true
    FOUND_ITEMS="$FOUND_ITEMS\n    ⚪ Service installiert (gestoppt)"
  fi

  if $EXISTING; then
    echo ""
    echo -e "  ${YELLOW}╔═══════════════════════════════════════════════════╗${NC}"
    echo -e "  ${YELLOW}║  ⚠️  Bestehende Installation gefunden!            ║${NC}"
    echo -e "  ${YELLOW}╠═══════════════════════════════════════════════════╣${NC}"
    echo -e "  ${YELLOW}║${NC}  Folgendes wurde erkannt:"
    echo -e "$FOUND_ITEMS"
    echo -e "  ${YELLOW}║${NC}"
    echo -e "  ${YELLOW}║${NC}  ${BOLD}Update:${NC} Daten werden gesichert, Software"
    echo -e "  ${YELLOW}║${NC}  aktualisiert, Daten wiederhergestellt."
    echo -e "  ${YELLOW}║${NC}"
    echo -e "  ${YELLOW}║${NC}  ${BOLD}Neuinstallation:${NC} Alles wird gelöscht"
    echo -e "  ${YELLOW}║${NC}  und mit Testdaten neu aufgesetzt."
    echo -e "  ${YELLOW}╚═══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${BOLD}Was möchten Sie tun?${NC}"
    echo ""
    echo "    1) Update (Daten behalten)"
    echo "    2) Neuinstallation (alles löschen)"
    echo "    3) Abbrechen"
    echo ""
    read -p "  Auswahl [1/2/3]: " CHOICE

    case "$CHOICE" in
      1)
        UPDATE_MODE=true
        echo ""
        ;;
      2)
        UPDATE_MODE=false
        echo ""
        warn "Neuinstallation gewählt – bestehende Daten werden überschrieben!"
        read -p "  Wirklich fortfahren? (ja/nein): " CONFIRM
        if [ "$CONFIRM" != "ja" ]; then
          echo "  Abgebrochen."
          exit 0
        fi
        echo ""
        ;;
      *)
        echo "  Abgebrochen."
        exit 0
        ;;
    esac
  fi
fi

# ─── Banner ──────────────────────────────────────────────────────────────────
if $UPDATE_MODE; then
  echo "  ╔═══════════════════════════════════════════════════╗"
  echo "  ║  PDF-Freigabetool – UPDATE                        ║"
  echo "  ╠═══════════════════════════════════════════════════╣"
  echo "  ║  Verzeichnis: $APP_DIR"
  echo "  ║  Benutzer:    $APP_USER"
  echo "  ╚═══════════════════════════════════════════════════╝"
else
  echo "  ╔═══════════════════════════════════════════════════╗"
  echo "  ║  PDF-Freigabetool – ERSTINSTALLATION              ║"
  echo "  ╠═══════════════════════════════════════════════════╣"
  echo "  ║  Verzeichnis: $APP_DIR"
  echo "  ║  Benutzer:    $APP_USER"
  echo "  ╚═══════════════════════════════════════════════════╝"
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# UPDATE: Service stoppen (Datensicherung nur wenn kein git-Repo)
# ═══════════════════════════════════════════════════════════════════════════
if $UPDATE_MODE; then
  info "Service stoppen..."
  systemctl stop pdf-freigabe 2>/dev/null || true
  ok "Service gestoppt"

  # Bei git-Repos: kein Backup nötig (git pull berührt data/ und .env nicht)
  if [ ! -d "$APP_DIR/.git" ]; then
    info "Daten sichern..."
    mkdir -p "$BACKUP_DIR"

    cp -r "$APP_DIR/data" "$BACKUP_DIR/data" 2>/dev/null             && ok "Datenbank gesichert" || true
    cp -r "$APP_DIR/uploads" "$BACKUP_DIR/uploads" 2>/dev/null       && ok "PDFs gesichert" || true
    if [ -d "$APP_DIR/public/uploads/logo" ]; then
      mkdir -p "$BACKUP_DIR/logo"
      cp -r "$APP_DIR/public/uploads/logo/." "$BACKUP_DIR/logo/" 2>/dev/null && ok "Logo gesichert" || true
    fi
    cp "$APP_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null                && ok ".env gesichert" || true
    cp -r "$APP_DIR/backups" "$BACKUP_DIR/backups" 2>/dev/null       && ok "Backup-Archiv gesichert" || true
    echo ""
  else
    ok "git-Repo erkannt – Datensicherung nicht nötig (data/ und .env unberührt)"
    echo ""
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# INSTALLATION (beide Modi)
# ═══════════════════════════════════════════════════════════════════════════

# ─── System-Pakete ───────────────────────────────────────────────────────────
info "System-Pakete aktualisieren..."
apt-get update -qq
apt-get install -y -qq curl build-essential python3 tar gzip ca-certificates gnupg poppler-utils
ok "System-Pakete aktuell"

# ─── Service-Benutzer ────────────────────────────────────────────────────────
if id "$APP_USER" &>/dev/null; then
  ok "Benutzer '$APP_USER' vorhanden"
else
  info "Service-Benutzer '$APP_USER' anlegen (kein Shell-Zugang)..."
  useradd --system --no-create-home --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$APP_USER"
  ok "Benutzer '$APP_USER' angelegt (nologin)"
fi

# ─── Node.js 22 ──────────────────────────────────────────────────────────────
NEED_NODE=true
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 22 ]; then
    ok "Node.js $(node -v) vorhanden"
    NEED_NODE=false
  else
    warn "Node.js $(node -v) → Upgrade auf v22 nötig"
  fi
fi

if $NEED_NODE; then
  info "Node.js 22 installieren..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  ok "Node.js $(node -v) installiert"
fi

# ─── Verzeichnisse ───────────────────────────────────────────────────────────
mkdir -p "$APP_DIR"/{data,uploads,backups,public/fonts,public/vendor,public/uploads/logo}
# App-Verzeichnis gehört dem Service-User (Updates ohne sudo möglich)
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ─── Fonts & Assets ─────────────────────────────────────────────────────────
info "Lokale Fonts und JS-Bibliotheken herunterladen..."
[ -f "$APP_DIR/download-assets.sh" ] && bash "$APP_DIR/download-assets.sh" && ok "Assets heruntergeladen"

# ─── npm install ─────────────────────────────────────────────────────────────
info "Node.js-Module installieren..."
cd "$APP_DIR"
if $UPDATE_MODE; then
  rm -rf node_modules package-lock.json
fi
npm install --production 2>&1 | tail -3
ok "npm-Module installiert"

# Chart.js aus node_modules kopieren (zuverlässiger als CDN)
CHART_DEST="$APP_DIR/public/vendor/chart.umd.min.js"
if [ -f "$APP_DIR/node_modules/chart.js/dist/chart.umd.min.js" ]; then
  cp "$APP_DIR/node_modules/chart.js/dist/chart.umd.min.js" "$CHART_DEST"
  ok "Chart.js aus node_modules kopiert"
elif [ -f "$APP_DIR/node_modules/chart.js/dist/chart.umd.js" ]; then
  cp "$APP_DIR/node_modules/chart.js/dist/chart.umd.js" "$CHART_DEST"
  ok "Chart.js aus node_modules kopiert"
else
  warn "Chart.js nicht in node_modules gefunden! Statistik-Seite funktioniert ohne Chart.js nicht."
  warn "Manuell: npm install chart.js && cp node_modules/chart.js/dist/chart.umd.js public/vendor/chart.umd.min.js"
fi

# ═══════════════════════════════════════════════════════════════════════════
# UPDATE: Daten wiederherstellen (nur wenn kein git-Repo)
# ═══════════════════════════════════════════════════════════════════════════
if $UPDATE_MODE; then
  if [ ! -d "$APP_DIR/.git" ] && [ -d "$BACKUP_DIR" ]; then
    info "Daten wiederherstellen..."
    mkdir -p "$APP_DIR/data" "$APP_DIR/uploads" "$APP_DIR/backups" "$APP_DIR/public/uploads/logo"
    cp -r "$BACKUP_DIR/data/." "$APP_DIR/data/" 2>/dev/null               && ok "Datenbank wiederhergestellt" || true
    cp -r "$BACKUP_DIR/uploads/." "$APP_DIR/uploads/" 2>/dev/null         && ok "PDFs wiederhergestellt" || true
    cp "$BACKUP_DIR/.env" "$APP_DIR/.env" 2>/dev/null                     && ok ".env wiederhergestellt" || true
    cp -r "$BACKUP_DIR/backups/." "$APP_DIR/backups/" 2>/dev/null         && ok "Backup-Archiv wiederhergestellt" || true
    if [ -d "$BACKUP_DIR/logo" ]; then
      cp -r "$BACKUP_DIR/logo/." "$APP_DIR/public/uploads/logo/" 2>/dev/null && ok "Logo wiederhergestellt" || true
    fi
    rm -rf "$BACKUP_DIR"
    ok "Temporäre Sicherung aufgeräumt"
    echo ""
  fi

  # Migrationen ausführen
  info "Datenbank-Migrationen prüfen..."
  cd "$APP_DIR"
  su -s /bin/sh "$APP_USER" -c "node -e \"require('./database').initialize(); console.log('  \u2713 Migrationen erfolgreich');\"" || warn "Migrationen manuell prüfen"
  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════
# ERSTINSTALLATION: .env + Seed
# ═══════════════════════════════════════════════════════════════════════════
if ! $UPDATE_MODE; then
  if [ ! -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
    sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$SECRET/" "$APP_DIR/.env"
    ok ".env erstellt mit Session-Secret"
  fi

  if [ ! -f "$APP_DIR/data/database.sqlite" ]; then
    echo ""
    echo "  ┌─────────────────────────────────────────────────────┐"
    echo "  │  Admin-Zugangsdaten für den ersten Login festlegen  │"
    echo "  └─────────────────────────────────────────────────────┘"
    while true; do
      read -rp "  E-Mail:   " ADMIN_EMAIL
      [[ "$ADMIN_EMAIL" == *@*.* ]] && break
      echo "  ✗ Bitte eine gültige E-Mail-Adresse eingeben."
    done
    while true; do
      read -rsp "  Passwort: " ADMIN_PASS; echo ""
      [ ${#ADMIN_PASS} -ge 8 ] && break
      echo "  ✗ Passwort muss mindestens 8 Zeichen lang sein."
    done
    # Credentials sicher als Datei übergeben (vermeidet Shell-Escaping-Probleme)
    printf '%s\n%s\n' "$ADMIN_EMAIL" "$ADMIN_PASS" > /tmp/pf-admin-init
    chmod 600 /tmp/pf-admin-init
    info "Datenbank initialisieren..."
    cd "$APP_DIR"
    su -s /bin/sh "$APP_USER" -c "node seed.js" 2>&1 | tail -20
    rm -f /tmp/pf-admin-init
    ok "Initialdaten angelegt"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# GEMEINSAM: Berechtigungen + Service
# ═══════════════════════════════════════════════════════════════════════════

# Code-Verzeichnis: root besitzt, Service-User kann lesen
chown -R root:root "$APP_DIR"
chmod -R 755 "$APP_DIR"

# Schreibbare Verzeichnisse: Service-User besitzt
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$APP_DIR/uploads" "$APP_DIR/backups" "$APP_DIR/public/uploads"
chmod -R 750 "$APP_DIR/data" "$APP_DIR/uploads" "$APP_DIR/backups"

# .env: nur root + Service-User lesbar
if [ -f "$APP_DIR/.env" ]; then
  chown root:"$APP_USER" "$APP_DIR/.env"
  chmod 640 "$APP_DIR/.env"
fi

cat > /etc/systemd/system/pdf-freigabe.service << EOF
[Unit]
Description=PDF-Freigabetool
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(which node) server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pdf-freigabe

# Umgebung
EnvironmentFile=-$APP_DIR/.env
Environment=NODE_ENV=production
Environment=PORT=3000

# Security Hardening
PrivateTmp=false
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
ReadWritePaths=$APP_DIR /tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pdf-freigabe

# ─── Erinnerungen/Wiedervorlagen Timer ───────────────────────────────────────
cat > /etc/systemd/system/pdf-freigabe-cron.service << EOF
[Unit]
Description=PDF-Freigabe Erinnerungen & Wiedervorlagen
After=network.target

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
Environment=NODE_ENV=production
ExecStart=$(which node) cron/reminders.js
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pdf-freigabe-cron
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data
EOF

cat > /etc/systemd/system/pdf-freigabe-cron.timer << EOF
[Unit]
Description=PDF-Freigabe Erinnerungen (alle 2 Stunden)

[Timer]
OnCalendar=*-*-* 07,09,11,13,15,17:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now pdf-freigabe-cron.timer

# ─── Sudoers-Regel für In-App-Update ────────────────────────────────────────
SUDOERS_FILE="/etc/sudoers.d/pdf-freigabe"
cat > "$SUDOERS_FILE" << EOF
# Erlaubt dem pdf-freigabe-Service setup.sh --update ohne Passwort auszuführen
$APP_USER ALL=(root) NOPASSWD: $INSTALL_DIR/setup.sh --update
EOF
chmod 440 "$SUDOERS_FILE"
ok "Sudo-Regel für In-App-Update eingerichtet"
if systemctl is-active --quiet pdf-freigabe-cron.timer 2>/dev/null; then
  ok "Erinnerungen-Timer eingerichtet (alle 2h, 7–17 Uhr)"
else
  warn "Timer manuell aktivieren: systemctl enable --now pdf-freigabe-cron.timer"
fi

info "Service starten..."
systemctl restart pdf-freigabe
sleep 2

if systemctl is-active --quiet pdf-freigabe; then
  ok "PDF-Freigabetool läuft!"
else
  warn "Prüfe Logs: journalctl -u pdf-freigabe -f"
fi

command -v ufw &>/dev/null && ufw allow 3000/tcp >/dev/null 2>&1 || true

# ─── Zusammenfassung ────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo ""

if $UPDATE_MODE; then
  echo "  ╔═══════════════════════════════════════════════════════════╗"
  echo "  ║  ✅ Update abgeschlossen!                                ║"
  echo "  ╠═══════════════════════════════════════════════════════════╣"
  echo "  ║  URL:       http://${IP}:3000                             "
  echo "  ║  Benutzer:  $APP_USER (kein Shell-Zugang)                 "
  echo "  ║  Daten, PDFs, .env und Logo wurden übernommen.            ║"
  echo "  ║  DB-Migrationen wurden automatisch ausgeführt.            ║"
  echo "  ╚═══════════════════════════════════════════════════════════╝"
else
  echo "  ╔═══════════════════════════════════════════════════════════╗"
  echo "  ║  ✅ Installation abgeschlossen!                          ║"
  echo "  ╠═══════════════════════════════════════════════════════════╣"
  echo "  ║  URL:       http://${IP}:3000                             "
  echo "  ╠═══════════════════════════════════════════════════════════╣"
  echo "  ║  ⚠️  Login-Daten – bitte notieren!                       ║"
  echo "  ║  E-Mail:    ${ADMIN_EMAIL}                                "
  echo "  ║  Passwort:  ${ADMIN_PASS}                                 "
  echo "  ╠═══════════════════════════════════════════════════════════╣"
  echo "  ║  systemctl status pdf-freigabe     Status                 ║"
  echo "  ║  systemctl restart pdf-freigabe    Neustart               ║"
  echo "  ║  journalctl -u pdf-freigabe -f     Live-Logs              ║"
  echo "  ║                                                           ║"
  echo "  ║  HTTPS: apt install caddy                                 ║"
  echo "  ║  In /etc/caddy/Caddyfile:                                 ║"
  echo "  ║    freigabe.meinefirma.de {                               ║"
  echo "  ║      reverse_proxy localhost:3000                         ║"
  echo "  ║    }                                                      ║"
  echo "  ╚═══════════════════════════════════════════════════════════╝"
fi
echo ""
