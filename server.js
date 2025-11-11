// server.js — MoveServer (Render)
// --------------------------------

const express = require("express");
const http = require("http");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// ── Config ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

// dovoljeni origin-i (CSV v env CORS_ORIGIN) + default za onrender domeno
const CSV = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = [
  "https://moveserver.onrender.com", // self (za varnost)
  ...CSV
];

// CORS za Express (HTTP API)
app.use(cors({
  origin: function (origin, cb) {
    // omogoči tudi curl/postman (origin = undefined)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false
}));
app.use(express.json());

// ── Socket.IO z lastnim CORS ───────────────────────────────────────────
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ["websocket", "polling"],
  pingTimeout: 20000,
  pingInterval: 25000
});

// ── In-memory demo storage (za predstavitev) ───────────────────────────
let drops = [];   // {id,title,lat,lng,...}
let claims = [];  // {dropId,user,claimed_at}

// ── Socket handlers ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("drop:create", (drop) => {
    // dodeli ID, shrani v RAM, broadcast
    const d = { id: Date.now().toString(36), ...drop };
    drops.push(d);
    io.emit("drop:create", d);
  });

  socket.on("claim:create", (claim) => {
    const c = { claimed_at: new Date().toISOString(), ...claim };
    claims.push(c);
    io.emit("claim:create", c);
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// ── HTTP API (za varnost / fallback) ───────────────────────────────────
app.get("/", (_req, res) => res.send("MoveServer OK"));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/drops", (_req, res) => {
  res.json(drops);
});

app.post("/api/drops", (req, res) => {
  const payload = req.body || {};
  const d = { id: Date.now().toString(36), ...payload };
  drops.push(d);
  io.emit("drop:create", d);  // broadcast tudi iz HTTP
  res.json(d);
});

app.post("/api/claims", (req, res) => {
  const payload = req.body || {};
  const c = { claimed_at: new Date().toISOString(), ...payload };
  claims.push(c);
  io.emit("claim:create", c);
  res.json(c);
});

// ── Start ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log("MoveServer on :", PORT);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});
