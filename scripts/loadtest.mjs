import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { io as connectSocket } from "socket.io-client";
import { createAptiQuizServer } from "../server/index.mjs";

const PLAYER_COUNT = 50;
const QUESTIONS_TO_PLAY = 5;
const dbPath = path.join(os.tmpdir(), `aptiquiz-load-${randomUUID()}.sqlite`);
const clients = [];
let server;

function eventOnce(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

function emitAck(socket, event, data, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.emit(event, data, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `HTTP ${response.status}`);
  return body;
}

try {
  server = await createAptiQuizServer({ dbPath, hostAccessCode: "load-test-host", questionSeconds: 20, maxPlayers: PLAYER_COUNT });
  const address = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetchJson(`${base}/api/host/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode: "load-test-host" }),
  });
  const setResponse = await fetchJson(`${base}/api/host/sets`, { headers: { authorization: `Bearer ${login.token}` } });
  const set = await fetchJson(`${base}/api/host/sets/${setResponse.sets[0].id}`, { headers: { authorization: `Bearer ${login.token}` } });
  const host = connectSocket(base, { auth: { hostToken: login.token }, transports: ["websocket"] });
  clients.push(host);
  await eventOnce(host, "connect");
  const roomResult = await emitAck(host, "room:create", { setId: set.set.id, college: "AptiQuiz Load Test College" });
  assert.equal(roomResult.ok, true, roomResult.error);
  const code = roomResult.lobby.code;

  const startedAt = Date.now();
  const playerJoins = Array.from({ length: PLAYER_COUNT }, async (_, index) => {
    const socket = connectSocket(base, { transports: ["websocket"] });
    clients.push(socket);
    await eventOnce(socket, "connect");
    const joined = await emitAck(socket, "room:join", {
      code,
      displayName: `Load Player ${String(index + 1).padStart(2, "0")}`,
      college: index % 2 ? "North College" : "South College",
    });
    assert.equal(joined.ok, true, joined.error);
    return socket;
  });
  const players = await Promise.all(playerJoins);
  const joinMs = Date.now() - startedAt;
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM players WHERE room_code = ?").get(code).n, PLAYER_COUNT);

  for (let questionIndex = 0; questionIndex < QUESTIONS_TO_PLAY; questionIndex++) {
    const questionPromises = players.map((socket) => eventOnce(socket, "game:question"));
    const hostQuestionPromise = eventOnce(host, "host:question");
    if (questionIndex === 0) await emitAck(host, "game:start", { code });
    else await emitAck(host, "game:next", { code });
    const [questions, hostQuestion] = await Promise.all([Promise.all(questionPromises), hostQuestionPromise]);
    assert.equal(hostQuestion.questionIndex, questionIndex);
    assert.ok(questions.every((q) => q.questionIndex === questionIndex));
    assert.equal(new Set(questions.map((q) => q.questionId)).size, 1, "all players should receive the same question");
    assert.equal(new Set(questions.map((q) => q.startedAt)).size, 1, "all players should share the server start time");
    assert.equal(new Set(questions.map((q) => q.endsAt)).size, 1, "all players should share the server deadline");
    assert.ok(questions.every((q) => !Object.hasOwn(q, "correctOptionId")));
    if (questionIndex === 0) {
      const orders = new Set(questions.map((q) => q.options.map((option) => option.id).join("")));
      assert.ok(orders.size > 1, "each player should receive an independently shuffled option order");
    }
    const leaderboardPromises = players.map((socket) => eventOnce(socket, "game:leaderboard"));
    const questionStarted = Date.now();
    await Promise.all(players.map((socket, i) => emitAck(socket, "answer:submit", {
      questionIndex,
      optionId: questions[i].options[i % questions[i].options.length].id,
    })));
    const boards = await Promise.all(leaderboardPromises);
    assert.ok(boards.every((board) => board.questionIndex === questionIndex));
    assert.ok(boards.every((board) => board.leaderboard.length === PLAYER_COUNT));
    console.log(`Round ${questionIndex + 1}: 50 players answered in ${Date.now() - questionStarted} ms`);
  }

  const finalPromises = players.map((socket) => eventOnce(socket, "game:final"));
  await emitAck(host, "game:next", { code });
  const finals = await Promise.all(finalPromises);
  assert.ok(finals.every((result) => result.players.length === PLAYER_COUNT));
  const league = await fetchJson(`${base}/api/league?days=30`);
  assert.equal(league.colleges.length, 1);
  assert.equal(league.colleges[0].college, "AptiQuiz Load Test College");
  console.log(JSON.stringify({
    result: "PASS",
    players: PLAYER_COUNT,
    questions: QUESTIONS_TO_PLAY,
    joinMs,
    totalMs: Date.now() - startedAt,
    finalRows: finals[0].players.length,
    collegeRows: league.colleges.length,
    database: "temporary file, removed after the run",
  }, null, 2));
} catch (error) {
  console.error("50-player load test failed:", error);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.disconnect();
  if (server) await server.close();
  for (const suffix of ["", "-shm", "-wal"]) await fs.rm(`${dbPath}${suffix}`, { force: true }).catch(() => {});
}
