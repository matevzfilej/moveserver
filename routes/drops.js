const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE status=$1' : '';
    const params = status ? [status] : [];
    const { rows } = await pool.query(
      `SELECT * FROM drops ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DROPS_FAILED' });
  }
});

module.exports = router;
