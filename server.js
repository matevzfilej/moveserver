// Simple in-memory MoveServer (users + drops + claims)
// DEMO ONLY – everything is lost when server restarts.

const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const VERSION = "demo-mem-v1";

// === helpers =====================================================

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST", "PATCH", "DELETE"] }
});

const mem = {
  users: [],  // {id, username, passHash, created_at}
  drops: [],  // {id, title, lat, lng, radius_m, status, claimed_count, created_at}
  claims: []  // {id, user_id, drop_id, lat, lng, claimed_at}
};

const genId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const hashPass = (p) =>
  crypto.createHash("sha256").update(String(p)).digest("hex");

const toNum = (v, def = null) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : Number.isFinite(+v)
    ? +v
    : def;

const toRad = (x) => (x * Math.PI) / 180;
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

// === health ======================================================

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: "memory", version: VERSION });
});

app.get("/version", (_req, res) => {
  res.type("text").send(VERSION);
});

// === AUTH: register + login ======================================

// POST /api/register { username, password }
app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "MANJKA_UPORABNISKO_IME_ALI_GESLO" });
  }
  const name = String(username).trim().toLowerCase();
  if (!name) {
    return res.status(400).json({ ok: false, error: "NAPACNO_IME" });
  }
  if (mem.users.find((u) => u.username === name)) {
    return res.status(400).json({ ok: false, error: "UPORABNIK_ZE_OBSTAJA" });
  }
  const user = {
    id: genId("u"),
    username: name,
    passHash: hashPass(password),
    created_at: new Date().toISOString()
  };
  mem.users.push(user);
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

// POST /api/login { username, password }
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "MANJKA_UPORABNISKO_IME_ALI_GESLO" });
  }
  const name = String(username).trim().toLowerCase();
  const user = mem.users.find((u) => u.username === name);
  if (!user || user.passHash !== hashPass(password)) {
    return res.status(400).json({ ok: false, error: "NAPACNI_PODATKI" });
  }
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

// === DROPS CRUD ==================================================

// GET /api/drops?status=active|all|archived
app.get("/api/drops", (req, res) => {
  const status = req.query.status || "active";
  let list = mem.drops.slice();
  if (status !== "all") {
    list = list.filter((d) => d.status === status);
  }
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(list);
});

// POST /api/drops {title, lat, lng, radius_m}
app.post("/api/drops", (req, res) => {
  try {
    const { title, lat, lng, radius_m } = req.body || {};
    if (!title) throw new Error("MANJKA_TITLE");
    const row = {
      id: genId("d"),
      title: String(title),
      lat: toNum(lat, null),
      lng: toNum(lng, null),
      radius_m: toNum(radius_m, 50),
      status: "active",
      claimed_count: 0,
      created_at: new Date().toISOString()
    };
    mem.drops.push(row);
    io.emit("drop:created", row);
    res.json({ ok: true, drop: row });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// PATCH /api/drops/:id
app.patch("/api/drops/:id", (req, res) => {
  const id = req.params.id;
  const d = mem.drops.find((x) => x.id === id);
  if (!d) return res.status(404).json({ ok: false, error: "NE_OBSTAJA" });
  const { title, lat, lng, radius_m, status } = req.body || {};
  if (title !== undefined) d.title = String(title);
  if (lat !== undefined) d.lat = toNum(lat, d.lat);
  if (lng !== undefined) d.lng = toNum(lng, d.lng);
  if (radius_m !== undefined) d.radius_m = toNum(radius_m, d.radius_m);
  if (status !== undefined) d.status = String(status);
  io.emit("drop:updated", d);
  res.json({ ok: true, drop: d });
});

// DELETE /api/drops/:id
app.delete("/api/drops/:id", (req, res) => {
  const id = req.params.id;
  const idx = mem.drops.findIndex((d) => d.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "NE_OBSTAJA" });
  mem.drops.splice(idx, 1);
  // pobrišemo claim-e za ta drop
  for (let i = mem.claims.length - 1; i >= 0; i--) {
    if (mem.claims[i].drop_id === id) mem.claims.splice(i, 1);
  }
  io.emit("drop:deleted", { id });
  res.json({ ok: true });
});

// === CLAIMS ======================================================

// POST /api/claims {drop_id, user_id, lat, lng}
app.post("/api/claims", (req, res) => {
  try {
    const { drop_id, user_id, lat, lng } = req.body || {};
    if (!drop_id || !user_id) {
      return res.status(400).json({ ok: false, error: "MANJKA_PODATKE" });
    }

    const user = mem.users.find((u) => u.id === user_id);
    if (!user) throw new Error("UPORABNIK_NE_OBSTAJA");

    const drop = mem.drops.find((d) => d.id === drop_id && d.status === "active");
    if (!drop) throw new Error("DROP_NE_OBSTAJA");

    // že prevzel?
    if (
      mem.claims.find(
        (c) => c.drop_id === drop_id && String(c.user_id) === String(user_id)
      )
    ) {
      throw new Error("ZE_CLAIMANO");
    }

    // razdalja
    if (
      drop.lat != null &&
      drop.lng != null &&
      lat != null &&
      lng != null &&
      drop.radius_m != null
    ) {
      const dist = distanceMeters(
        { lat: toNum(lat), lng: toNum(lng) },
        { lat: drop.lat, lng: drop.lng }
      );
      if (dist > drop.radius_m) {
        const left = Math.round(dist - drop.radius_m);
        const err = new Error("PREDALEC:" + left);
        err.code = "TOO_FAR";
        throw err;
      }
    }

    const claim = {
      id: genId("c"),
      user_id,
      drop_id,
      lat: toNum(lat, null),
      lng: toNum(lng, null),
      claimed_at: new Date().toISOString()
    };
    mem.claims.push(claim);
    drop.claimed_count = (drop.claimed_count || 0) + 1;
    io.emit("claim:created", claim);
    res.json({ ok: true, claim });
  } catch (e) {
    res
      .status(e.code === "TOO_FAR" ? 403 : 400)
      .json({ ok: false, error: e.message });
  }
});

// GET /api/claims?user_id=...
app.get("/api/claims", (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    return res.status(400).json({ ok: false, error: "MANJKA_user_id" });
  }
  const list = mem.claims
    .filter((c) => String(c.user_id) === String(user_id))
    .map((c) => ({
      ...c,
      drop: mem.drops.find((d) => d.id === c.drop_id) || null
    }))
    .sort((a, b) => new Date(b.claimed_at) - new Date(a.claimed_at));
  res.json(list);
});

// === STATS =======================================================

app.get("/api/stats", (_req, res) => {
  res.json({
    totals: {
      drops: mem.drops.length,
      claims: mem.claims.length
    },
    lastClaim: mem.claims[mem.claims.length - 1] || null
  });
});

// === root ========================================================

app.get("/", (_req, res) => {
  res.type("text").send("MoveServer demo is running. Version " + VERSION);
});

// === socket.io ===================================================

io.on("connection", (socket) => {
  console.log("Socket connected", socket.id);
  socket.emit("hello", { version: VERSION });
});

// === start =======================================================

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log("MoveServer demo listening on :" + PORT);
});
