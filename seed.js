// ─── seed.js ─────────────────────────────────────────────────────────────────
// Testdaten für die Entwicklungsumgebung
// Aufruf: node seed.js
// ──────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { getDb, initialize } = require('./database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

initialize();
const db = getDb();

console.log('🌱 Testdaten werden angelegt...\n');

// ─── Sachbearbeiter ─────────────────────────────────────────────────────────
const users = [
  { name: 'Max Mustermann', email: 'max@firma.de', role: 'admin' },
  { name: 'Lisa Schmidt',   email: 'lisa@firma.de', role: 'user' },
  { name: 'Tom Weber',      email: 'tom@firma.de',  role: 'user' },
];

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)
`);

const userIds = {};
for (const u of users) {
  const hash = bcrypt.hashSync('test1234', 10);
  insertUser.run(u.name, u.email, hash, u.role);
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
  userIds[u.email] = row.id;
  console.log(`  👤 ${u.name} (${u.email}) – Passwort: test1234`);
}

// ─── Kunden ─────────────────────────────────────────────────────────────────
const customers = [
  {
    company: 'Müller Druck GmbH',
    notes: 'Großkunde, Zahlungsziel 30 Tage',
    contacts: [
      { name: 'Anna Müller',  email: 'anna@mueller-druck.de', phone: '+49 271 12345', position: 'Geschäftsführerin' },
      { name: 'Klaus Meier',  email: 'klaus@mueller-druck.de', position: 'Einkauf' },
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
      { name: 'Jan Becker', email: 'jan@techstart.io', position: 'CEO' },
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

const contactIds = [];

for (const c of customers) {
  insertCustomer.run(c.company, c.notes || null);
  const cust = db.prepare('SELECT id FROM customers WHERE company = ?').get(c.company);
  console.log(`  🏢 ${c.company}`);

  for (const co of c.contacts) {
    const existing = db.prepare('SELECT id FROM contacts WHERE email = ?').get(co.email);
    if (!existing) {
      insertContact.run(cust.id, co.name, co.email, co.phone || null, co.position || null);
      const row = db.prepare('SELECT id FROM contacts WHERE email = ?').get(co.email);
      contactIds.push({ customerId: cust.id, contactId: row.id, name: co.name, email: co.email });
      console.log(`     📧 ${co.name} (${co.email})`);
    }
  }
}

// ─── Demo-PDF erstellen ─────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Minimales PDF als Platzhalter
const minimalPdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
trailer<</Size 5/Root 1 0 R>>
startxref
338
%%EOF`;

// ─── Demo-Freigaben ─────────────────────────────────────────────────────────
const demoJobs = [
  { name: 'Visitenkarten Müller GmbH', status: 'approved', creatorEmail: 'max@firma.de', contactIdx: 0, daysAgo: 14 },
  { name: 'Flyer Sommeraktion 2025',   status: 'pending',  creatorEmail: 'lisa@firma.de', contactIdx: 2, daysAgo: 3 },
  { name: 'Broschüre Stadtwerke',      status: 'rejected', creatorEmail: 'max@firma.de', contactIdx: 2, daysAgo: 7, comment: 'Logo auf Seite 3 ist veraltet, bitte aktuelle Version verwenden.' },
  { name: 'Poster TechStart Launch',   status: 'pending',  creatorEmail: 'tom@firma.de', contactIdx: 3, daysAgo: 1 },
  { name: 'Preisliste Autohaus 2025',  status: 'approved', creatorEmail: 'lisa@firma.de', contactIdx: 5, daysAgo: 21 },
  { name: 'Menükarte Goldkorn',        status: 'approved', creatorEmail: 'max@firma.de', contactIdx: 6, daysAgo: 30 },
  { name: 'Roll-Up Banner TechStart',  status: 'pending',  creatorEmail: 'tom@firma.de', contactIdx: 4, daysAgo: 5 },
  { name: 'Briefpapier Müller GmbH',   status: 'approved', creatorEmail: 'max@firma.de', contactIdx: 1, daysAgo: 10 },
];

const insertJob = db.prepare(`
  INSERT INTO jobs (uuid, creator_id, customer_id, contact_id, job_name, description, internal_comment, status, visibility, access_token, customer_comment, status_changed_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'team', ?, ?, ?, ?, ?)
`);

const insertVersion = db.prepare(`
  INSERT INTO job_versions (job_id, version_number, original_name, stored_name, file_size, uploaded_by)
  VALUES (?, 1, ?, ?, ?, ?)
`);

const insertAudit = db.prepare(`
  INSERT INTO audit_log (job_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)
`);

console.log('\n  📋 Demo-Freigaben:');

for (const j of demoJobs) {
  const jobUuid = uuidv4();
  const accessToken = uuidv4();
  const pdfStored = uuidv4() + '.pdf';
  const createdAt = new Date(Date.now() - j.daysAgo * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const statusDate = j.status !== 'pending'
    ? new Date(Date.now() - (j.daysAgo - 2) * 86400000).toISOString().replace('T', ' ').slice(0, 19)
    : null;

  const contact = contactIds[j.contactIdx] || contactIds[0];
  const creatorId = userIds[j.creatorEmail] || 1;

  insertJob.run(
    jobUuid, creatorId, contact.customerId, contact.contactId,
    j.name,
    j.name.includes('Flyer') ? 'Bitte auf Sonderfarbe HKS 43 achten' : null,
    j.name.includes('Visitenkarten') ? 'Eilauftrag – Freitag fertig' : null,
    j.status, accessToken,
    j.comment || null, statusDate,
    createdAt, createdAt
  );

  const jobRow = db.prepare('SELECT id FROM jobs WHERE uuid = ?').get(jobUuid);

  // PDF-Platzhalter schreiben
  fs.writeFileSync(path.join(UPLOAD_DIR, pdfStored), minimalPdf);
  insertVersion.run(jobRow.id, j.name.replace(/\s+/g, '_') + '.pdf', pdfStored, minimalPdf.length, creatorId);

  // Audit-Eintrag
  insertAudit.run(jobRow.id, creatorId, 'created', `Freigabe erstellt: ${j.name}`, createdAt);
  if (j.status !== 'pending') {
    insertAudit.run(jobRow.id, null, `customer_${j.status}`, `Kunde hat ${j.status === 'approved' ? 'freigegeben' : 'abgelehnt'}`, statusDate);
  }

  const icon = j.status === 'approved' ? '✅' : j.status === 'rejected' ? '❌' : '⏳';
  console.log(`  ${icon} ${j.name} (${j.status})`);
}

// ─── Fertig ─────────────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════╗
║  🌱 Testdaten erfolgreich angelegt!                  ║
╠══════════════════════════════════════════════════════╣
║  Login:     max@firma.de / test1234  (Admin)         ║
║  Login:     lisa@firma.de / test1234                  ║
║  Login:     tom@firma.de / test1234                   ║
║                                                       ║
║  ${demoJobs.length} Demo-Freigaben, ${customers.length} Kunden, ${users.length} Sachbearbeiter           ║
║  Starten:   npm start                                 ║
╚══════════════════════════════════════════════════════╝
`);

process.exit(0);
