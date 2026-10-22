const express = require("express");
const { Pool } = require("pg");
const http = require("http");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const promClient = require("@prometheus-io/client");

promClient.collectDefaultMetrics();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const httpRequests = new promClient.Counter({
  name: 'chat_http_requests_total', help: 'Completed Express HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});
const httpDuration = new promClient.Histogram({
  name: 'chat_http_request_duration_seconds', help: 'Express HTTP request duration',
  labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5]
});
const socketConnections = new promClient.Gauge({
  name: 'chat_socketio_connections', help: 'Currently authenticated Socket.IO connections'
});
socketConnections.set(0);
// Fixed route templates only: never label arbitrary URL paths, accounts or rooms.
app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    const labels = {
      method: ['GET','POST','HEAD','OPTIONS','PUT','DELETE','PATCH'].includes(req.method) ? req.method : 'OTHER',
      route: req.route?.path || 'unmatched', status_code: String(res.statusCode)
    };
    httpRequests.inc(labels);
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    httpDuration.observe(labels, duration);
    console.log(JSON.stringify({ kind: 'chat_safe', safe: `http method=${labels.method} route=${labels.route} status=${labels.status_code} duration=${duration.toFixed(6)}` }));
  });
  next();
});

app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || "postgres",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "chatdb",
  user: process.env.DB_USER || "chatuser",
  password: process.env.DB_PASSWORD_FILE
    ? require('node:fs').readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim()
    : process.env.DB_PASSWORD
});

const PgStore = require('connect-pg-simple')(session);
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
const sessionMiddleware = session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Vui lòng đăng nhập."
    });
  }

  next();
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});

app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", promClient.register.contentType);
    res.end(await promClient.register.metrics());
  } catch (error) {
    console.error("Could not collect metrics:", error.message);
    res.status(500).end("Could not collect metrics");
  }
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        error: "Vui lòng nhập tên đăng nhập và mật khẩu."
      });
    }

    const cleanUsername = username.trim();

    if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: "Tên đăng nhập phải dài 3–50 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang."
      });
    }

    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({
        error: "Mật khẩu cần ít nhất 8 ký tự và tối đa 72 byte UTF-8."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username`,
      [cleanUsername, passwordHash]
    );

    const user = result.rows[0];

    io.in(`session:${req.sessionID}`).disconnectSockets(true);
    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error("Session error:", sessionError.message);
        return res.status(500).json({
          error: "Không thể tạo phiên đăng nhập."
        });
      }

      req.session.user = {
        id: user.id,
        username: user.username
      };

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError.message);
          return res.status(500).json({
            error: "Không thể lưu phiên đăng nhập."
          });
        }

        res.status(201).json({ user: req.session.user });
      });
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Tên đăng nhập đã tồn tại."
      });
    }

    console.error("Registration failed:", error.message);
    res.status(500).json({
      error: "Đăng ký thất bại."
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        error: "Vui lòng nhập tên đăng nhập và mật khẩu."
      });
    }

    if (Buffer.byteLength(password, "utf8") > 72) {
      return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng." });
    }

    const result = await pool.query(
      `SELECT id, username, password_hash
       FROM users
       WHERE username = $1`,
      [username.trim()]
    );

    if (
      result.rows.length === 0 ||
      !(await bcrypt.compare(password, result.rows[0].password_hash))
    ) {
      return res.status(401).json({
        error: "Tên đăng nhập hoặc mật khẩu không đúng."
      });
    }

    const user = {
      id: result.rows[0].id,
      username: result.rows[0].username
    };

    io.in(`session:${req.sessionID}`).disconnectSockets(true);
    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error("Session error:", sessionError.message);
        return res.status(500).json({
          error: "Không thể tạo phiên đăng nhập."
        });
      }

      req.session.user = user;

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError.message);
          return res.status(500).json({
            error: "Không thể lưu phiên đăng nhập."
          });
        }

        res.json({ user });
      });
    });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({
      error: "Đăng nhập thất bại."
    });
  }
});

app.post("/api/logout", (req, res) => {
  const sessionId = req.sessionID;
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error.message);
      return res.status(500).json({
        error: "Đăng xuất thất bại."
      });
    }

    io.in(`session:${sessionId}`).disconnectSockets(true);
    res.clearCookie("connect.sid");
    res.json({ message: "Đã đăng xuất." });
  });
});

async function authorizeRoom(room,userId) {
  const result=await pool.query('SELECT 1 FROM rooms r WHERE r.name=$1 AND (r.owner_id IS NULL OR r.owner_id=$2 OR EXISTS (SELECT 1 FROM room_members m WHERE m.room=r.name AND m.user_id=$2))',[room,userId]);
  if (!result.rowCount) throw new Error('FORBIDDEN');
}
app.post('/api/rooms/members',requireLogin,async(req,res)=> {
  const {room,username}=req.body||{};
  if(typeof room!=='string'||typeof username!=='string') return res.status(400).json({error:'INVALID_INPUT'});
  try {
    const owner=await pool.query('SELECT 1 FROM rooms WHERE name=$1 AND owner_id=$2',[room,req.session.user.id]);
    if(!owner.rowCount) return res.status(403).json({error:'FORBIDDEN'});
    const target=await pool.query('SELECT id FROM users WHERE username=$1',[username.trim()]);
    if(!target.rowCount) return res.status(404).json({error:'USER_NOT_FOUND'});
    await pool.query('INSERT INTO room_members(room,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[room,target.rows[0].id]);
    res.json({ok:true});
  } catch {res.status(500).json({error:'DATABASE_ERROR'});}
});

io.use((socket, next) => {
  const user = socket.request.session?.user;

  if (!user) {
    return next(new Error("UNAUTHORIZED"));
  }

  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  socketConnections.inc();
  socket.once('disconnect', () => socketConnections.dec());
  const user = socket.data.user;

  console.log(JSON.stringify({ kind: 'chat_safe', safe: 'socket_connected' }));

  socket.join('session:' + socket.request.sessionID);
  const expiryTimer = setInterval(() => {
    socket.request.session.reload(error => {
      if (error || !socket.request.session?.user) socket.disconnect(true);
    });
  }, 30000);
  expiryTimer.unref();
  socket.once('disconnect', () => clearInterval(expiryTimer));
  let queue = Promise.resolve();
  const handle = (event, action) => socket.on(event, (data, ack) => {
    queue = queue.then(async () => {
      await new Promise((resolve, reject) => socket.request.session.reload(err => err ? reject(new Error('UNAUTHORIZED')) : resolve()));
      if (!socket.request.session.user || !socket.connected) throw new Error('UNAUTHORIZED');
      const result = await action(data);
      if (typeof ack === 'function') ack({ ok: true, ...result });
    }).catch(error => {
      const message = ['UNAUTHORIZED','FORBIDDEN','INVALID_ROOM','INVALID_MESSAGE'].includes(error.message) ? error.message : 'DATABASE_ERROR';
      socket.emit('chat-error', message);
      if (typeof ack === 'function') ack({ ok: false, error: message });
      if (message === 'UNAUTHORIZED') socket.disconnect(true);
    });
  });
  handle('join-room', async room => {
    if (typeof room !== 'string' || !room.trim() || room.trim().length > 100) throw new Error('INVALID_ROOM');
    room = room.trim();
    await pool.query('INSERT INTO rooms(name,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [room,user.id]);
    await authorizeRoom(room,user.id);
    for (const joined of socket.rooms) if (joined.startsWith('chat:')) await socket.leave(joined);
    const history = await pool.query('SELECT id,room,message,username,created_at FROM messages WHERE room=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [room]);
    if (!socket.connected) throw new Error('UNAUTHORIZED');
    await socket.join('chat:' + room);
    socket.data.room = room;
    socket.emit('chat-history',history.rows.reverse());
    return {room};
  });
  handle('chat-message', async data => {
    if (!data || typeof data.room !== 'string' || typeof data.message !== 'string') throw new Error('INVALID_MESSAGE');
    const room=data.room.trim(), message=data.message.trim();
    if (!message || message.length>2000) throw new Error('INVALID_MESSAGE');
    if (socket.data.room!==room || !socket.rooms.has('chat:'+room)) throw new Error('FORBIDDEN');
    await authorizeRoom(room,user.id);
    const result=await pool.query('INSERT INTO messages(room,message,user_id,username) VALUES($1,$2,$3,$4) RETURNING id,room,message,user_id,username,created_at',[room,message,user.id,user.username]);
    io.to('chat:'+room).emit('chat-message',result.rows[0]);
    return {message:result.rows[0]};
  });

  socket.on("disconnect", () => {
    console.log(JSON.stringify({ kind: 'chat_safe', safe: 'socket_disconnected' }));
  });
});

const port = Number(process.env.PORT || 3000);

async function start() {
  await pool.query(require('fs').readFileSync(require('path').join(__dirname,'init.sql'),'utf8'));
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({ kind: 'chat_safe', safe: 'server_started' })));
}
start().catch(error=> {console.error('Startup failed:',error.message);pool.end();process.exitCode=1;});
