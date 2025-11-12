const { pool } = require('../db/pool');

module.exports = function(io, socket) {
  socket.on('drop:create', async (payload, ack) => {
    try {
      const { title, kind='geo', lat, lng, radius_m=25, metadata={}, created_by } = payload;
      const q = await pool.query(
        `INSERT INTO drops (title, kind, lat, lng, radius_m, metadata, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [title, kind, lat, lng, radius_m, metadata, created_by]
      );
      io.emit('drop:created', q.rows[0]);
      ack && ack({ ok: true, drop: q.rows[0] });
    } catch (err) {
      console.error(err);
      ack && ack({ ok: false, error: err.message });
    }
  });
};
