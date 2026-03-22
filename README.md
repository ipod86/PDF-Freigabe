# PDF-Freigabetool

Webbasiertes Tool zur Verwaltung von PDF-Druckfreigaben. Sachbearbeiter laden PDFs hoch, Kunden prüfen und geben frei per personalisiertem Deep-Link – ohne Kunden-Login.

## Features

### Freigabe-Workflow
- Multi-PDF-Upload mit Drag & Drop (akkumulierend, einzeln entfernbar)
- Einzelfreigabe pro Datei bei Multi-PDF-Jobs
- Versionshistorie mit aufklappbarer Dateiansicht (V1, V2, V3…)
- Eigene Seite für neue Versionen (vorausgefüllte Daten, Kommentare änderbar)
- Optionaler Passwortschutz für Freigabe-Links
- Option "Keine E-Mail senden" (Link manuell teilen)
- Fälligkeitsdatum (wird Kunde angezeigt, Dashboard-Farbcodierung)
- Wiedervorlage mit Datum und Notiz
- Freigabeprotokoll als PDF (Download + Mail-Versand)

### Dashboard
- Ampel-Status, Filter, Volltextsuche
- Auto-Refresh (30s, pausiert bei Tab-Hintergrund / Bulk-Auswahl)
- Fällig-Spalte mit Farbcodierung (überfällig / dringend / bald)
- Info-Spalte: Notiz, Privat, Passwort, Keine-Mail, Datei-Fortschritt, Wiedervorlage
- Bulk-Aktionen (Löschen, Mail erneut senden)
- CSV-Export, Statistiken mit Chart.js
- Keyboard-Shortcuts (N, D, /)

### Mail-System
- Flexibles Event-basiertes Vorlagen-System
- 6 Events: Freigabe erstellt, erteilt, abgelehnt, Kundenbestätigung, Erinnerung, Neue Version
- Mehrere Vorlagen pro Event möglich (alle werden versendet)
- Eigene Vorlagen erstellen/löschen, System-Vorlagen bearbeiten/deaktivieren
- Drag & Drop Platzhalter-Leiste im Editor mit Live-Vorschau
- Automatisches Mahnwesen (Cronjob)
- SMTP im Tool konfigurierbar (Testmail-Funktion)
- Datenschutz-Link automatisch in allen Mails

### Verwaltung
- Kunden, Ansprechpartner, Sachbearbeiter (CRUD)
- Firmenlogo-Upload (Kundenseite + Protokoll-PDF)
- Firmenfarben konfigurierbar (Kundenseite)
- Datenschutzerklärung + Impressum (HTML-Editor mit Vorschau, vorformulierte Texte)
- Backup & Restore (ein .tar.gz mit DB + PDFs + Logo)
- Webhooks (GET/POST, HMAC-SHA256, Events wählbar)
- In-App-Benachrichtigungen
- Audit-Log mit Suche
- Systeminfo-Seite

### Kunden-Erlebnis
- Übersichtliche Freigabeseite ohne Login
- PDF-Vorschau im Browser + Download pro Datei
- Fälligkeitsdatum sichtbar
- Firmenlogo + Firmenfarben
- Kommentarfeld bei Freigabe/Ablehnung
- Bestätigungsmail nach Entscheidung
- Footer mit Impressum + Datenschutz

## Voraussetzungen

- **Debian 12+** oder **Ubuntu 22.04+** (andere Linux-Distributionen möglich)
- **Internetzugang** bei der Installation (für Node.js, npm, Fonts)
- Empfohlen: **Reverse Proxy** (Caddy oder nginx) für HTTPS

## Installation

```bash
tar -xzf pdf-freigabe.tar.gz
cd pdf-freigabe
chmod +x setup.sh download-assets.sh
sudo ./setup.sh
```

Das Script erkennt automatisch ob eine bestehende Installation vorhanden ist und fragt ob Update oder Neuinstallation.

Die App wird automatisch nach `/opt/pdf-freigabe` installiert (der Service-Benutzer braucht Zugriff — Home-Verzeichnisse wie `/root` sind nicht geeignet).

Es installiert automatisch:
- Node.js 22 LTS (über NodeSource)
- npm-Abhängigkeiten
- Lokale Fonts und Chart.js (DSGVO-konform)
- systemd-Service mit Auto-Start und Security-Hardening
- Datenbank mit Testdaten

### Test-Login

| E-Mail | Passwort | Rolle |
|---|---|---|
| max@firma.de | test1234 | Admin |
| lisa@firma.de | test1234 | Benutzer |
| tom@firma.de | test1234 | Benutzer |

### Erste Schritte nach der Installation

1. Einloggen als Admin
2. **Verwaltung → Einstellungen**: Firmenname, Logo, SMTP, Base-URL setzen
3. **Verwaltung → Einstellungen**: Datenschutzerklärung und Impressum anpassen (Platzhalter ersetzen)
4. **Verwaltung → Sachbearbeiter**: Eigene Benutzer anlegen, Testbenutzer entfernen
5. **Verwaltung → Kunden**: Kundenstamm anlegen

## Service-Steuerung

```bash
systemctl status pdf-freigabe      # Status
systemctl restart pdf-freigabe     # Neustart
systemctl stop pdf-freigabe        # Stoppen
journalctl -u pdf-freigabe -f      # Live-Logs
```

## Update

```bash
cd ~
tar -xzf pdf-freigabe.tar.gz
cd pdf-freigabe
sudo ./setup.sh
# → "1) Update (Daten behalten)" wählen
```

Das Update kopiert die neuen Dateien nach `/opt/pdf-freigabe`, sichert automatisch Datenbank, PDFs, Logo, .env und Backups, installiert die neue Version, stellt die Daten wieder her und führt Datenbank-Migrationen aus.

Alternativ ohne Nachfrage: `sudo ./setup.sh --update`

## HTTPS mit Caddy (empfohlen)

```bash
apt install caddy
```

In `/etc/caddy/Caddyfile`:
```
freigabe.meinefirma.de {
  reverse_proxy localhost:3000
}
```

Caddy holt automatisch ein Let's-Encrypt-Zertifikat. Danach in den Einstellungen die Base-URL setzen: `https://freigabe.meinefirma.de`

Das Tool funktioniert gleichzeitig im LAN per HTTP und extern per HTTPS — Session-Cookies passen sich automatisch an (`secure: auto`).

## Backup & Restore

Über die Web-Oberfläche: **Verwaltung → Backup**

Manuell:
```bash
# Backup
tar -czf backup-$(date +%Y%m%d).tar.gz data/ uploads/ public/uploads/logo/ .env

# Restore
systemctl stop pdf-freigabe
tar -xzf backup-DATUM.tar.gz
systemctl start pdf-freigabe
```

## Sicherheit

### Authentifizierung
- Passwort-Hashing mit bcrypt (12 Rounds)
- Passwort-Policy: min. 8 Zeichen, Buchstaben + Zahlen
- Login Rate-Limiting (10 Versuche / 15 Min)
- Session Fixation Protection
- Constant-Time Passwort-Prüfung (verhindert User-Enumeration)
- 8h Session-Timeout

### CSRF-Schutz
- Token in Session, per Cookie an JS übermittelt
- Formulare: Hidden-Field `_csrf`
- AJAX: Header `X-CSRF-Token`
- Multipart-Uploads: geschützt durch SameSite-Cookie

### HTTP-Headers (Helmet)
- Content Security Policy (CSP)
- X-Content-Type-Options: nosniff
- X-Frame-Options (Clickjacking-Schutz)
- HSTS wird vom Reverse Proxy gesetzt

### Datei-Sicherheit
- PDF Magic Bytes Validierung (`%PDF-` Header)
- MIME-Type Filter
- Upload-Limit: 50 MB
- Dateinamen als UUID gespeichert (kein Path Traversal)

### Weitere Maßnahmen
- Dedizierter Service-Benutzer `pdf-freigabe` ohne Shell-Zugang (`/usr/sbin/nologin`)
- Code-Verzeichnis: root besitzt (read-only für App), Datenverzeichnisse: Service-User besitzt
- `.env` nur für root + Service-User lesbar (chmod 640)
- SQL-Injection: ausschließlich Prepared Statements
- LIKE-Injection: `escapeLike()` auf allen Suchfeldern
- Rate-Limiting auf Login, Freigabeseite und API
- Kein Debug-Output in Produktion
- systemd: NoNewPrivileges, PrivateTmp, ProtectSystem, ProtectHome, ProtectKernelTunables

## DSGVO

- Keine IP-Adressen gespeichert
- Keine User-Agents gespeichert
- Keine externen CDN-Requests (Fonts, JS lokal gehostet)
- Nur technisch notwendige Cookies (sid, csrf-token)
- Kein Tracking, keine Analytics, keine Drittanbieter
- Konfigurierbare Datenschutzerklärung + Impressum
- Datenschutz-Link automatisch in allen E-Mails
- Backup/Export aller Daten möglich
- Audit-Log löschbar

## Technischer Stack

| Komponente | Technologie | Version |
|---|---|---|
| Runtime | Node.js LTS | 22.x |
| Framework | Express | 5.x |
| Datenbank | SQLite | better-sqlite3 |
| Templates | EJS | 3.x |
| PDF-Erstellung | PDFKit | 0.16.x |
| Security Headers | Helmet | 8.x |
| Passwort-Hashing | bcryptjs | 2.x |
| Schriftarten | DM Sans + JetBrains Mono | lokal (WOFF2) |
| Charts | Chart.js | 4.x (lokal) |

## Verzeichnisstruktur

```
pdf-freigabe/
├── server.js              # Express-Server (Security-Config)
├── database.js            # SQLite-Schema + Migrationen
├── security.js            # PDF-Validierung, Passwort-Policy, Input-Sanitierung
├── mailer.js              # SMTP + Event-basierter Mail-Versand
├── protocol.js            # Freigabeprotokoll PDF-Generator
├── notifications.js       # In-App-Benachrichtigungen
├── seed.js                # Testdaten
├── setup.sh               # Installations- & Update-Script
├── download-assets.sh     # Fonts + Chart.js lokal herunterladen
├── routes/
│   ├── auth.js            # Login/Logout/Profil
│   ├── dashboard.js       # Übersicht
│   ├── jobs.js            # Freigaben CRUD + Versionen
│   ├── approve.js         # Öffentliche Kundenseite
│   ├── admin.js           # Verwaltung (Benutzer, Kunden, Vorlagen, Settings)
│   ├── api.js             # AJAX-Endpunkte
│   └── webhooks.js        # Externe Webhooks
├── middleware/
│   └── auth.js            # requireLogin, requireAdmin
├── cron/
│   └── reminders.js       # Automatische Erinnerungen
├── views/                 # 27 EJS-Templates
├── public/
│   ├── css/
│   │   ├── style.css      # Haupt-Stylesheet
│   │   ├── approve.css    # Kunden-Freigabeseite
│   │   └── fonts.css      # Lokale @font-face
│   ├── js/app.js          # Client-JS
│   ├── fonts/             # WOFF2-Schriftarten
│   └── vendor/            # Chart.js
├── data/                  # SQLite-Datenbank + Sessions
├── uploads/               # Hochgeladene PDFs
└── backups/               # Backup-Archive
```

## Wartung

Empfohlen: einmal jährlich (z.B. Januar) prüfen:

- `node -v` — Node.js Version noch im LTS-Support?
- `npm audit` — Sicherheitslücken in Abhängigkeiten?
- Node.js 22 EOL: April 2027 → dann auf Node 24 wechseln

Bei Security-Warnungen: `npm audit fix` und `systemctl restart pdf-freigabe`

## Lizenz

Intern entwickelt. Alle Rechte vorbehalten.
