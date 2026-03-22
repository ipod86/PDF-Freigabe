// ─── test-server.js ──────────────────────────────────────────────────────────
// Minimaler Test: Startet der Server? Funktioniert die DB? Funktioniert Login?
// Aufruf: node test-server.js
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { getDb, initialize } = require('./database');

console.log('');
console.log('=== PDF-Freigabe: System-Test ===');
console.log('');

// Test 1: Datenbank
try {
  initialize();
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  console.log(`✅ Datenbank OK (${result.c} Benutzer)`);
} catch (err) {
  console.log('❌ Datenbank FEHLER:', err.message);
  process.exit(1);
}

// Test 2: Benutzer vorhanden?
try {
  const db = getDb();
  const users = db.prepare('SELECT email, role FROM users WHERE active = 1').all();
  if (users.length === 0) {
    console.log('⚠️  Keine Benutzer vorhanden! Bitte "npm run seed" ausführen.');
  } else {
    users.forEach(u => console.log(`   👤 ${u.email} (${u.role})`));
  }
} catch (err) {
  console.log('❌ Benutzer-Abfrage FEHLER:', err.message);
}

// Test 3: Passwort-Check
try {
  const bcrypt = require('bcryptjs');
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE email = 'max@firma.de'").get();
  if (user) {
    const ok = bcrypt.compareSync('test1234', user.password_hash);
    console.log(`✅ Passwort-Check für max@firma.de: ${ok ? 'OK' : 'FALSCH'}`);
  } else {
    console.log('⚠️  max@firma.de nicht gefunden');
  }
} catch (err) {
  console.log('❌ Passwort-Check FEHLER:', err.message);
}

// Test 4: Express laden
try {
  const express = require('express');
  const session = require('express-session');
  console.log('✅ Express + Session: OK');
} catch (err) {
  console.log('❌ Express FEHLER:', err.message);
}

// Test 5: Verzeichnisse
const fs = require('fs');
const path = require('path');
['data', 'uploads', 'views', 'routes', 'public'].forEach(dir => {
  const p = path.join(__dirname, dir);
  const exists = fs.existsSync(p);
  console.log(`${exists ? '✅' : '❌'} Verzeichnis: ${dir}/`);
});

// Test 6: Session-Store
try {
  const SQLiteStore = require('connect-sqlite3')(require('express-session'));
  const store = new SQLiteStore({ db: 'test-sessions.sqlite', dir: path.join(__dirname, 'data') });
  console.log('✅ SQLite Session-Store: OK');
  // Aufräumen
  try { fs.unlinkSync(path.join(__dirname, 'data', 'test-sessions.sqlite')); } catch {}
} catch (err) {
  console.log('❌ Session-Store FEHLER:', err.message);
}

// Test 7: Views prüfen
const requiredViews = ['login', 'dashboard', 'error', 'profile', 'partials/header', 'partials/footer'];
requiredViews.forEach(v => {
  const p = path.join(__dirname, 'views', v + '.ejs');
  const exists = fs.existsSync(p);
  console.log(`${exists ? '✅' : '❌'} View: ${v}.ejs`);
});

console.log('');
console.log('=== Test abgeschlossen ===');
console.log('');
console.log('Wenn alle Tests ✅ sind, starte mit: npm start');
console.log('');

process.exit(0);
