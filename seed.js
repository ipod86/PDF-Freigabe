// ─── seed.js ─────────────────────────────────────────────────────────────────
// Initialdaten für Erstinstallation: 1 Admin + Demo-Kunden/Kontakte
// Aufruf: node seed.js
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { getDb, initialize } = require('./database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');

initialize();
const db = getDb();

console.log('🌱 Initialdaten werden angelegt...\n');

// ─── Admin-Sachbearbeiter ────────────────────────────────────────────────────
const password = crypto.randomBytes(5).toString('hex'); // 10-stelliges Hex-Passwort
const hash     = bcrypt.hashSync(password, 10);
const email    = 'admin@firma.de';

db.prepare(`
  INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)
`).run('Administrator', email, hash, 'admin');

const adminRow = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
console.log(`  👤 Administrator (${email}) – Passwort: ${password}`);

// ─── Demo-Kunden & Kontakte ──────────────────────────────────────────────────
const customers = [
  {
    company: 'Müller Druck GmbH',
    notes: 'Großkunde, Zahlungsziel 30 Tage',
    contacts: [
      { name: 'Anna Müller',  email: 'anna@mueller-druck.de',    phone: '+49 271 12345', position: 'Geschäftsführerin' },
      { name: 'Klaus Meier',  email: 'klaus@mueller-druck.de',   position: 'Einkauf' },
    ]
  },
  {
    company: 'Stadtwerke Siegen',
    notes: 'Öffentlicher Auftraggeber',
    contacts: [
      { name: 'Petra Hoffmann', email: 'p.hoffmann@stadtwerke-siegen.de', position: 'Marketing' },
    ]
  },
  {
    company: 'TechStart GmbH',
    contacts: [
      { name: 'Jan Becker',  email: 'jan@techstart.io',   position: 'CEO' },
      { name: 'Sarah Koch',  email: 'sarah@techstart.io', position: 'Design Lead' },
    ]
  },
  {
    company: 'Autohaus Schneider',
    contacts: [
      { name: 'Michael Schneider', email: 'info@autohaus-schneider.de', position: 'Inhaber' },
    ]
  },
  {
    company: 'Bäckerei Goldkorn',
    notes: 'Kleinkunde – nur Visitenkarten',
    contacts: [
      { name: 'Helga Braun', email: 'braun@goldkorn-baeckerei.de' },
    ]
  },
];

const insertCustomer = db.prepare('INSERT OR IGNORE INTO customers (company, notes) VALUES (?, ?)');
const insertContact  = db.prepare('INSERT INTO contacts (customer_id, name, email, phone, position) VALUES (?, ?, ?, ?, ?)');

for (const c of customers) {
  insertCustomer.run(c.company, c.notes || null);
  const cust = db.prepare('SELECT id FROM customers WHERE company = ?').get(c.company);
  console.log(`  🏢 ${c.company}`);
  for (const co of c.contacts) {
    const existing = db.prepare('SELECT id FROM contacts WHERE email = ?').get(co.email);
    if (!existing) {
      insertContact.run(cust.id, co.name, co.email, co.phone || null, co.position || null);
      console.log(`     📧 ${co.name} (${co.email})`);
    }
  }
}

// ─── Credentials für setup.sh speichern ─────────────────────────────────────
fs.writeFileSync('/tmp/pf-init-creds', `${email}\n${password}\n`, { mode: 0o600 });

console.log('\n✅ Initialdaten angelegt.');
process.exit(0);
