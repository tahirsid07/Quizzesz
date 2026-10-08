import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function openDatabase(dbPath = process.env.DB_PATH || "./data/aptiquiz.sqlite") {
  const resolved = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
  if (resolved !== ":memory:") fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS question_sets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT,
      display_name TEXT NOT NULL,
      college TEXT NOT NULL DEFAULT '',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL,
      correct_option_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      image_url TEXT,
      table_data_json TEXT,
      sort_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS questions_set_order_idx ON questions(set_id, sort_order);
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES question_sets(id),
      host_key_hash TEXT NOT NULL,
      college TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'lobby',
      current_index INTEGER NOT NULL DEFAULT -1,
      started_at INTEGER,
      ends_at INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_created_idx ON rooms(created_at);
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      college TEXT NOT NULL DEFAULT '',
      resume_token TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      total_answered INTEGER NOT NULL DEFAULT 0,
      total_response_ms INTEGER NOT NULL DEFAULT 0,
      connected INTEGER NOT NULL DEFAULT 1,
      joined_at TEXT NOT NULL,
      last_active TEXT NOT NULL,
      UNIQUE(room_code, resume_token)
    );
    CREATE INDEX IF NOT EXISTS players_room_score_idx ON players(room_code, score DESC, total_response_ms ASC);
    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES questions(id),
      question_index INTEGER NOT NULL,
      selected_option_id TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      response_ms INTEGER NOT NULL,
      score_delta INTEGER NOT NULL,
      answered_at INTEGER NOT NULL,
      UNIQUE(room_code, player_id, question_index)
    );
    CREATE INDEX IF NOT EXISTS answers_room_round_idx ON answers(room_code, question_index);
    CREATE INDEX IF NOT EXISTS answers_player_idx ON answers(player_id);
  `);
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all();
  if (!accountColumns.some((column) => column.name === "username")) db.exec("ALTER TABLE accounts ADD COLUMN username TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_idx ON accounts(username COLLATE NOCASE) WHERE username IS NOT NULL");
  const roomColumns = db.prepare("PRAGMA table_info(rooms)").all();
  if (!roomColumns.some((column) => column.name === "college")) db.exec("ALTER TABLE rooms ADD COLUMN college TEXT NOT NULL DEFAULT ''");
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function runInTransaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function decodeQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    setId: row.set_id,
    prompt: row.prompt,
    options: JSON.parse(row.options_json),
    correctOptionId: row.correct_option_id,
    topic: row.topic,
    difficulty: row.difficulty,
    imageUrl: row.image_url || "",
    tableData: row.table_data_json ? JSON.parse(row.table_data_json) : null,
    sortOrder: row.sort_order,
  };
}

export function listQuestionSets(db) {
  return db.prepare(`
    SELECT s.id, s.title, s.created_at,
      (SELECT COUNT(*) FROM questions q WHERE q.set_id = s.id) AS question_count
    FROM question_sets s ORDER BY s.created_at DESC
  `).all();
}

export function createAccount(db, { email, username, displayName, college, passwordSalt, passwordHash }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO accounts(id, email, username, display_name, college, password_salt, password_hash, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(id, email, username.toLowerCase(), displayName.trim(), college.trim(), passwordSalt, passwordHash, nowIso());
  return getAccountById(db, id);
}

export function getAccountByEmail(db, email) {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) || null;
}

export function getAccountByIdentifier(db, identifier) {
  return db.prepare("SELECT * FROM accounts WHERE email = ? OR username = ? COLLATE NOCASE")
    .get(identifier.toLowerCase(), identifier) || null;
}

export function getAccountById(db, id) {
  const account = db.prepare("SELECT id, email, username, display_name AS displayName, college FROM accounts WHERE id = ?").get(id);
  return account || null;
}

export function getQuestionSet(db, setId) {
  const set = db.prepare("SELECT id, title, created_at FROM question_sets WHERE id = ?").get(setId);
  if (!set) return null;
  const questions = db.prepare("SELECT * FROM questions WHERE set_id = ? ORDER BY sort_order ASC").all(setId).map(decodeQuestion);
  return { ...set, questions };
}

export function createQuestionSet(db, { title, questions }) {
  const id = randomUUID();
  const insertSet = db.prepare("INSERT INTO question_sets(id, title, created_at) VALUES(?, ?, ?)");
  const insertQuestion = db.prepare(`
    INSERT INTO questions(id, set_id, prompt, options_json, correct_option_id, topic, difficulty, image_url, table_data_json, sort_order)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  runInTransaction(db, () => {
    insertSet.run(id, title.trim(), nowIso());
    questions.forEach((q, index) => insertQuestion.run(
      randomUUID(), id, q.prompt.trim(), JSON.stringify(q.options), q.correctOptionId,
      q.topic, q.difficulty, q.imageUrl || null, q.tableData ? JSON.stringify(q.tableData) : null, index,
    ));
  });
  return getQuestionSet(db, id);
}

export function updateQuestionSet(db, setId, { title, questions }) {
  const set = db.prepare("SELECT id FROM question_sets WHERE id = ?").get(setId);
  if (!set) return null;
  if (db.prepare("SELECT 1 FROM rooms WHERE set_id = ? LIMIT 1").get(setId)) {
    const error = new Error("This set is attached to a room. Duplicate it to make changes without changing past results.");
    error.code = "SET_IN_USE";
    throw error;
  }
  const insertQuestion = db.prepare(`
    INSERT INTO questions(id, set_id, prompt, options_json, correct_option_id, topic, difficulty, image_url, table_data_json, sort_order)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  runInTransaction(db, () => {
    db.prepare("UPDATE question_sets SET title = ? WHERE id = ?").run(title.trim(), setId);
    db.prepare("DELETE FROM questions WHERE set_id = ?").run(setId);
    questions.forEach((q, index) => insertQuestion.run(
      randomUUID(), setId, q.prompt.trim(), JSON.stringify(q.options), q.correctOptionId,
      q.topic, q.difficulty, q.imageUrl || null, q.tableData ? JSON.stringify(q.tableData) : null, index,
    ));
  });
  return getQuestionSet(db, setId);
}

export function deleteQuestionSet(db, setId) {
  return db.prepare("DELETE FROM question_sets WHERE id = ?").run(setId).changes > 0;
}

export function seedDemoSet(db) {
  if (db.prepare("SELECT 1 FROM question_sets LIMIT 1").get()) return;
  createQuestionSet(db, {
    title: "Campus Aptitude Sprint",
    questions: [
      {
        prompt: "A test has 240 questions. A student completes 15% of them. How many questions is that?",
        options: [{ id: "a", text: "24" }, { id: "b", text: "36" }, { id: "c", text: "42" }, { id: "d", text: "48" }],
        correctOptionId: "b", topic: "Quantitative", difficulty: "Easy",
      },
      {
        prompt: "What number comes next: 2, 6, 12, 20, __?",
        options: [{ id: "a", text: "28" }, { id: "b", text: "30" }, { id: "c", text: "32" }, { id: "d", text: "36" }],
        correctOptionId: "b", topic: "Logical Reasoning", difficulty: "Medium",
      },
      {
        prompt: "Choose the word closest in meaning to ‘rapid’. ",
        options: [{ id: "a", text: "Swift" }, { id: "b", text: "Careful" }, { id: "c", text: "Distant" }, { id: "d", text: "Quiet" }],
        correctOptionId: "a", topic: "Verbal", difficulty: "Easy",
      },
      {
        prompt: "A team shipped 40 units in January and 50 in February. By what percentage did output rise?",
        options: [{ id: "a", text: "10%" }, { id: "b", text: "20%" }, { id: "c", text: "25%" }, { id: "d", text: "40%" }],
        correctOptionId: "c", topic: "Data Interpretation", difficulty: "Medium",
        tableData: { columns: ["Month", "Units shipped"], rows: [["January", 40], ["February", 50]] },
      },
      {
        prompt: "The ratio of red to blue pens is 3:5. There are 64 pens in total. How many are red?",
        options: [{ id: "a", text: "18" }, { id: "b", text: "24" }, { id: "c", text: "32" }, { id: "d", text: "40" }],
        correctOptionId: "b", topic: "Quantitative", difficulty: "Medium",
      },
    ],
  });
}

export function createRoom(db, { code, setId, hostKeyHash, college = "" }) {
  db.prepare(`INSERT INTO rooms(code, set_id, host_key_hash, college, status, created_at)
    VALUES(?, ?, ?, ?, 'lobby', ?)`)
    .run(code, setId, hostKeyHash, college.trim(), nowIso());
  return getRoom(db, code);
}

export function getRoom(db, code) {
  return db.prepare("SELECT * FROM rooms WHERE code = ?").get(code) || null;
}

export function updateRoomState(db, code, state) {
  db.prepare("UPDATE rooms SET status = ?, current_index = ?, started_at = ?, ends_at = ? WHERE code = ?")
    .run(state.status, state.currentIndex, state.startedAt ?? null, state.endsAt ?? null, code);
}

export function findPlayerByToken(db, roomCode, resumeToken) {
  return db.prepare("SELECT * FROM players WHERE room_code = ? AND resume_token = ?")
    .get(roomCode, resumeToken) || null;
}

export function createPlayer(db, { roomCode, displayName, college, resumeToken }) {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO players(id, room_code, display_name, college, resume_token, joined_at, last_active)
    VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(id, roomCode, displayName.trim(), college.trim(), resumeToken, now, now);
  return db.prepare("SELECT * FROM players WHERE id = ?").get(id);
}

export function setPlayerConnected(db, playerId, connected) {
  db.prepare("UPDATE players SET connected = ?, last_active = ? WHERE id = ?")
    .run(connected ? 1 : 0, nowIso(), playerId);
}

export function getPlayers(db, roomCode) {
  return db.prepare(`SELECT id, display_name AS displayName, college, score, connected, joined_at AS joinedAt
    FROM players WHERE room_code = ? ORDER BY joined_at ASC`).all(roomCode);
}

export function roomPlayerCount(db, roomCode) {
  return db.prepare("SELECT COUNT(*) AS n FROM players WHERE room_code = ?").get(roomCode).n;
}

export function recordAnswer(db, answer) {
  const insert = db.prepare(`INSERT INTO answers(id, room_code, player_id, question_id, question_index, selected_option_id,
    is_correct, response_ms, score_delta, answered_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE players SET score = score + ?, correct_count = correct_count + ?,
    total_answered = total_answered + 1, total_response_ms = total_response_ms + ?, last_active = ?
    WHERE id = ?`);
  try {
    runInTransaction(db, () => {
    insert.run(randomUUID(), answer.roomCode, answer.playerId, answer.questionId, answer.questionIndex,
      answer.selectedOptionId, answer.isCorrect ? 1 : 0, answer.responseMs, answer.scoreDelta, answer.receivedAt);
    update.run(answer.scoreDelta, answer.isCorrect ? 1 : 0, answer.responseMs, nowIso(), answer.playerId);
    });
    return { accepted: true };
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed: answers.room_code, answers.player_id, answers.question_index")) {
      return { accepted: false, reason: "duplicate" };
    }
    throw error;
  }
}

export function hasAnswered(db, roomCode, playerId, questionIndex) {
  return Boolean(db.prepare("SELECT 1 FROM answers WHERE room_code = ? AND player_id = ? AND question_index = ?")
    .get(roomCode, playerId, questionIndex));
}

export function getLeaderboard(db, roomCode) {
  return db.prepare(`SELECT id AS playerId, display_name AS name, college, score, correct_count AS correct,
    total_answered AS answered, CASE WHEN total_answered = 0 THEN 0 ELSE ROUND(correct_count * 100.0 / total_answered) END AS accuracy,
    CASE WHEN total_answered = 0 THEN 0 ELSE ROUND(total_response_ms * 1.0 / total_answered) END AS avgResponseMs
    FROM players WHERE room_code = ? ORDER BY score DESC, total_response_ms ASC, joined_at ASC`).all(roomCode);
}

export function getRoundAnswers(db, roomCode, questionIndex) {
  return db.prepare(`SELECT p.id AS playerId, p.display_name AS name, a.selected_option_id AS selectedOptionId,
    a.is_correct AS isCorrect, a.response_ms AS responseMs, a.score_delta AS scoreDelta
    FROM answers a JOIN players p ON p.id = a.player_id
    WHERE a.room_code = ? AND a.question_index = ?`).all(roomCode, questionIndex).map((row) => ({
    ...row,
    isCorrect: Boolean(row.isCorrect),
  }));
}

export function getFinalResults(db, roomCode) {
  const room = getRoom(db, roomCode);
  const questionCount = room ? db.prepare("SELECT COUNT(*) AS n FROM questions WHERE set_id = ?").get(room.set_id).n : 0;
  const streaks = new Map();
  const answerRows = db.prepare(`SELECT player_id AS playerId, question_index AS questionIndex, is_correct AS isCorrect FROM answers
    WHERE room_code = ? ORDER BY player_id, question_index`).all(roomCode);
  let currentPlayerId = "";
  let currentStreak = 0;
  let previousQuestionIndex = -1;
  for (const answer of answerRows) {
    if (answer.playerId !== currentPlayerId) {
      currentPlayerId = answer.playerId;
      currentStreak = 0;
    }
    if (answer.questionIndex !== previousQuestionIndex + 1) currentStreak = 0;
    currentStreak = answer.isCorrect ? currentStreak + 1 : 0;
    streaks.set(answer.playerId, Math.max(streaks.get(answer.playerId) || 0, currentStreak));
    previousQuestionIndex = answer.questionIndex;
  }
  const players = getLeaderboard(db, roomCode).map((player) => ({
    ...player,
    incorrect: player.answered - player.correct,
    timeouts: Math.max(0, questionCount - player.answered),
    longestCorrectStreak: streaks.get(player.playerId) || 0,
  }));
  const topics = db.prepare(`SELECT q.topic AS topic, COUNT(a.id) AS answered,
    SUM(a.is_correct) AS correct, CASE WHEN COUNT(a.id) = 0 THEN 0 ELSE ROUND(SUM(a.is_correct) * 100.0 / COUNT(a.id)) END AS accuracy
    FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.room_code = ? GROUP BY q.topic ORDER BY q.topic`).all(roomCode);
  return { players, topics, totalQuestions: questionCount };
}

export function getCollegeLeague(db, days = 30) {
  const since = Number.isFinite(days) ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;
  const filter = since ? "WHERE r.created_at >= ?" : "";
  const params = since ? [since] : [];
  const colleges = db.prepare(`SELECT COALESCE(NULLIF(r.college, ''), 'Unaffiliated') AS college,
      SUM(p.score) AS score, COUNT(DISTINCT p.room_code) AS rooms, COUNT(*) AS players,
      CASE WHEN SUM(p.total_answered) = 0 THEN 0 ELSE ROUND(SUM(p.correct_count) * 100.0 / SUM(p.total_answered)) END AS accuracy
    FROM players p JOIN rooms r ON r.code = p.room_code ${filter}
    GROUP BY COALESCE(NULLIF(r.college, ''), 'Unaffiliated') ORDER BY score DESC, college ASC LIMIT 20`).all(...params);
  const players = db.prepare(`SELECT p.display_name AS name,
      COALESCE(NULLIF(p.college, ''), 'Unaffiliated') AS college, SUM(p.score) AS score,
      COUNT(DISTINCT p.room_code) AS rooms
    FROM players p JOIN rooms r ON r.code = p.room_code ${filter}
    GROUP BY p.display_name, COALESCE(NULLIF(p.college, ''), 'Unaffiliated')
    ORDER BY score DESC, name ASC LIMIT 20`).all(...params);
  const topPlayersByCollege = db.prepare(`WITH player_totals AS (
      SELECT p.display_name AS name, COALESCE(NULLIF(r.college, ''), 'Unaffiliated') AS college,
        SUM(p.score) AS score, COUNT(DISTINCT p.room_code) AS rooms
      FROM players p JOIN rooms r ON r.code = p.room_code ${filter}
      GROUP BY p.display_name, COALESCE(NULLIF(r.college, ''), 'Unaffiliated')
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY college ORDER BY score DESC, name ASC) AS college_rank
      FROM player_totals
    ) SELECT name, college, score, rooms FROM ranked WHERE college_rank = 1 ORDER BY score DESC, college ASC`).all(...params);
  return { days: days ?? "all", colleges, players, topPlayersByCollege };
}

export function getRoomAnswerExport(db, roomCode) {
  return db.prepare(`SELECT a.question_index AS questionNumber, q.prompt AS question, q.topic, q.difficulty,
      p.display_name AS player, r.college AS roomCollege, p.college AS playerCollege, a.selected_option_id AS selectedOptionId,
      json_extract(selected.value, '$.text') AS selectedAnswer, json_extract(correct.value, '$.text') AS correctAnswer, a.is_correct AS isCorrect,
      a.response_ms AS responseMs, a.score_delta AS points
    FROM answers a
    JOIN players p ON p.id = a.player_id
    JOIN rooms r ON r.code = a.room_code
    JOIN questions q ON q.id = a.question_id
    JOIN json_each(q.options_json) selected ON json_extract(selected.value, '$.id') = a.selected_option_id
    JOIN json_each(q.options_json) correct ON json_extract(correct.value, '$.id') = q.correct_option_id
    WHERE a.room_code = ?
    ORDER BY a.question_index, p.display_name`).all(roomCode).map((row) => ({ ...row, isCorrect: Boolean(row.isCorrect) }));
}

export function getLiveArenaOverview(db) {
  return db.prepare(`SELECT COUNT(DISTINCT r.code) AS rooms,
      COUNT(p.id) AS players
    FROM rooms r LEFT JOIN players p ON p.room_code = r.code AND p.connected = 1
    WHERE r.status IN ('lobby', 'active')`).get();
}
