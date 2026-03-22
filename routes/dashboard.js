// ─── routes/dashboard.js ─────────────────────────────────────────────────────
const router = require('express').Router();
const { requireLogin } = require('../middleware/auth');
const { getDb } = require('../database');
const { escapeLike } = require('../security');

router.get('/', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const filter = req.query.status || 'all';
  const search = req.query.q || '';

  let where = '1=1';
  const params = [];

  // Sichtbarkeit: Team-Jobs + eigene private Jobs
  where += ` AND (j.visibility = 'team' OR j.creator_id = ?)`;
  params.push(userId);

  if (filter !== 'all') {
    where += ' AND j.status = ?';
    params.push(filter);
  }

  if (search) {
    where += ` AND (j.job_name LIKE ? ESCAPE '\\' OR cu.company LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')`;
    const s = `%${escapeLike(search)}%`;
    params.push(s, s, s);
  }

  const jobs = db.prepare(`
    SELECT
      j.*,
      u.name  AS creator_name,
      cu.company AS customer_company,
      co.name AS contact_name,
      co.email AS contact_email,
      (SELECT original_name FROM job_versions WHERE job_id = j.id AND version_number = j.current_version) AS pdf_name,
      (SELECT stored_name FROM job_versions WHERE job_id = j.id AND version_number = j.current_version) AS pdf_stored,
      (SELECT COUNT(*) FROM job_files WHERE job_id = j.id AND version_number = j.current_version) AS file_count,
      (SELECT COUNT(*) FROM job_files WHERE job_id = j.id AND version_number = j.current_version AND status = 'approved') AS files_approved,
      (SELECT COUNT(*) FROM job_files WHERE job_id = j.id AND version_number = j.current_version AND status = 'rejected') AS files_rejected,
      (SELECT COUNT(*) FROM job_files WHERE job_id = j.id AND version_number = j.current_version AND status = 'pending') AS files_pending
    FROM jobs j
    JOIN users u      ON u.id  = j.creator_id
    JOIN customers cu ON cu.id = j.customer_id
    JOIN contacts co  ON co.id = j.contact_id
    WHERE ${where}
    ORDER BY j.created_at DESC
  `).all(...params);

  // Statistiken
  const stats = db.prepare(`
    SELECT
      COUNT(*)                                    AS total,
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
    FROM jobs j
    WHERE (j.visibility = 'team' OR j.creator_id = ?)
  `).get(userId);

  res.render('dashboard', {
    title: 'Dashboard',
    jobs,
    stats,
    filter,
    search,
  });
});

module.exports = router;
