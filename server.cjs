// MoveServer — Express + Socket.IO — REST (/api aliases) + simple DB migrate 1
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ===== Version marker (da takoj vemo, katera koda teče)
const VERSION = 'v-api-alias+migrate-001';
app.get('/version', (_,res)=>res.type('text').send(VERSION));

/* ===== Optional PostgreSQL ===== */
let pool = null, useDb = false;
try {
  const { Pool } = require('pg');
  if (process.env.DATABASE_URL) {
    const needSsl = process.env.PGSSLMODE === 'require' || (process.env.DATABASE_URL||'').includes('sslmode=require');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: needSsl ? { rejectUnauthorized: false } : false });
    useDb = true;
    console.log('[DB] Using PostgreSQL');
  } else {
    console.log('[DB] No DATABASE_URL → memory mode');
  }
} catch {
  console.log('[DB] pg not available → memory mode'); useDb = false;
}

/* ===== Memory fallback ===== */
const dropsMem = [], claimsMem = [];
const uuid = ()=>'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
  const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16);
});
const toNum = (v, def=null) => Number.isFinite(+v) ? +v : def;

/* ===== Logic ===== */
async function createDrop(data){
  const { title, kind='geo', lat=null, lng=null, radius_m=25, starts_at=null, expires_at=null, metadata={}, created_by=null } = data||{};
  if (!title) throw new Error('TITLE_REQUIRED');
  const row = { title, kind:String(kind||'geo'), lat:toNum(lat,null), lng:toNum(lng,null), radius_m:toNum(radius_m,25), starts_at, expires_at, metadata:metadata||{}, created_by };

  if (!useDb) {
    const drop = { id: uuid(), ...row, status:'active', claimed_count:0, created_at:new Date().toISOString() };
    dropsMem.push(drop); return { drop, source:'memory' };
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO drops (title,kind,status,lat,lng,radius_m,starts_at,expires_at,metadata,created_by)
       VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [row.title,row.kind,row.lat,row.lng,row.radius_m,row.starts_at,row.expires_at,row.metadata,row.created_by]
    );
    return { drop: rows[0], source:'db' };
  } catch (e) {
    console.error('/drop:create PG error → memory:', e.message);
    const drop = { id: uuid(), ...row, status:'active', claimed_count:0, created_at:new Date().toISOString() };
    dropsMem.push(drop); return { drop, source:'memory' };
  }
}

async function createClaim(data){
  const { drop_id, user_id, value=null, tx_hash=null } = data||{};
  if (!drop_id || !user_id) throw new Error('BAD_PAYLOAD');

  if (!useDb) {
    if (claimsMem.find(c=>c.drop_id===drop_id && c.user_id===user_id)) throw new Error('ALREADY_CLAIMED');
    const claim = { id: uuid(), drop_id, user_id, value:toNum(value,null), tx_hash, claimed_at:new Date().toISOString() };
    claimsMem.push(claim);
    const d = dropsMem.find(d=>d.id===drop_id); if (d) d.claimed_count=(d.claimed_count||0)+1;
    return { claim, source:'memory' };
  }
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO claims (drop_id,user_id,value,tx_hash)
         VALUES ($1,$2,$3,$4) ON CONFLICT (drop_id,user_id) DO NOTHING RETURNING *`,
        [drop_id,user_id,toNum(value,null),tx_hash]
      );
      const claim = ins.rows[0];
      if (claim) {
        await client.query(`UPDATE drops SET claimed_count=claimed_count+1 WHERE id=$1`, [drop_id]);
        await client.query('COMMIT');
        return { claim, source:'db' };
      } else { await client.query('ROLLBACK'); throw new Error('ALREADY_CLAIMED'); }
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) {
    console.error('/drop:claim PG error → memory:', e.message);
    if (claimsMem.find(c=>c.drop_id===drop_id && c.user_id===user_id)) throw new Error('ALREADY_CLAIMED');
    const claim = { id: uuid(), drop_id, user_id, value:toNum(value,null), tx_hash, claimed_at:new Date().toISOString() };
    claimsMem.push(claim);
    const d = dropsMem.find(d=>d.id===drop_id); if (d) d.claimed_count=(d.claimed_count||0)+1;
    return { claim, source:'memory' };
  }
}

/* ===== Health ===== */
app.get('/health', (_req,res)=>res.json({ ok:true, db: useDb?'pg':'memory', version: VERSION }));

/* ===== /admin/run-migrate (1-click) ===== */
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
CREATE INDEX IF NOT EXISTS drops_geo_idx ON drops (lat, lng);
CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  value NUMERIC(18,8),
  tx_hash TEXT,
  UNIQUE (drop_id, user_id)
);
`;
app.get('/admin/run-migrate', async (req,res)=>{
  try{
    if(!MIGRATE_TOKEN || req.query.token !== MIGRATE_TOKEN) return res.status(401).json({ok:false,error:'UNAUTHORIZED'});
    if(!useDb) return res.status(400).json({ok:false,error:'NO_DATABASE'});
    const client = await pool.connect();
    try{ await client.query('BEGIN'); await client.query(MIGRATE_SQL); await client.query('COMMIT'); res.json({ok:true,message:'Migration OK'}); }
    catch(e){ await client.query('ROLLBACK'); res.status(500).json({ok:false,error:e.message}); }
    finally{ client.release(); }
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

/* ===== REST (z /api aliasi) ===== */
function rest(prefix='') {
  app.get(`${prefix}/drops`, async (_req,res)=>{
    if(!useDb) return res.json(dropsMem.slice().reverse().slice(0,500));
    try{ const {rows}=await pool.query(`SELECT * FROM drops ORDER BY created_at DESC LIMIT 500`); res.json(rows); }
    catch(e){ console.error('/drops PG error → memory:', e.message); res.json(dropsMem.slice().reverse().slice(0,500)); }
  });
  app.post(`${prefix}/drops`, async (req,res)=>{
    try{ const {drop,source}=await createDrop(req.body); io.emit('drop:created', drop); res.json({ok:true,drop,source}); }
    catch(e){ res.status(400).json({ok:false,error:e.message||'CREATE_FAILED'}); }
  });
  app.post(`${prefix}/claims`, async (req,res)=>{
    try{ const {claim,source}=await createClaim(req.body); io.emit('claim:created', claim); res.json({ok:true,claim,source}); }
    catch(e){ res.status(400).json({ok:false,error:e.message||'CLAIM_FAILED'}); }
  });
}
rest('');       // /drops, /claims
rest('/api');   // /api/drops, /api/claims

/* ===== Socket.IO ===== */
const httpServer = createServer(app);
const io = new Server(httpServer, { cors:{ origin:true, methods:['GET','POST'] } });
io.on('connection', (socket)=>{ socket.emit('hello', {version:VERSION}); });

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, ()=>console.log(`MoveServer up on :${PORT}`));
