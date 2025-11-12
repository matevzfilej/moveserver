// MoveServer (CJS) — Express + Socket.IO — CRUD Drops, varni Claim-i, Statistika, Nagrade
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const VERSION = 'v3.1-sl-pastel-delete-rewards';

// ====== DB ali spomin ======
let pool = null, useDb = false;
try {
  const { Pool } = require('pg');
  if (process.env.DATABASE_URL) {
    const needSsl =
      process.env.PGSSLMODE === 'require' ||
      (process.env.DATABASE_URL || '').includes('sslmode=require');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: needSsl ? { rejectUnauthorized: false } : false
    });
    useDb = true;
    console.log('[DB] PostgreSQL je aktiven');
  } else {
    console.log('[DB] DATABASE_URL ni nastavljen → način spomin');
  }
} catch {
  console.log('[DB] pg ni na voljo → način spomin');
}

const mem = { drops: [], claims: [] };
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
const toNum = (v, def = null) =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(+v) ? +v : def;

// ====== MIGRACIJE ======
const MIGRATE_TOKEN = process.env.MIGRATE_TOKEN || '';
const MIGRATE_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TABLE IF NOT EXISTS drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'geo',
  status TEXT NOT NULL DEFAULT 'active',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_m INTEGER DEFAULT 25,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by TEXT,
  claimed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drops_status_idx ON drops (status);
CREATE INDEX IF NOT EXISTS drops_geo_idx ON drops (lat,lng);

CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  value NUMERIC(18,8),
  tx_hash TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(drop_id, user_id)
);
`;

app.get('/health', (_, res) => res.json({ ok: true, db: useDb ? 'pg' : 'memory', version: VERSION }));
app.get('/version', (_, res) => res.type('text').send(VERSION));
app.get('/admin/run-migrate', async (req, res) => {
  try {
    if (!MIGRATE_TOKEN || req.query.token !== MIGRATE_TOKEN) return res.status(401).json({ ok: false, error: 'NEPOOBLAŠČENO' });
    if (!useDb) return res.status(400).json({ ok: false, error: 'BREZ_BAZE' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(MIGRATE_SQL); await c.query('COMMIT');
      res.json({ ok: true, message: 'Migracije OK' });
    } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ ok: false, error: e.message }); }
    finally { c.release(); }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ====== Pomožna logika ======
async function listDrops({ status }) {
  if (!useDb) {
    const arr = status && status !== 'all'
      ? mem.drops.filter(d => d.status === status)
      : mem.drops.slice();
    return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  const where = (status && status !== 'all') ? 'WHERE status=$1' : '';
  const params = (status && status !== 'all') ? [status] : [];
  const { rows } = await pool.query(`SELECT * FROM drops ${where} ORDER BY created_at DESC LIMIT 1000`, params);
  return rows;
}
async function getDrop(id) {
  if (!useDb) return mem.drops.find(d => d.id === id) || null;
  const { rows } = await pool.query(`SELECT * FROM drops WHERE id=$1`, [id]);
  return rows[0] || null;
}
async function createDrop(data) {
  const { title, kind = 'geo', lat = null, lng = null, radius_m = 25, metadata = {}, created_by = null } = data || {};
  if (!title) throw new Error('MANJKA_TITLE');
  const row = { title, kind: String(kind || 'geo'), lat: toNum(lat, null), lng: toNum(lng, null), radius_m: toNum(radius_m, 25), metadata, created_by };
  if (!useDb) {
    const d = { id: uuid(), ...row, status: 'active', claimed_count: 0, created_at: new Date().toISOString() };
    mem.drops.push(d); return d;
  }
  const { rows } = await pool.query(
    `INSERT INTO drops (title,kind,status,lat,lng,radius_m,metadata,created_by)
     VALUES ($1,$2,'active',$3,$4,$5,$6,$7) RETURNING *`,
    [row.title, row.kind, row.lat, row.lng, row.radius_m, row.metadata, row.created_by]
  );
  return rows[0];
}
async function updateDrop(id, patch) {
  const fields = ['title', 'lat', 'lng', 'radius_m', 'status', 'metadata'];
  const obj = {}; fields.forEach(f => { if (patch[f] !== undefined) obj[f] = patch[f]; });
  if (!Object.keys(obj).length) return await getDrop(id);

  if (!useDb) {
    const d = mem.drops.find(x => x.id === id); if (!d) return null;
    Object.assign(d, {
      title: obj.title ?? d.title,
      lat: obj.lat !== undefined ? toNum(obj.lat, null) : d.lat,
      lng: obj.lng !== undefined ? toNum(obj.lng, null) : d.lng,
      radius_m: obj.radius_m !== undefined ? toNum(obj.radius_m, d.radius_m) : d.radius_m,
      status: obj.status ?? d.status,
      metadata: obj.metadata ?? d.metadata
    });
    return d;
  }
  const sets = [], vals = []; let i = 1;
  for (const k of Object.keys(obj)) { sets.push(`${k}=$${i++}`); vals.push(k === 'radius_m' ? toNum(obj[k], null) : obj[k]); }
  vals.push(id);
  const { rows } = await pool.query(`UPDATE drops SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
  return rows[0] || null;
}
async function deleteDrop(id) {
  if (!useDb) {
    const idx = mem.drops.findIndex(d => d.id === id);
    if (idx === -1) return false;
    mem.drops.splice(idx, 1);
    for (let i = mem.claims.length - 1; i >= 0; i--) if (mem.claims[i].drop_id === id) mem.claims.splice(i, 1);
    return true;
  }
  await pool.query(`DELETE FROM claims WHERE drop_id=$1`, [id]);
  const r = await pool.query(`DELETE FROM drops WHERE id=$1`, [id]);
  return r.rowCount > 0;
}
function toRad(x){ return x * Math.PI/180; }
function distanceMeters(a,b){
  const R=6371000,dLat=toRad(b.lat-a.lat),dLon=toRad(b.lng-a.lng);
  const la1=toRad(a.lat),la2=toRad(b.lat);
  const x=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
async function createClaim({ drop_id, user_id, value = null, tx_hash = null, lat = null, lng = null }) {
  if (!drop_id || !user_id) throw new Error('SLAB_PODATEK');
  const d = await getDrop(drop_id);
  if (!d) throw new Error('DROP_NE_OBSTAJA');

  if (d.lat != null && d.lng != null && lat != null && lng != null) {
    const dist = distanceMeters({ lat, lng }, { lat: d.lat, lng: d.lng });
    if (d.radius_m != null && dist > d.radius_m) {
      const left = Math.max(0, Math.round(dist - d.radius_m));
      const err = new Error(`PREDALec:${left}`); err.code='TOO_FAR'; throw err;
    }
  }

  if (!useDb) {
    if (mem.claims.find(c => c.drop_id === drop_id && c.user_id === user_id))
      throw new Error('ZE_CLAIMANO');
    const claim = { id: uuid(), drop_id, user_id, value: toNum(value, null), tx_hash, claimed_at: new Date().toISOString() };
    mem.claims.push(claim);
    const dd = mem.drops.find(x => x.id === drop_id); if (dd) dd.claimed_count = (dd.claimed_count || 0) + 1;
    return claim;
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(
      `INSERT INTO claims (drop_id,user_id,value,tx_hash)
       VALUES ($1,$2,$3,$4) ON CONFLICT (drop_id,user_id) DO NOTHING RETURNING *`,
      [drop_id, user_id, toNum(value, null), tx_hash]
    );
    const claim = ins.rows[0];
    if (!claim) { await c.query('ROLLBACK'); throw new Error('ZE_CLAIMANO'); }
    await c.query(`UPDATE drops SET claimed_count=claimed_count+1 WHERE id=$1`, [drop_id]);
    await c.query('COMMIT');
    return claim;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

// ====== REST ======
// Drops
app.get(['/api/drops','/drops'], async (req,res)=>{
  try { res.json(await listDrops({ status: req.query.status || 'active' })); }
  catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});
app.post(['/api/drops','/drops'], async (req,res)=>{
  try { const d = await createDrop(req.body); io.emit('drop:created', d); res.json({ ok:true, drop:d }); }
  catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});
app.patch(['/api/drops/:id','/drops/:id'], async (req,res)=>{
  try { const d = await updateDrop(req.params.id, req.body); if(!d) return res.status(404).json({ ok:false, error:'NE_OBSTAJA' }); io.emit('drop:updated', d); res.json({ ok:true, drop:d }); }
  catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});
app.delete(['/api/drops/:id','/drops/:id'], async (req,res)=>{
  try { const ok = await deleteDrop(req.params.id); if(!ok) return res.status(404).json({ ok:false, error:'NE_OBSTAJA' }); io.emit('drop:deleted', { id:req.params.id }); res.json({ ok:true }); }
  catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// Claims / Rewards
app.post(['/api/claims','/claims'], async (req,res)=>{
  try { const c = await createClaim(req.body); io.emit('claim:created', c); res.json({ ok:true, claim:c }); }
  catch(e){ res.status(e.code==='TOO_FAR'?403:400).json({ ok:false, error:e.message }); }
});
app.get(['/api/claims','/claims'], async (req,res)=>{
  const { user_id } = req.query;
  if(!user_id) return res.status(400).json({ ok:false, error:'MANJKA_user_id' });
  if(!useDb){
    const rows = mem.claims
      .filter(c=>c.user_id===user_id)
      .map(c=>({ ...c, drop: mem.drops.find(d=>d.id===c.drop_id) || null }))
      .sort((a,b)=>new Date(b.claimed_at)-new Date(a.claimed_at));
    return res.json(rows);
  }
  try{
    const { rows } = await pool.query(
      `SELECT c.*, to_json(d.*) AS drop
       FROM claims c LEFT JOIN drops d ON d.id=c.drop_id
       WHERE c.user_id=$1 ORDER BY c.claimed_at DESC LIMIT 500`, [user_id]
    );
    res.json(rows);
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// Statistika
app.get(['/api/stats','/stats'], async (_req,res)=>{
  if(!useDb){
    const last = mem.claims[mem.claims.length-1] || null;
    return res.json({ totals:{ drops:mem.drops.length, claims:mem.claims.length }, lastClaim:last });
  }
  try{
    const r1 = await pool.query(`SELECT COUNT(*)::int AS c FROM drops`);
    const r2 = await pool.query(`SELECT COUNT(*)::int AS c FROM claims`);
    const r3 = await pool.query(`SELECT * FROM claims ORDER BY claimed_at DESC LIMIT 1`);
    res.json({ totals:{ drops:r1.rows[0].c, claims:r2.rows[0].c }, lastClaim:r3.rows[0] || null });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// ====== Socket.IO ======
const httpServer = createServer(app);
const io = new Server(httpServer, { cors:{ origin:true, methods:['GET','POST','PATCH','DELETE'] } });
io.on('connection', (socket)=>{ socket.emit('hello', { version: VERSION }); });

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, ()=>console.log(`MoveServer posluša na :${PORT}`));
