// MoveServer – PostgreSQL + username/password + drops/claims/statistika
// CJS (brez "type": "module")

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const path = require('path'); // <- NOVO

const VERSION = 'pg-auth-v1.1-username-fix-ar';

// ====== MIGRACIJE (auto-run na startu, če je baza nastavljena) ======
const MIGRATE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'geo',
  status TEXT NOT NULL DEFAULT 'active',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_m INTEGER DEFAULT 25,
  created_by TEXT,
  claimed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  value NUMERIC(18,8),
  tx_hash TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (drop_id, user_id)
);

CREATE INDEX IF NOT EXISTS drops_status_idx ON drops(status);
CREATE INDEX IF NOT EXISTS drops_geo_idx ON drops(lat,lng);
CREATE INDEX IF NOT EXISTS claims_user_idx ON claims(user_id);

/* --- dodatne ALTER-je za obstoječe tabele (stare verzije) --- */
ALTER TABLE claims ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS value NUMERIC(18,8);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS tx_hash TEXT;
`;

// ====== DB / MEM konfiguracija ======
let pool = null;
let useDb = false;
let Pool = null;

try {
  Pool = require('pg').Pool;
} catch (e) {
  console.log('[DB] pg modul ni na voljo, uporabljam spomin:', e.message);
}

if (process.env.DATABASE_URL && Pool) {
  (async () => {
    try {
      const needSsl =
        process.env.PGSSLMODE === 'require' ||
        (process.env.DATABASE_URL || '').includes('sslmode=require');

      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: needSsl ? { rejectUnauthorized: false } : false
      });

      await pool.query('SELECT 1');
      console.log('[DB] Povezava na PostgreSQL OK');

      await pool.query(MIGRATE_SQL);
      console.log('[DB] Migracije OK');

      useDb = true;
    } catch (err) {
      console.error('[DB] Napaka pri inicializaciji baze, preklop na spomin:', err.message);
      pool = null;
      useDb = false;
    }
  })();
} else {
  console.log('[DB] DATABASE_URL ni nastavljen → način spomin');
}

// ====== APP ======
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ***** STATIČNE DATOTEKE (AR HTML + modeli + markerji) *****
app.use(express.static(path.join(__dirname, 'public')));

const mem = {
  users: [],
  drops: [],
  claims: []
};

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

const toNum = (v, def = null) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : Number.isFinite(+v)
    ? +v
    : def;

// ====== Health ======
app.get('/health', async (_req, res) => {
  res.json({ ok: true, db: useDb ? 'postgres' : 'memory', version: VERSION });
});

app.get('/version', (_req, res) => {
  res.type('text').send(VERSION);
});

// ====== USERS (registracija / prijava) ======
async function findUserByUsername(username) {
  if (!username) return null;
  if (!useDb || !pool) {
    return mem.users.find(u => u.username === username) || null;
  }
  const { rows } = await pool.query(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [username]
  );
  return rows[0] || null;
}

async function findUserById(userId) {
  if (!userId) return null;
  if (!useDb || !pool) {
    return mem.users.find(u => String(u.id) === String(userId)) || null;
  }
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

// POST /api/register { username, password }
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'MANJKA_UPORABNIK_GESLO' });
    }
    const name = String(username).trim().toLowerCase();
    if (!name) {
      return res.status(400).json({ ok: false, error: 'NAPACNO_IME' });
    }

    const existing = await findUserByUsername(name);
    if (existing) {
      return res.status(400).json({ ok: false, error: 'UPORABNIK_ZASEDEN' });
    }

    const hash = await bcrypt.hash(password, 10);

    if (!useDb || !pool) {
      const id = mem.users.length + 1;
      const user = {
        id,
        username: name,
        password_hash: hash,
        created_at: new Date().toISOString()
      };
      mem.users.push(user);
      return res.json({ ok: true, user: { id, username: name } });
    }

    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [name, hash]
    );
    const user = rows[0];
    res.json({ ok: true, user });
  } catch (e) {
    console.error('register error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/login { username, password }
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'MANJKA_UPORABNIK_GESLO' });
    }
    const name = String(username).trim().toLowerCase();
    const user = await findUserByUsername(name);
    if (!user) {
      return res.status(400).json({ ok: false, error: 'NAPACNI_PODATKI' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ ok: false, error: 'NAPACNI_PODATKI' });
    }

    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== DROPS ======
async function listDrops(status = 'active') {
  if (!useDb || !pool) {
    const arr =
      status && status !== 'all'
        ? mem.drops.filter(d => d.status === status)
        : mem.drops.slice();
    return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const params = [];
  let where = '';
  if (status && status !== 'all') {
    where = 'WHERE status = $1';
    params.push(status);
  }
  const { rows } = await pool.query(
    `SELECT * FROM drops ${where} ORDER BY created_at DESC LIMIT 1000`,
    params
  );
  return rows;
}

async function getDrop(id) {
  if (!id) return null;
  if (!useDb || !pool) {
    return mem.drops.find(d => d.id === id) || null;
  }
  const { rows } = await pool.query('SELECT * FROM drops WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createDrop(data) {
  const { title, kind = 'geo', lat = null, lng = null, radius_m = 25, created_by = null } =
    data || {};
  if (!title) throw new Error('MANJKA_TITLE');

  const row = {
    id: uuid(),
    title: String(title),
    kind: String(kind || 'geo'),
    lat: toNum(lat, null),
    lng: toNum(lng, null),
    radius_m: toNum(radius_m, 25),
    status: 'active',
    claimed_count: 0,
    created_by
  };

  if (!useDb || !pool) {
    row.created_at = new Date().toISOString();
    mem.drops.push(row);
    return row;
  }

  await pool.query(
    `INSERT INTO drops (id,title,kind,status,lat,lng,radius_m,created_by,claimed_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.id,
      row.title,
      row.kind,
      row.status,
      row.lat,
      row.lng,
      row.radius_m,
      row.created_by,
      0
    ]
  );
  const full = await getDrop(row.id);
  return full || row;
}

async function updateDrop(id, patch) {
  if (!id) return null;
  const fields = ['title', 'lat', 'lng', 'radius_m', 'status'];
  const obj = {};
  fields.forEach(f => {
    if (patch[f] !== undefined) obj[f] = patch[f];
  });
  if (!Object.keys(obj).length) return await getDrop(id);

  if (!useDb || !pool) {
    const d = mem.drops.find(x => x.id === id);
    if (!d) return null;
    Object.assign(d, {
      title: obj.title ?? d.title,
      lat: obj.lat !== undefined ? toNum(obj.lat, null) : d.lat,
      lng: obj.lng !== undefined ? toNum(obj.lng, null) : d.lng,
      radius_m:
        obj.radius_m !== undefined ? toNum(obj.radius_m, d.radius_m) : d.radius_m,
      status: obj.status ?? d.status
    });
    return d;
  }

  const cols = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(obj)) {
    cols.push(`${k} = $${i++}`);
    params.push(k === 'radius_m' ? toNum(v, null) : v);
  }
  params.push(id);
  await pool.query(`UPDATE drops SET ${cols.join(', ')} WHERE id = $${i}`, params);
  return await getDrop(id);
}

async function deleteDrop(id) {
  if (!id) return false;

  if (!useDb || !pool) {
    const idx = mem.drops.findIndex(d => d.id === id);
    if (idx === -1) return false;
    mem.drops.splice(idx, 1);
    for (let i = mem.claims.length - 1; i >= 0; i--) {
      if (mem.claims[i].drop_id === id) mem.claims.splice(i, 1);
    }
    return true;
  }

  await pool.query('DELETE FROM claims WHERE drop_id = $1', [id]);
  const result = await pool.query('DELETE FROM drops WHERE id = $1', [id]);
  return result.rowCount > 0;
}

// ====== RAZDALJA ======
function toRad(x) {
  return (x * Math.PI) / 180;
}
function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ====== CLAIMS ======
async function createClaim({
  drop_id,
  user_id,
  user_name = null,
  value = null,
  tx_hash = null,
  lat = null,
  lng = null
}) {
  if (!drop_id || !user_id) throw new Error('SLABI_PODATKI');

  const drop = await getDrop(drop_id);
  if (!drop) throw new Error('DROP_NE_OBSTAJA');

  if (drop.lat != null && drop.lng != null && lat != null && lng != null) {
    const dist = distanceMeters({ lat, lng }, { lat: drop.lat, lng: drop.lng });
    if (drop.radius_m != null && dist > drop.radius_m) {
      const left = Math.max(0, Math.round(dist - drop.radius_m));
      const err = new Error('PREDALEC:' + left);
      err.code = 'TOO_FAR';
      throw err;
    }
  }

  if (!useDb || !pool) {
    if (
      mem.claims.find(
        c => c.drop_id === drop_id && String(c.user_id) === String(user_id)
      )
    ) {
      throw new Error('ZE_CLAIMANO');
    }
    const claim = {
      id: uuid(),
      drop_id,
      user_id: String(user_id),
      user_name: user_name || null,
      value: toNum(value, null),
      tx_hash,
      claimed_at: new Date().toISOString()
    };
    mem.claims.push(claim);
    const d = mem.drops.find(x => x.id === drop_id);
    if (d) d.claimed_count = (d.claimed_count || 0) + 1;
    return claim;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT id FROM claims WHERE drop_id=$1 AND user_id=$2',
      [drop_id, String(user_id)]
    );
    if (check.rowCount > 0) {
      await client.query('ROLLBACK');
      throw new Error('ZE_CLAIMANO');
    }

    const id = uuid();
    await client.query(
      'INSERT INTO claims (id,drop_id,user_id,user_name,value,tx_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, drop_id, String(user_id), user_name, toNum(value, null), tx_hash]
    );
    await client.query(
      'UPDATE drops SET claimed_count = claimed_count + 1 WHERE id = $1',
      [drop_id]
    );

    const { rows } = await client.query('SELECT * FROM claims WHERE id = $1', [id]);

    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ====== REST – DROPS ======
app.get(['/api/drops', '/drops'], async (req, res) => {
  try {
    const status = req.query.status || 'active';
    const rows = await listDrops(status);
    res.json(rows);
  } catch (e) {
    console.error('drops list', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post(['/api/drops', '/drops'], async (req, res) => {
  try {
    const drop = await createDrop(req.body);
    io.emit('drop:created', drop);
    res.json({ ok: true, drop });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.patch(['/api/drops/:id', '/drops/:id'], async (req, res) => {
  try {
    const d = await updateDrop(req.params.id, req.body);
    if (!d) return res.status(404).json({ ok: false, error: 'NE_OBSTAJA' });
    io.emit('drop:updated', d);
    res.json({ ok: true, drop: d });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete(['/api/drops/:id', '/drops/:id'], async (req, res) => {
  try {
    const ok = await deleteDrop(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'NE_OBSTAJA' });
    io.emit('drop:deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== REST – CLAIMS & NAGRADE ======
app.post(['/api/claims', '/claims'], async (req, res) => {
  try {
    const claim = await createClaim(req.body || {});
    io.emit('claim:created', claim);
    res.json({ ok: true, claim });
  } catch (e) {
    res
      .status(e.code === 'TOO_FAR' ? 403 : 400)
      .json({ ok: false, error: e.message });
  }
});

// *** AR CLAIM – posebna pot iz ar.html (brez lokacije, samo drop+user) ***
app.post(['/api/ar-claim', '/ar-claim'], async (req, res) => {
  try {
    const { drop_id, user_id, user_name = null, value = 1 } = req.body || {};
    if (!drop_id || !user_id) {
      return res.status(400).json({ ok: false, error: 'MANJKA_drop_id_user_id' });
    }

    const claim = await createClaim({
      drop_id,
      user_id,
      user_name,
      value,
      lat: null,
      lng: null
    });

    io.emit('claim:created', claim);
    res.json({ ok: true, claim });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/claims
// - brez user_id  -> vsi prevzemi (dashboard)
// - z user_id     -> samo prevzemi tega uporabnika (app – Nagrade)
app.get(['/api/claims', '/claims'], async (req, res) => {
  const user_id = req.query.user_id;

  if (!useDb || !pool) {
    let rows = mem.claims
      .map(c => ({
        ...c,
        drop: mem.drops.find(d => d.id === c.drop_id) || null
      }))
      .sort((a, b) => new Date(b.claimed_at) - new Date(a.claimed_at));

    if (user_id) {
      rows = rows.filter(c => String(c.user_id) === String(user_id));
    }
    return res.json(rows);
  }

  try {
    const params = [];
    let where = '';
    if (user_id) {
      where = 'WHERE c.user_id = $1';
      params.push(String(user_id));
    }

    const { rows } = await pool.query(
      `SELECT c.*, 
              d.title AS drop_title,
              d.radius_m AS drop_radius_m,
              d.lat AS drop_lat,
              d.lng AS drop_lng
       FROM claims c
       LEFT JOIN drops d ON d.id = c.drop_id
       ${where}
       ORDER BY c.claimed_at DESC
       LIMIT 1000`,
      params
    );

    const mapped = rows.map(r => ({
      id: r.id,
      drop_id: r.drop_id,
      user_id: r.user_id,
      user_name: r.user_name,
      value: r.value,
      tx_hash: r.tx_hash,
      claimed_at: r.claimed_at,
      drop_title: r.drop_title,
      drop: {
        id: r.drop_id,
        title: r.drop_title,
        radius_m: r.drop_radius_m,
        lat: r.drop_lat,
        lng: r.drop_lng
      }
    }));

    res.json(mapped);
  } catch (e) {
    console.error('claims list', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== STATS ======
app.get(['/api/stats', '/stats'], async (_req, res) => {
  if (!useDb || !pool) {
    const last = mem.claims[mem.claims.length - 1] || null;
    return res.json({
      totals: { drops: mem.drops.length, claims: mem.claims.length },
      lastClaim: last
    });
  }

  try {
    const c1 = await pool.query('SELECT COUNT(*)::int AS c FROM drops');
    const c2 = await pool.query('SELECT COUNT(*)::int AS c FROM claims');
    const last = await pool.query(
      'SELECT * FROM claims ORDER BY claimed_at DESC LIMIT 1'
    );

    res.json({
      totals: {
        drops: c1.rows[0].c || 0,
        claims: c2.rows[0].c || 0
      },
      lastClaim: last.rows[0] || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== SOCKET.IO ======
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'] }
});

io.on('connection', socket => {
  socket.emit('hello', { version: VERSION });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MoveServer (Postgres + auth + AR) teče na :${PORT}`);
});
