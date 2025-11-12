const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

router.get('/', async (_req, res) => {
  try {
    const [{ rows: dropsCount }, { rows: claimsCount }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM drops`),
      pool.query(`SELECT COUNT(*)::int AS total FROM claims`)
    ]);

    const latestClaim = await pool.query(`
      SELECT c.*, d.title AS drop_title
      FROM claims c
      JOIN drops d ON d.id = c.drop_id
      ORDER BY c.claimed_at DESC LIMIT 1
    `);

    res.json({
      totals: {
        drops: dropsCount[0]?.total || 0,
        claims: claimsCount[0]?.total || 0
      },
      latestClaim: latestClaim.rows[0] || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'STATS_FAILED' });
  }
});

module.exports = router;
