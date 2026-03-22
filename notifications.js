// ─── notifications.js ────────────────────────────────────────────────────────
// In-App-Benachrichtigungssystem
// Benachrichtigungen gehen NUR an den Ersteller der Freigabe.
// Gelesene Benachrichtigungen werden direkt gelöscht.
// ──────────────────────────────────────────────────────────────────────────────
const { getDb } = require('./database');

/**
 * Benachrichtigung für einen bestimmten Benutzer erstellen
 */
function notify(userId, type, title, message, jobId = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO notifications (user_id, job_id, type, title, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, jobId, type, title, message || null);
}

/**
 * Benachrichtigung erstellen wenn Kunde Freigabe erteilt/abgelehnt
 * → Geht NUR an den Ersteller der Freigabe
 */
function notifyApproval(job, status, customerComment) {
  const statusText = status === 'approved' ? 'freigegeben' : 'abgelehnt';
  const icon = status === 'approved' ? '✅' : '❌';

  notify(
    job.creator_id,
    status,
    `${icon} ${job.job_name} – ${statusText}`,
    customerComment
      ? `Kommentar: ${customerComment}`
      : `Ohne Kommentar ${statusText}`,
    job.id
  );
}

/**
 * Ungelesene Benachrichtigungen abrufen
 */
function getUnread(userId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT n.*, j.uuid AS job_uuid
    FROM notifications n
    LEFT JOIN jobs j ON j.id = n.job_id
    WHERE n.user_id = ? AND n.read = 0
    ORDER BY n.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Alle Benachrichtigungen abrufen (nur ungelesene, da gelesene sofort gelöscht werden)
 */
function getAll(userId, limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT n.*, j.uuid AS job_uuid
    FROM notifications n
    LEFT JOIN jobs j ON j.id = n.job_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Als gelesen markieren → Löscht die Benachrichtigung
 */
function markRead(notificationId, userId) {
  const db = getDb();
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
    .run(notificationId, userId);
}

/**
 * Alle als gelesen → Löscht alle Benachrichtigungen
 */
function markAllRead(userId) {
  const db = getDb();
  db.prepare('DELETE FROM notifications WHERE user_id = ?')
    .run(userId);
}

module.exports = {
  notify, notifyApproval,
  getUnread, getAll, markRead, markAllRead,
};
