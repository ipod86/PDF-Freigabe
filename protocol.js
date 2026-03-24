// ─── protocol.js ─────────────────────────────────────────────────────────────
// Generiert ein Freigabe-Protokoll als PDF
// ──────────────────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./database');
const { getOrCreateThumb } = require('./utils/thumb');

function getSetting(key, fallback) {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return (row && row.value) ? row.value : fallback;
  } catch { return fallback; }
}

/**
 * Generiert ein Freigabe-Protokoll als PDF-Stream
 * @param {number} jobId - ID des Jobs
 * @param {WritableStream} outputStream - Zielstream (res oder FileStream)
 */
function generateProtocol(jobId, outputStream) {
  const db = getDb();

  const job = db.prepare(`
    SELECT j.*,
      u.name AS creator_name, u.email AS creator_email,
      cu.company AS customer_company,
      co.name AS contact_name, co.email AS contact_email
    FROM jobs j
    JOIN users u ON u.id = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co ON co.id = j.contact_id
    WHERE j.id = ?
  `).get(jobId);

  if (!job) throw new Error('Job nicht gefunden');

  const versions = db.prepare(`
    SELECT v.*, u.name AS uploaded_by_name
    FROM job_versions v JOIN users u ON u.id = v.uploaded_by
    WHERE v.job_id = ? ORDER BY v.version_number ASC
  `).all(jobId);

  const logs = db.prepare(`
    SELECT a.*, u.name AS user_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.job_id = ? ORDER BY a.created_at ASC
  `).all(jobId);

  // Multi-File-Status laden (aktuelle Version)
  let files = [];
  try {
    files = db.prepare('SELECT * FROM job_files WHERE job_id = ? AND version_number = ? ORDER BY sort_order').all(jobId, job.current_version);
  } catch {}

  const companyName = getSetting('company_name', 'Unternehmen');
  const statusMap = { pending: 'Offen', approved: 'Freigegeben', rejected: 'Abgelehnt' };
  const statusText = statusMap[job.status] || job.status;

  // ─── PDF erstellen ──────────────────────────────────────────────────────
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: 60, bottom: 60, left: 50, right: 50 },
    info: {
      Title: `Freigabeprotokoll: ${job.job_name}`,
      Author: companyName,
      Subject: 'Druckfreigabe-Protokoll',
      Creator: 'PDF-Freigabetool',
    }
  });

  doc.pipe(outputStream);

  // ─── Logo (falls vorhanden) ─────────────────────────────────────────────
  const logoFile = getSetting('company_logo', null);
  if (logoFile) {
    const logoPath = path.join(__dirname, 'public', 'uploads', 'logo', logoFile);
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, 50, 30, { height: 40 });
        doc.moveDown(2);
      } catch {}
    }
  }

  // ─── Header ─────────────────────────────────────────────────────────────
  const accentColor = '#4361ee';
  const greenColor = '#10b981';
  const redColor = '#ef4444';
  const orangeColor = '#f59e0b';
  const grayColor = '#64748b';

  doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a1d26')
    .text('Freigabeprotokoll', { align: 'left' });

  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor(grayColor)
    .text(`Erstellt am ${new Date().toLocaleString('de-DE')} · ${companyName}`);

  // Trennlinie
  doc.moveDown(0.8);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e2e5ec').lineWidth(1).stroke();
  doc.moveDown(0.8);

  // ─── Status-Banner ──────────────────────────────────────────────────────
  const statusColor = job.status === 'approved' ? greenColor : job.status === 'rejected' ? redColor : orangeColor;
  const bannerY = doc.y;
  doc.roundedRect(50, bannerY, 495, 36, 6).fillColor(statusColor).fill();
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#ffffff')
    .text(statusText.toUpperCase(), 50, bannerY + 10, { width: 495, align: 'center' });

  doc.y = bannerY + 50;

  // ─── Auftragsdaten ──────────────────────────────────────────────────────
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1d26').text('Auftragsdaten', 50);
  doc.moveDown(0.4);

  const infoData = [
    ['Auftragsname', job.job_name],
    ['Ersteller', `${job.creator_name} (${job.creator_email})`],
    ['Kunde', job.customer_company],
    ['Ansprechpartner', `${job.contact_name} (${job.contact_email})`],
    ['Erstellt am', job.created_at ? new Date(job.created_at).toLocaleString('de-DE') : '–'],
    ['Status', statusText],
    ['Status-Datum', job.status_changed_at ? new Date(job.status_changed_at).toLocaleString('de-DE') : '–'],
    ['Aktuelle Version', `V${job.current_version}`],
  ];

  if (job.due_date) infoData.push(['Fällig bis', new Date(job.due_date).toLocaleDateString('de-DE')]);
  if (job.description) infoData.push(['Besonderheiten', job.description]);
  if (job.internal_comment) infoData.push(['Interner Kommentar', job.internal_comment]);
  if (job.customer_comment) infoData.push(['Kunden-Kommentar', job.customer_comment]);
  if (job.followup_date) infoData.push(['Wiedervorlage', new Date(job.followup_date).toLocaleDateString('de-DE') + (job.followup_note ? ` – ${job.followup_note}` : '')]);

  infoData.forEach(([label, value]) => {
    const y = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(grayColor).text(label, 50, y, { width: 140 });
    doc.fontSize(9).font('Helvetica').fillColor('#1a1d26').text(value, 195, y, { width: 350 });
    doc.y = Math.max(doc.y, y + 16);
  });

  // ─── Multi-File Status (falls vorhanden) ────────────────────────────────
  if (files.length > 0) {
    doc.moveDown(1);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1d26').text('Einzelfreigaben', 50);
    doc.moveDown(0.4);

    files.forEach((f, i) => {
      if (doc.y > 700) { doc.addPage(); }
      const fStatus = statusMap[f.status] || f.status;
      const fColor = f.status === 'approved' ? greenColor : f.status === 'rejected' ? redColor : orangeColor;
      const y = doc.y;
      const thumbH = 52;

      // Thumbnail einbetten
      const thumbPath = getOrCreateThumb(f.stored_name);
      if (thumbPath) {
        try { doc.image(thumbPath, 50, y, { width: 40, height: thumbH }); } catch {}
      }

      // Dateiname + Status
      doc.fontSize(9).font('Helvetica').fillColor('#1a1d26').text(`${i + 1}. ${f.original_name}`, 100, y + 2, { width: 250 });
      doc.fontSize(9).font('Helvetica-Bold').fillColor(fColor).text(fStatus, 360, y + 2, { width: 100 });
      if (f.customer_comment) {
        doc.fontSize(8).font('Helvetica').fillColor(grayColor).text(`"${f.customer_comment}"`, 100, y + 14, { width: 250 });
      }
      doc.y = y + thumbH + 6;
    });
  }

  // ─── Digitale Unterschrift (falls vorhanden) ───────────────────────────
  if (job.signature_required) {
    let signature = null;
    try {
      signature = db.prepare('SELECT * FROM job_signatures WHERE job_id = ? ORDER BY signed_at DESC LIMIT 1').get(jobId);
    } catch {}

    if (signature) {
      doc.moveDown(1);
      if (doc.y > 650) { doc.addPage(); }
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1d26').text('Digitale Unterschrift', 50);
      doc.moveDown(0.4);

      const sigInfo = [];
      if (signature.signer_name) sigInfo.push(['Unterzeichnet von', signature.signer_name]);
      sigInfo.push(['Unterzeichnet am', signature.signed_at ? new Date(signature.signed_at).toLocaleString('de-DE') : '–']);

      sigInfo.forEach(([label, value]) => {
        const y = doc.y;
        doc.fontSize(9).font('Helvetica-Bold').fillColor(grayColor).text(label, 50, y, { width: 140 });
        doc.fontSize(9).font('Helvetica').fillColor('#1a1d26').text(value, 195, y, { width: 350 });
        doc.y = Math.max(doc.y, y + 16);
      });

      // Unterschriftsbild einbetten
      if (signature.signature_data && signature.signature_data.startsWith('data:image/png;base64,')) {
        try {
          const base64Data = signature.signature_data.replace('data:image/png;base64,', '');
          const imgBuffer = Buffer.from(base64Data, 'base64');
          doc.moveDown(0.5);
          const imgY = doc.y;
          doc.roundedRect(50, imgY, 300, 90, 4).strokeColor('#e2e5ec').lineWidth(1).stroke();
          doc.image(imgBuffer, 55, imgY + 5, { width: 290, height: 80, fit: [290, 80] });
          doc.y = imgY + 100;
        } catch {}
      }
    }
  }

  // ─── Versionshistorie ───────────────────────────────────────────────────
  if (versions.length > 0) {
    doc.moveDown(1);
    if (doc.y > 680) { doc.addPage(); }
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1d26').text('Versionshistorie', 50);
    doc.moveDown(0.4);

    // Tabellenkopf
    const thY = doc.y;
    doc.roundedRect(50, thY - 2, 495, 18, 3).fillColor('#f4f5f7').fill();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(grayColor);
    doc.text('Version', 55, thY + 2, { width: 60 });
    doc.text('Dateiname', 120, thY + 2, { width: 200 });
    doc.text('Hochgeladen von', 325, thY + 2, { width: 120 });
    doc.text('Datum', 450, thY + 2, { width: 100 });
    doc.y = thY + 20;

    versions.forEach(v => {
      if (doc.y > 700) { doc.addPage(); }
      const y = doc.y;
      const vThumbH = 40;

      const vThumb = getOrCreateThumb(v.stored_name);
      if (vThumb) {
        try { doc.image(vThumb, 120, y, { width: 30, height: vThumbH }); } catch {}
      }

      doc.fontSize(8).font('Helvetica').fillColor('#1a1d26');
      doc.text(`V${v.version_number}`, 55, y + 14, { width: 60 });
      doc.text(v.original_name, 155, y + 2, { width: 165 });
      doc.text(v.uploaded_by_name, 325, y + 14, { width: 120 });
      doc.text(v.created_at ? new Date(v.created_at).toLocaleString('de-DE') : '–', 450, y + 14, { width: 100 });
      doc.y = y + vThumbH + 6;
    });
  }

  // ─── Aktivitätsprotokoll ────────────────────────────────────────────────
  if (logs.length > 0) {
    doc.moveDown(1);
    if (doc.y > 650) { doc.addPage(); }
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1d26').text('Aktivitätsprotokoll', 50);
    doc.moveDown(0.4);

    logs.forEach(log => {
      if (doc.y > 730) { doc.addPage(); }
      const y = doc.y;
      const actionColor = log.action.includes('approved') ? greenColor :
        log.action.includes('rejected') ? redColor :
        log.action.includes('email') ? accentColor : grayColor;

      doc.fontSize(8).font('Helvetica').fillColor(grayColor)
        .text(log.created_at ? new Date(log.created_at).toLocaleString('de-DE') : '–', 50, y, { width: 130 });
      doc.fontSize(8).font('Helvetica-Bold').fillColor(actionColor)
        .text(log.action.replace(/_/g, ' '), 185, y, { width: 100 });
      doc.fontSize(8).font('Helvetica').fillColor('#1a1d26')
        .text(log.details || '–', 290, y, { width: 255 });
      doc.y = Math.max(doc.y, y + 14);
    });
  }

  // ─── Fußzeile auf jeder Seite ───────────────────────────────────────────
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = range.start; i < range.start + totalPages; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).font('Helvetica').fillColor(grayColor);
    doc.text(
      `Freigabeprotokoll: ${job.job_name} · Seite ${i - range.start + 1} von ${totalPages} · ${companyName}`,
      50, 770, { width: 495, align: 'center', lineBreak: false }
    );
  }

  doc.end();
  return doc;
}

module.exports = { generateProtocol };
