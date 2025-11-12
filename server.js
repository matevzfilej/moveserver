const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();

// === CORS ===
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0) return cb(null, true);
    const ok = allowedOrigins.some(o => origin === o);
    return ok ? cb(null, true) : cb(new Error('CORS blocked'), false);
  },
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Routes ===
const statsRouter = require('./routes/stats');
const dropsRouter = require('./routes/drops');
app.use('/stats', statsRouter);
app.use('/drops', dropsRouter);

// === Static (optional, če uporabljaš lokalni dash) ===
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

// === Socket.io ===
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  require('./socket/dropHandlers')(io, socket);
  require('./socket/claimHandlers')(io, socket);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log('MoveServer running on port', PORT));
