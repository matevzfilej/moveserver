// Simple, single-file MoveServer (Express + Socket.io) with memory fallback.
// No external "socket/*" modules needed.

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();

// --- CORS: allow all for now (to bring app/dash back up fast)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/* ===== Optional PostgreSQL (safe to miss) ===== */
let pool = null;
let useDb = false;
try {
  const { Pool } = require('pg');
  if (process.env.DATABASE_URL) {
    const needSsl = process.env.PGSSLMODE === 'require'
      || process.env.DATABASE_URL.includes('sslmode=require');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: needSsl ? { rejectUnauthorized: false } : false
    });
    useDb = true;
    console.log('[DB] Using PostgreSQL');
  } else {
    console.log('[DB] No DATABASE_URL → memory mode');
  }
} catch (e) {
  console.log('[DB] pg not available → memory mode');
  useDb = false;
}

/* ===== Memory fallback stores ===== */
const dropsMem = [];
const claimsMem = [];
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });

/* ===== Health ===== */
app.get('/health', (_req, res) => res.json({ ok: true, db: useDb ? 'pg' : 'memory' }));

/* ===== REST: drops ===== */
app.get('/drops', async (req, res) => {
  if (!useDb) {
    return res.json(dropsMem.slice().reverse().slice(0, 500));
  }
  try {
    const { status } = req.query;
    const params = [];
    const where = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const sql = `
      SELECT * FROM drops
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT 500`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('/drops PG error → memory fallback:', e.message);
    res.json(dropsMem.slice().reverse().slice(0, 500));
  }
});

/* ===== REST: stats ===== */
app.get('/stats', async (_req, res) => {
  if (!useDb) {
    const latest = claimsMem.at(-1) || null;
    return res.json({
      totals: { drops: dropsMem.length, claims: claimsMem.length },
      latestClaim: latest ? { ...latest, drop_title: dropsMem.find(d => d.id === latest.drop_id)?.title || null } : null
    });
  }
  try {
    const [{ rows: dc }, { rows: cc }, latest] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM drops`),
      pool.query(`SELECT COUNT(*)::int AS total FROM claims`),
      pool.query(`
        SELECT c.*, d.title AS drop_title
        FROM claims c JOIN drops d ON d.id = c.drop_id
        ORDER BY c.claimed_at DESC LIMIT 1`)
    ]);
    res.json({
      totals: { drops: dc[0]?.total || 0, claims: cc[0]?.total || 0 },
      latestClaim: latest.rows[0] || null
    });
  } catch (e) {
    console.error('/stats PG error → memory fallback:', e.message);
    const latest = claimsMem.at(-1) || null;
    res.json({
      totals: { drops: dropsMem.length, claims: claimsMem.length },
      latestClaim: latest ? { ...latest, drop_title: dropsMem.find(d => d.id === latest.drop_id)?.title || null } : null
    });
  }
});

/* ===== Socket.io ===== */
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, methods: ['GET','POST'] } });

// Create drop
io.on('connection', (socket) => {
  socket.on('drop:create', async (payload, ack) => {
    const {
      title, kind='geo', lat=null, lng=null, radius_m=25,
      starts_at=null, expires_at=null, metadata={}, created_by=null
    } = payload || {};
    if (!title) return ack && ack({ ok:false, error:'TITLE_REQUIRED' });

    if (!useDb) {
      const drop = {
        id: uuid(), title, kind, status:'active',
        lat, lng, radius_m, starts_at, expires_at, metadata, created_by,
        claimed_count: 0, created_at: new Date().toISOString()
      };
      dropsMem.push(drop);
      io.emit('drop:created', drop);
      return ack && ack({ ok:true, drop });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO drops (title, kind, status, lat, lng, radius_m, starts_at, expires_at, metadata, created_by)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [title, kind, lat, lng, radius_m, starts_at, expires_at, metadata, created_by]
      );
      const drop = rows[0];
      io.emit('drop:created', drop);
      ack && ack({ ok:true, drop });
    } catch (e) {
      console.error('drop:create PG error → memory fallback:', e.message);
      const drop = {
        id: uuid(), title, kind, status:'active',
        lat, lng, radius_m, starts_at, expires_at, metadata, created_by,
        claimed_count: 0, created_at: new Date().toISOString()
      };
      dropsMem.push(drop);
      io.emit('drop:created', drop);
      ack && ack({ ok:true, drop, note:'memory_fallback' });
    }
  });

  // Claim drop
  socket.on('drop:claim', async (payload, ack) => {
    const { drop_id, user_id, value=null, tx_hash=null } = payload || {};
    if (!drop_id || !user_id) return ack && ack({ ok:false, error:'BAD_PAYLOAD' });

    if (!useDb) {
      if (claimsMem.find(c => c.drop_id===drop_id && c.user_id===user_id)) {
        return ack && ack({ ok:false, error:'ALREADY_CLAIMED' });
      }
      const claim = { id: uuid(), drop_id, user_id, value, tx_hash, claimed_at: new Date().toISOString() };
      claimsMem.push(claim);
      const d = dropsMem.find(d => d.id === drop_id);
      if (d) d.claimed_count = (d.claimed_count||0)+1;
      io.emit('claim:created', claim);
      return ack && ack({ ok:true, claim });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          `INSERT INTO claims (drop_id, user_id, value, tx_hash)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (drop_id, user_id) DO NOTHING
           RETURNING *`,
          [drop_id, user_id, value, tx_hash]
        );
        const claim = ins.rows[0];
        if (claim) {
          await client.query(`UPDATE drops SET claimed_count = claimed_count + 1 WHERE id=$1`, [drop_id]);
          await client.query('COMMIT');
          io.emit('claim:created', claim);
          return ack && ack({ ok:true, claim });
        } else {
          await client.query('ROLLBACK');
          return ack && ack({ ok:false, error:'ALREADY_CLAIMED' });
        }
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('drop:claim PG error → memory fallback:', e.message);
      if (claimsMem.find(c => c.drop_id===drop_id && c.user_id===user_id)) {
        return ack && ack({ ok:false, error:'ALREADY_CLAIMED' });
      }
      const claim = { id: uuid(), drop_id, user_id, value, tx_hash, claimed_at: new Date().toISOString() };
      claimsMem.push(claim);
      const d = dropsMem.find(d => d.id === drop_id);
      if (d) d.claimed_count = (d.claimed_count||0)+1;
      io.emit('claim:created', claim);
      return ack && ack({ ok:true, claim, note:'memory_fallback' });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`MoveServer up on :${PORT}`));
