import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { z } from "zod";
import {
  createPlayer,
  createAccount,
  createQuestionSet,
  createRoom,
  deleteQuestionSet,
  findPlayerByToken,
  getFinalResults,
  getAccountByEmail,
  getAccountByIdentifier,
  getAccountById,
  getCollegeLeague,
  getLiveArenaOverview,
  getRoomAnswerExport,
  getPlayers,
  getQuestionSet,
  getRoom,
  listQuestionSets,
  openDatabase,
  roomPlayerCount,
  seedDemoSet,
  setPlayerConnected,
  updateQuestionSet,
} from "./db.mjs";
import { GameController, median } from "./game.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SESSION_TTL = 12 * 60 * 60 * 1000;
const ACCOUNT_SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_PASSWORD_KEY_LENGTH = 64;
const hostQuestionSchema = z.object({
  prompt: z.string().trim().min(5).max(600),
  options: z.array(z.object({ id: z.string().min(1).max(20), text: z.string().trim().min(1).max(300) })).length(4),
  correctOptionId: z.string().min(1).max(20),
  topic: z.enum(["Quantitative", "Logical Reasoning", "Verbal", "Data Interpretation"]),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  imageUrl: z.union([z.string().url().max(1000), z.literal("")])
    .refine((url) => {
      if (!url) return true;
      try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
    }, { message: "Image URL must use HTTP or HTTPS." })
    .optional(),
  tableData: z.unknown().optional(),
})
  .refine((q) => q.options.some((o) => o.id === q.correctOptionId), { message: "Correct answer must match one of the options." })
  .refine((q) => new Set(q.options.map((option) => option.id)).size === q.options.length, { message: "Option IDs must be unique." });
const questionSetSchema = z.object({
  title: z.string().trim().min(2).max(100),
  questions: z.array(hostQuestionSchema).min(1).max(100),
});
const joinSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
  displayName: z.string().trim().min(1).max(28),
  college: z.string().trim().max(80).default(""),
  resumeToken: z.string().min(16).max(128).optional().nullable(),
});

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function errorText(error) {
  return error instanceof Error ? error.message : "Unexpected server error.";
}

export async function createAptiQuizServer(options = {}) {
  const db = options.db || openDatabase(options.dbPath);
  if (options.seed !== false) seedDemoSet(db);
  const hostAccessCode = options.hostAccessCode ?? process.env.HOST_ACCESS_CODE ?? "";
  const questionSeconds = Number(options.questionSeconds ?? process.env.QUESTION_SECONDS ?? 30);
  const maxPlayers = Math.min(50, Math.max(2, Number(options.maxPlayers ?? process.env.MAX_PLAYERS_PER_ROOM ?? 50)));
  const latencyGraceMs = 150;
  const hostSessions = new Map();
  const accountSessions = new Map();
  const playerSockets = new Map();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "300kb" }));
  app.use(express.static(path.join(APP_DIR, "public"), { extensions: ["html"] }));
  const server = http.createServer(app);
  const allowedOrigins = options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
    : process.env.NODE_ENV === "production" ? false : true);
  const io = new Server(server, {
    maxHttpBufferSize: 300_000,
    cors: { origin: allowedOrigins, credentials: false },
    pingInterval: 20_000,
    pingTimeout: 10_000,
  });
  const game = new GameController({ db, io, questionSeconds, latencyGraceMs, maxPlayers });

  function validHostToken(token) {
    if (typeof token !== "string") return false;
    const session = hostSessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      hostSessions.delete(token);
      return false;
    }
    return true;
  }

  function hostAuth(req, res, next) {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!validHostToken(token)) return res.status(401).json({ error: "Host sign-in required." });
    req.hostToken = token;
    next();
  }

  function accountAuth(req, res, next) {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    const session = typeof token === "string" ? accountSessions.get(token) : null;
    if (!session || session.expiresAt < Date.now()) {
      if (token) accountSessions.delete(token);
      return res.status(401).json({ error: "Sign in to your AptiQuiz account." });
    }
    const account = getAccountById(db, session.accountId);
    if (!account) {
      accountSessions.delete(token);
      return res.status(401).json({ error: "This account session is no longer valid." });
    }
    req.account = account;
    req.accountToken = token;
    next();
  }

  function issueAccountSession(account, res) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ACCOUNT_SESSION_TTL;
    accountSessions.set(token, { accountId: account.id, expiresAt });
    res.json({ token, expiresAt, account });
  }

  app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "aptiquiz", time: new Date().toISOString() }));
  app.get("/api/live", (_req, res) => res.json(getLiveArenaOverview(db)));
  app.get("/api/host/rooms/:code/export.csv", hostAuth, (req, res) => {
    const code = z.string().regex(/^\d{6}$/).safeParse(req.params.code);
    const room = code.success ? getRoom(db, code.data) : null;
    if (!room || !secureEqual(room.host_key_hash, digest(req.hostToken))) return res.status(404).json({ error: "Room not found." });
    const columns = ["questionNumber", "question", "topic", "difficulty", "player", "roomCollege", "playerCollege", "selectedAnswer", "correctAnswer", "isCorrect", "responseMs", "points"];
    const escapeCsv = (value) => {
      const text = String(value ?? "");
      const safeText = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
      return `"${safeText.replace(/"/g, '""')}"`;
    };
    const rows = getRoomAnswerExport(db, code.data);
    const csv = [columns.map(escapeCsv).join(","), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))].join("\r\n");
    res.type("text/csv").set("content-disposition", `attachment; filename="aptiquiz-${code.data}-results.csv"`).send(csv);
  });
  app.post("/api/account/signup", (req, res) => {
    const parsed = z.object({
      displayName: z.string().trim().min(1).max(28),
      username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_.-]+$/, "Username can use letters, numbers, dots, underscores, and hyphens."),
      email: z.string().trim().email().max(254),
      college: z.string().trim().max(80).default(""),
      password: z.string().min(8).max(200),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Check the sign-up details." });
    const email = parsed.data.email.toLowerCase();
    if (getAccountByEmail(db, email)) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
    if (getAccountByIdentifier(db, parsed.data.username)) return res.status(409).json({ error: "That username is already taken. Choose another one." });
    const passwordSalt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(parsed.data.password, passwordSalt, ACCOUNT_PASSWORD_KEY_LENGTH).toString("hex");
    const account = createAccount(db, { ...parsed.data, email, passwordSalt, passwordHash });
    issueAccountSession(account, res);
  });
  app.post("/api/account/login", (req, res) => {
    const parsed = z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your email or username and password." });
    const stored = getAccountByIdentifier(db, parsed.data.identifier);
    const attemptedHash = crypto.scryptSync(parsed.data.password, stored?.password_salt || "aptiquiz-invalid-account", ACCOUNT_PASSWORD_KEY_LENGTH);
    const storedHash = Buffer.from(stored?.password_hash || "0".repeat(ACCOUNT_PASSWORD_KEY_LENGTH * 2), "hex");
    if (!stored || storedHash.length !== attemptedHash.length || !crypto.timingSafeEqual(attemptedHash, storedHash)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    issueAccountSession(getAccountById(db, stored.id), res);
  });
  app.get("/api/account/me", accountAuth, (req, res) => res.json({ account: req.account }));
  app.post("/api/account/logout", accountAuth, (req, res) => {
    accountSessions.delete(req.accountToken);
    res.status(204).end();
  });
  app.post("/api/host/session", (req, res) => {
    const body = z.object({ accessCode: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Enter the host access code." });
    if (!hostAccessCode) return res.status(503).json({ error: "Host access is not configured. Set HOST_ACCESS_CODE and restart the server." });
    if (!secureEqual(body.data.accessCode, hostAccessCode)) return res.status(401).json({ error: "That host access code is not correct." });
    const token = crypto.randomBytes(32).toString("base64url");
    hostSessions.set(token, { expiresAt: Date.now() + HOST_SESSION_TTL });
    res.json({ token, expiresAt: Date.now() + HOST_SESSION_TTL });
  });
  app.get("/api/host/sets", hostAuth, (_req, res) => res.json({ sets: listQuestionSets(db) }));
  app.get("/api/host/sets/:id", hostAuth, (req, res) => {
    const set = getQuestionSet(db, req.params.id);
    if (!set) return res.status(404).json({ error: "Question set not found." });
    res.json({ set });
  });
  app.post("/api/host/sets", hostAuth, (req, res) => {
    const parsed = questionSetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid question set." });
    const set = createQuestionSet(db, parsed.data);
    res.status(201).json({ set });
  });
  app.put("/api/host/sets/:id", hostAuth, (req, res) => {
    const parsed = questionSetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid question set." });
    try {
      const set = updateQuestionSet(db, req.params.id, parsed.data);
      if (!set) return res.status(404).json({ error: "Question set not found." });
      res.json({ set });
    } catch (error) {
      if (error?.code === "SET_IN_USE") return res.status(409).json({ error: error.message });
      throw error;
    }
  });
  app.delete("/api/host/sets/:id", hostAuth, (req, res) => {
    try {
      if (!deleteQuestionSet(db, req.params.id)) return res.status(404).json({ error: "Question set not found." });
      res.status(204).end();
    } catch {
      res.status(409).json({ error: "This question set is used by a room and cannot be deleted." });
    }
  });
  app.get("/api/league", (_req, res) => {
    const period = String(_req.query.period || "");
    const daysValue = Number.parseInt(String(_req.query.days ?? "30"), 10);
    const days = period === "all" ? null : period === "week" ? 7 : Number.isFinite(daysValue) ? Math.min(365, Math.max(1, daysValue)) : 30;
    res.json(getCollegeLeague(db, days));
  });
  app.use((error, _req, res, _next) => {
    console.error("HTTP request failed:", errorText(error));
    res.status(500).json({ error: "The server could not complete that request." });
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.hostToken;
    if (validHostToken(token)) {
      socket.data.role = "host";
      socket.data.hostToken = token;
    } else {
      socket.data.role = "guest";
    }
    socket.data.pendingPings = new Map();
    socket.data.rttSamples = [];
    next();
  });

  function ackError(ack, message, code = "bad-request") {
    if (typeof ack === "function") ack({ ok: false, error: message, code });
  }

  function hostOwnsRoom(socket, roomCode) {
    const room = getRoom(db, roomCode);
    if (!room || socket.data.role !== "host" || !validHostToken(socket.data.hostToken)) return false;
    return secureEqual(room.host_key_hash, digest(socket.data.hostToken));
  }

  function makeRoomCode() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = String(crypto.randomInt(100_000, 1_000_000));
      if (!getRoom(db, code)) return code;
    }
    throw new Error("Could not create a room code. Try again.");
  }

  io.on("connection", (socket) => {
    const sendPing = () => {
      if (!socket.connected) return;
      const nonce = crypto.randomBytes(8).toString("hex");
      socket.data.pendingPings.set(nonce, Date.now());
      socket.emit("server:ping", { nonce });
    };
    sendPing();
    const pingTimer = setInterval(sendPing, 5_000);
    pingTimer.unref?.();

    socket.on("client:pong", (raw) => {
      const parsed = z.object({ nonce: z.string().max(64) }).safeParse(raw);
      if (!parsed.success) return;
      const sentAt = socket.data.pendingPings.get(parsed.data.nonce);
      if (!sentAt) return;
      socket.data.pendingPings.delete(parsed.data.nonce);
      const rtt = Date.now() - sentAt;
      if (rtt >= 0 && rtt < 5_000) {
        socket.data.rttSamples.push(rtt);
        socket.data.rttSamples = socket.data.rttSamples.slice(-9);
      }
    });

    socket.on("room:create", async (raw, ack) => {
      if (socket.data.role !== "host" || !validHostToken(socket.data.hostToken)) return ackError(ack, "Sign in as host before creating a room.", "unauthorized");
      const parsed = z.object({ setId: z.string().uuid(), college: z.string().trim().max(80).default("") }).safeParse(raw);
      if (!parsed.success) return ackError(ack, "Choose a valid question set.");
      const set = getQuestionSet(db, parsed.data.setId);
      if (!set?.questions.length) return ackError(ack, "This question set has no questions.");
      try {
        const code = makeRoomCode();
        createRoom(db, { code, setId: set.id, hostKeyHash: digest(socket.data.hostToken), college: parsed.data.college });
        if (socket.data.roomCode && socket.data.roomCode !== code) await socket.leave(socket.data.roomCode);
        socket.data.roomCode = code;
        await socket.join(code);
        const lobby = game.lobby(code);
        socket.emit("room:lobby", lobby);
        if (typeof ack === "function") ack({ ok: true, lobby });
      } catch (error) {
        ackError(ack, errorText(error));
      }
    });

    socket.on("host:resume", async (raw, ack) => {
      const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(raw);
      if (!parsed.success || !hostOwnsRoom(socket, parsed.data.code)) return ackError(ack, "This host session cannot reopen that room.", "unauthorized");
      socket.data.role = "host";
      socket.data.roomCode = parsed.data.code;
      await socket.join(parsed.data.code);
      const lobby = game.lobby(parsed.data.code);
      if (typeof ack === "function") ack({ ok: true, lobby });
      socket.emit("room:lobby", lobby);
      const room = getRoom(db, parsed.data.code);
      if (room.status === "active") {
        const set = getQuestionSet(db, room.set_id);
        const q = set.questions[room.current_index];
        socket.emit("host:question", { questionId: q.id, prompt: q.prompt, topic: q.topic, difficulty: q.difficulty,
          questionIndex: room.current_index, totalQuestions: set.questions.length, startedAt: room.started_at,
          endsAt: room.ends_at, serverNow: Date.now() });
      } else if (room.status === "leaderboard") {
        socket.emit("game:leaderboard", game.leaderboardPayload(parsed.data.code, room.current_index));
      } else if (room.status === "ended") {
        socket.emit("game:final", getFinalResults(db, parsed.data.code));
      }
    });

    socket.on("room:join", async (raw, ack) => {
      const parsed = joinSchema.safeParse(raw);
      if (!parsed.success) return ackError(ack, "Enter a valid room code and display name.");
      const { code, displayName, college, resumeToken } = parsed.data;
      const room = getRoom(db, code);
      if (!room) return ackError(ack, "Room not found. Check the code and try again.", "not-found");
      let player = resumeToken ? findPlayerByToken(db, code, resumeToken) : null;
      if (!player && room.status !== "lobby") return ackError(ack, "This game has started. New players cannot join now.", "started");
      if (!player && roomPlayerCount(db, code) >= maxPlayers) return ackError(ack, `This room is full (${maxPlayers} players).`, "full");
      let newToken = resumeToken;
      if (!player) {
        newToken = crypto.randomBytes(32).toString("base64url");
        player = createPlayer(db, { roomCode: code, displayName, college, resumeToken: newToken });
      } else {
        setPlayerConnected(db, player.id, true);
      }
      socket.data.role = "player";
      socket.data.roomCode = code;
      socket.data.playerId = player.id;
      socket.join(code);
      if (!playerSockets.has(player.id)) playerSockets.set(player.id, new Set());
      playerSockets.get(player.id).add(socket.id);
      const lobby = game.lobby(code);
      if (typeof ack === "function") ack({ ok: true, playerId: player.id, resumeToken: newToken, lobby });
      io.to(code).emit("room:lobby", lobby);
      await game.sendCurrentState(socket, code, player.id);
    });

    socket.on("game:start", async (raw, ack) => {
      const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(raw);
      if (!parsed.success || !hostOwnsRoom(socket, parsed.data.code) || socket.data.roomCode !== parsed.data.code) return ackError(ack, "Host access is required to start this game.", "unauthorized");
      try {
        await game.start(parsed.data.code);
        if (typeof ack === "function") ack({ ok: true });
      } catch (error) {
        ackError(ack, errorText(error));
      }
    });

    socket.on("game:next", async (raw, ack) => {
      const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(raw);
      if (!parsed.success || !hostOwnsRoom(socket, parsed.data.code) || socket.data.roomCode !== parsed.data.code) return ackError(ack, "Host access is required to advance the game.", "unauthorized");
      try {
        await game.next(parsed.data.code);
        if (typeof ack === "function") ack({ ok: true });
      } catch (error) {
        ackError(ack, errorText(error));
      }
    });

    socket.on("game:end", (raw, ack) => {
      const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(raw);
      if (!parsed.success || !hostOwnsRoom(socket, parsed.data.code) || socket.data.roomCode !== parsed.data.code) {
        return ackError(ack, "Host access is required to end this game.", "unauthorized");
      }
      const room = getRoom(db, parsed.data.code);
      if (room.status !== "active" && room.status !== "leaderboard") return ackError(ack, "This quiz is not in progress.");
      game.finish(parsed.data.code);
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("answer:submit", (raw, ack) => {
      const parsed = z.object({ questionIndex: z.number().int().min(0).max(99), optionId: z.string().min(1).max(20) }).safeParse(raw);
      if (!parsed.success || socket.data.role !== "player" || !socket.data.playerId || !socket.data.roomCode) {
        return ackError(ack, "Join a room before answering.", "unauthorized");
      }
      const result = game.submit({
        roomCode: socket.data.roomCode,
        playerId: socket.data.playerId,
        questionIndex: parsed.data.questionIndex,
        optionId: parsed.data.optionId,
        receivedAt: Date.now(),
        latencyRttMs: median(socket.data.rttSamples),
      });
      if (typeof ack === "function") ack({ ok: result.accepted, ...result });
      if (!result.accepted) socket.emit("answer:rejected", { reason: result.reason });
      else socket.emit("answer:received", { scoreDelta: result.scoreDelta });
    });

    socket.on("disconnect", () => {
      clearInterval(pingTimer);
      if (socket.data.playerId) {
        const sockets = playerSockets.get(socket.data.playerId);
        sockets?.delete(socket.id);
        if (!sockets?.size) {
          playerSockets.delete(socket.data.playerId);
          setPlayerConnected(db, socket.data.playerId, false);
        }
        const code = socket.data.roomCode;
        if (code && getRoom(db, code)) io.to(code).emit("room:lobby", game.lobby(code));
      }
    });
  });

  app.get("*path", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) return next();
    res.sendFile(path.join(APP_DIR, "public", "index.html"));
  });

  return {
    app,
    server,
    io,
    db,
    game,
    hostSessions,
    async listen(port = Number(process.env.PORT || 3000), host = "127.0.0.1") {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      game.cleanup();
      await new Promise((resolve) => io.close(() => resolve()));
      db.close();
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const app = await createAptiQuizServer();
  const address = await app.listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0");
  console.log(`AptiQuiz listening on http://${address.address}:${address.port}`);
}
