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

app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || "postgres",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "chatdb",
  user: process.env.DB_USER || "chatuser",
  password: process.env.DB_PASSWORD
});

const sessionMiddleware = session({
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

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        error: "Mật khẩu phải dài từ 8 đến 72 ký tự."
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
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error.message);
      return res.status(500).json({
        error: "Đăng xuất thất bại."
      });
    }

    res.clearCookie("connect.sid");
    res.json({ message: "Đã đăng xuất." });
  });
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
  const user = socket.data.user;

  console.log("Client connected:", socket.id, user.username);

  socket.on("join-room", async (room) => {
    if (typeof room !== "string") return;

    room = room.trim();

    if (!room || room.length > 100) return;

    // Rời các phòng chat cũ trước khi vào phòng mới.
    for (const joinedRoom of socket.rooms) {
      if (joinedRoom !== socket.id) {
        socket.leave(joinedRoom);
      }
    }

    socket.join(room);

    try {
      const result = await pool.query(
        `SELECT id, room, message, username, created_at
         FROM messages
         WHERE room = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [room]
      );

      socket.emit("chat-history", result.rows.reverse());
    } catch (error) {
      console.error("Could not load chat history:", error.message);
      socket.emit("chat-error", "Không thể tải lịch sử tin nhắn.");
    }
  });

  socket.on("chat-message", async (data) => {
    try {
      if (
        !data ||
        typeof data.room !== "string" ||
        typeof data.message !== "string"
      ) {
        return;
      }

      const room = data.room.trim();
      const message = data.message.trim();

      if (
        !room ||
        room.length > 100 ||
        !message ||
        message.length > 2000 ||
        !socket.rooms.has(room)
      ) {
        return;
      }

      const result = await pool.query(
        `INSERT INTO messages (room, message, user_id, username)
         VALUES ($1, $2, $3, $4)
         RETURNING id, room, message, user_id, username, created_at`,
        [room, message, user.id, user.username]
      );

      io.to(room).emit("chat-message", result.rows[0]);
    } catch (error) {
      console.error("Could not save chat message:", error.message);
      socket.emit("chat-error", "Không thể lưu tin nhắn.");
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const port = Number(process.env.PORT || 3000);

server.listen(port, "0.0.0.0", () => {
  console.log(`Chat server listening on port ${port}`);
});
