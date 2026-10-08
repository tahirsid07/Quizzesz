import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { io as connectSocket } from "socket.io-client";
import { createAptiQuizServer } from "../server/index.mjs";

const running = [];
const clients = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const instance of running.splice(0)) await instance.close();
});

async function boot(options = {}) {
  const instance = await createAptiQuizServer({ dbPath: ":memory:", hostAccessCode: "test-host-code", questionSeconds: 15, ...options });
  const address = await instance.listen(0, "127.0.0.1");
  running.push(instance);
  return { instance, base: `http://127.0.0.1:${address.port}` };
}

function eventOnce(socket, event, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timeout); resolve(data); });
  });
}

function eventMatching(socket, event, predicate, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for matching ${event}`));
    }, timeoutMs);
    const onEvent = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timeout);
      socket.off(event, onEvent);
      resolve(data);
    };
    socket.on(event, onEvent);
  });
}

function emitAck(socket, event, data, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement`)), timeoutMs);
    socket.emit(event, data, (result) => { clearTimeout(timeout); resolve(result); });
  });
}

async function loginHost(base) {
  const response = await fetch(`${base}/api/host/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode: "test-host-code" }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const socket = connectSocket(base, { auth: { hostToken: token }, transports: ["websocket"] });
  clients.push(socket);
  await eventOnce(socket, "connect");
  return { socket, token };
}

async function playerSocket(base, name, code, resumeToken) {
  const socket = connectSocket(base, { transports: ["websocket"] });
  clients.push(socket);
  await eventOnce(socket, "connect");
  const result = await emitAck(socket, "room:join", { code, displayName: name, college: "Test College", resumeToken });
  return { socket, result };
}

test("host sign-in protects question authoring", async () => {
  const { base } = await boot();
  const denied = await fetch(`${base}/api/host/sets`);
  assert.equal(denied.status, 401);
  const { token } = await loginHost(base);
  const allowed = await fetch(`${base}/api/host/sets`, { headers: { authorization: `Bearer ${token}` } });
  const payload = await allowed.json();
  assert.equal(allowed.status, 200);
  assert.ok(payload.sets.length >= 1);
  assert.equal(payload.sets[0].title, "Campus Aptitude Sprint");
});

test("account sign-up, login, profile, and logout work without exposing password hashes", async () => {
  const { base } = await boot();
  const signup = await fetch(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Mina", username: "Mina7", email: "MINA@example.com", college: "Lloyd", password: "secure-pass-123" }),
  });
  assert.equal(signup.status, 200);
  const created = await signup.json();
  assert.equal(created.account.email, "mina@example.com");
  assert.equal(created.account.username, "mina7");
  assert.equal(created.account.displayName, "Mina");
  assert.equal(Object.hasOwn(created.account, "password_hash"), false);

  const duplicate = await fetch(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Mina", username: "Mina8", email: "mina@example.com", password: "secure-pass-123" }),
  });
  assert.equal(duplicate.status, 409);

  const duplicateUsername = await fetch(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Other", username: "MINA7", email: "other@example.com", password: "secure-pass-456" }),
  });
  assert.equal(duplicateUsername.status, 409);

  const badLogin = await fetch(`${base}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "mina@example.com", password: "wrong-password" }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${base}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "MINA7", password: "secure-pass-123" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const profile = await fetch(`${base}/api/account/me`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).account.college, "Lloyd");

  const emailLogin = await fetch(`${base}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "mina@example.com", password: "secure-pass-123" }),
  });
  assert.equal(emailLogin.status, 200);

  const logout = await fetch(`${base}/api/account/logout`, { method: "POST", headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(logout.status, 204);
  const expiredProfile = await fetch(`${base}/api/account/me`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(expiredProfile.status, 401);
});

test("live arena overview counts open rooms and connected players", async () => {
  const { base } = await boot({ maxPlayers: 2 });
  const { socket: host, token } = await loginHost(base);
  const headers = { authorization: `Bearer ${token}` };
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers })).json()).sets;
  const room = await emitAck(host, "room:create", { setId: sets[0].id, college: "Lloyd Host College" });
  assert.equal(room.lobby.maxPlayers, 2);
  await playerSocket(base, "Overview Player", room.lobby.code);

  const response = await fetch(`${base}/api/live`);
  const overview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(overview.rooms, 1);
  assert.equal(overview.players, 1);

  const weekly = await (await fetch(`${base}/api/league?period=week`)).json();
  const allTime = await (await fetch(`${base}/api/league?period=all`)).json();
  assert.equal(weekly.days, 7);
  assert.equal(weekly.colleges[0].accuracy, 0);
  assert.equal(weekly.colleges[0].college, "Lloyd Host College");
  assert.equal(allTime.days, "all");
  assert.equal(allTime.colleges[0].college, "Lloyd Host College");
  assert.equal(allTime.topPlayersByCollege[0].name, "Overview Player");
});

test("question authoring rejects duplicate option identifiers", async () => {
  const { base } = await boot();
  const { token } = await loginHost(base);
  const headers = { authorization: `Bearer ${token}` };
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers })).json()).sets;
  const original = (await (await fetch(`${base}/api/host/sets/${sets[0].id}`, { headers })).json()).set;
  const questions = structuredClone(original.questions);
  questions[0].options[2].id = questions[0].options[0].id;
  const response = await fetch(`${base}/api/host/sets`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "Invalid duplicate IDs", questions }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /unique/i);
});

test("server keeps score authoritative and reveals the answer after the round", async () => {
  const { base } = await boot({ maxPlayers: 2 });
  const { socket: host, token } = await loginHost(base);
  const setsResponse = await fetch(`${base}/api/host/sets`, { headers: { authorization: `Bearer ${token}` } });
  const sets = (await setsResponse.json()).sets;
  const roomResult = await emitAck(host, "room:create", { setId: sets[0].id });
  assert.equal(roomResult.ok, true);
  const code = roomResult.lobby.code;
  const setResponse = await fetch(`${base}/api/host/sets/${sets[0].id}`, { headers: { authorization: `Bearer ${token}` } });
  const set = (await setResponse.json()).set;
  const p1 = await playerSocket(base, "Sam", code);
  const p2 = await playerSocket(base, "Lee", code);
  assert.equal(p1.result.ok, true);
  assert.equal(p2.result.ok, true);

  const q1Promise = eventOnce(p1.socket, "game:question");
  const q2Promise = eventOnce(p2.socket, "game:question");
  const started = await emitAck(host, "game:start", { code });
  assert.equal(started.ok, true);
  const [q1, q2] = await Promise.all([q1Promise, q2Promise]);
  assert.equal(q1.questionIndex, 0);
  assert.equal(Object.hasOwn(q1, "correctOptionId"), false);
  assert.equal(Object.hasOwn(q2, "correctOptionId"), false);

  const correctId = set.questions[0].correctOptionId;
  const correct = q1.options.find((option) => option.id === correctId);
  const wrong = q2.options.find((option) => option.id !== correctId);
  const board1 = eventOnce(p1.socket, "game:leaderboard");
  const board2 = eventOnce(p2.socket, "game:leaderboard");
  const analytics1 = eventMatching(p1.socket, "game:analytics", (data) => data.submittedCount === 1);
  const analytics2 = eventMatching(p2.socket, "game:analytics", (data) => data.submittedCount === 2);
  const standings1 = eventMatching(p1.socket, "game:standings", (data) => data.answeredCount === 1);
  const standings2 = eventMatching(p2.socket, "game:standings", (data) => data.answeredCount === 2);
  const answer1 = await emitAck(p1.socket, "answer:submit", { questionIndex: 0, optionId: correct.id });
  assert.equal(answer1.ok, true);
  const liveAnalytics1 = await analytics1;
  const duplicate = await emitAck(p1.socket, "answer:submit", { questionIndex: 0, optionId: wrong.id });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate");
  const answer2 = await emitAck(p2.socket, "answer:submit", { questionIndex: 0, optionId: wrong.id });
  assert.equal(answer2.ok, true);
  const [result1, result2, liveAnalytics2, liveStandings1, liveStandings2] = await Promise.all([board1, board2, analytics2, standings1, standings2]);
  assert.equal(result1.correctAnswer, "36");
  assert.equal(result1.leaderboard.find((row) => row.name === "Sam").score, answer1.scoreDelta);
  assert.equal(result1.leaderboard.find((row) => row.name === "Lee").score, 0);
  assert.equal(result2.correctOptionId, correctId);
  assert.equal(result1.correctCount, 1);
  assert.equal(result1.incorrectCount, 1);
  assert.equal(result1.timeoutCount, 0);
  assert.equal(liveAnalytics1.submittedCount, 1);
  assert.equal(liveAnalytics2.submittedCount, 2);
  assert.equal(liveAnalytics2.playerCount, 2);
  assert.equal(liveStandings1.leaderboard.length, 2);
  assert.equal(liveStandings2.leaderboard[0].name, "Sam");
  assert.equal(Object.hasOwn(liveStandings2.leaderboard[0], "selectedOptionId"), false);
  assert.ok(result1.answers.every((answer) => answer.speedPercentile >= 0 && answer.speedPercentile <= 100));
  assert.equal(result1.answers.find((answer) => answer.playerId === p1.result.playerId).speedPercentile, 100);
});

test("host can end an active quiz and final results include unanswered question timeouts", async () => {
  const { base } = await boot({ maxPlayers: 2 });
  const { socket: host, token } = await loginHost(base);
  const headers = { authorization: `Bearer ${token}` };
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers })).json()).sets;
  const set = (await (await fetch(`${base}/api/host/sets/${sets[0].id}`, { headers })).json()).set;
  const room = await emitAck(host, "room:create", { setId: set.id, college: "Lloyd Export College" });
  const player = await playerSocket(base, "Still Playing", room.lobby.code);
  const questionPromise = eventOnce(player.socket, "game:question");
  await emitAck(host, "game:start", { code: room.lobby.code });
  const question = await questionPromise;
  const correctOptionId = question.options.find((option) => option.id === set.questions[0].correctOptionId).id;
  await emitAck(player.socket, "answer:submit", { questionIndex: 0, optionId: correctOptionId });

  const noAuthExport = await fetch(`${base}/api/host/rooms/${room.lobby.code}/export.csv`);
  assert.equal(noAuthExport.status, 401);
  const csvResponse = await fetch(`${base}/api/host/rooms/${room.lobby.code}/export.csv`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get("content-type"), /text\/csv/);
  const csv = await csvResponse.text();
  assert.match(csv, /"questionNumber","question","topic","difficulty","player","roomCollege"/);
  assert.match(csv, /Still Playing/);
  assert.match(csv, /Lloyd Export College/);

  const hostFinal = eventOnce(host, "game:final");
  const playerFinal = eventOnce(player.socket, "game:final");
  const ended = await emitAck(host, "game:end", { code: room.lobby.code });
  assert.equal(ended.ok, true);
  const [hostResults, playerResults] = await Promise.all([hostFinal, playerFinal]);
  const row = playerResults.players.find((entry) => entry.playerId === player.result.playerId);
  assert.equal(row.timeouts, set.questions.length - 1);
  assert.equal(row.incorrect, 0);
  assert.equal(hostResults.totalQuestions, set.questions.length);
});

test("server rejects an answer received beyond the latency allowance", async () => {
  const { base, instance } = await boot({ questionSeconds: 30 });
  const { socket: host, token } = await loginHost(base);
  const headers = { authorization: `Bearer ${token}` };
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers })).json()).sets;
  const room = await emitAck(host, "room:create", { setId: sets[0].id });
  const player = await playerSocket(base, "Late Player", room.lobby.code);
  const questionPromise = eventOnce(player.socket, "game:question");
  await emitAck(host, "game:start", { code: room.lobby.code });
  const question = await questionPromise;
  const dbRoom = instance.db.prepare("SELECT * FROM rooms WHERE code = ?").get(room.lobby.code);
  const result = instance.game.submit({
    roomCode: room.lobby.code,
    playerId: player.result.playerId,
    questionIndex: 0,
    optionId: question.options[0].id,
    receivedAt: dbRoom.ends_at + 151,
    latencyRttMs: 0,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "late");
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE room_code = ?").get(room.lobby.code).n, 0);
});

test("resume token reconnects the same player without creating a duplicate", async () => {
  const { base, instance } = await boot();
  const { socket: host, token } = await loginHost(base);
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers: { authorization: `Bearer ${token}` } })).json()).sets;
  const room = await emitAck(host, "room:create", { setId: sets[0].id });
  const first = await playerSocket(base, "Riya", room.lobby.code);
  assert.equal(first.result.ok, true);
  assert.equal(first.result.lobby.questionSet, "Campus Aptitude Sprint");
  assert.equal(first.result.lobby.totalQuestions, 5);
  first.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resumed = await playerSocket(base, "Riya", room.lobby.code, first.result.resumeToken);
  assert.equal(resumed.result.ok, true);
  assert.equal(resumed.result.playerId, first.result.playerId);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM players WHERE room_code = ?").get(room.lobby.code).n, 1);
});

test("reconnecting during leaderboard only sends results to that player", async () => {
  const { base, instance } = await boot({ maxPlayers: 2 });
  const { socket: host, token } = await loginHost(base);
  const headers = { authorization: `Bearer ${token}` };
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers })).json()).sets;
  const set = (await (await fetch(`${base}/api/host/sets/${sets[0].id}`, { headers })).json()).set;
  const room = await emitAck(host, "room:create", { setId: sets[0].id });
  const p1 = await playerSocket(base, "Riya", room.lobby.code);
  const p2 = await playerSocket(base, "Noah", room.lobby.code);
  const q1Promise = eventOnce(p1.socket, "game:question");
  const q2Promise = eventOnce(p2.socket, "game:question");
  await emitAck(host, "game:start", { code: room.lobby.code });
  const [q1, q2] = await Promise.all([q1Promise, q2Promise]);
  const p2Leaderboard = eventOnce(p2.socket, "game:leaderboard");
  const p1Leaderboard = eventOnce(p1.socket, "game:leaderboard");
  const correctId = set.questions[0].correctOptionId;
  await emitAck(p1.socket, "answer:submit", { questionIndex: 0, optionId: q1.options.find((option) => option.id === correctId).id });
  await emitAck(p2.socket, "answer:submit", { questionIndex: 0, optionId: q2.options[0].id });
  await Promise.all([p1Leaderboard, p2Leaderboard]);

  p1.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  let roomBroadcasts = 0;
  p2.socket.on("game:leaderboard", () => { roomBroadcasts += 1; });
  const resumedSocket = connectSocket(base, { transports: ["websocket"] });
  clients.push(resumedSocket);
  await eventOnce(resumedSocket, "connect");
  const resumedBoard = eventOnce(resumedSocket, "game:leaderboard");
  const joined = await emitAck(resumedSocket, "room:join", {
    code: room.lobby.code,
    displayName: "Riya",
    college: "Test College",
    resumeToken: p1.result.resumeToken,
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.playerId, p1.result.playerId);
  assert.equal((await resumedBoard).leaderboard.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(roomBroadcasts, 0);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM players WHERE room_code = ?").get(room.lobby.code).n, 2);
});

test("a room refuses players beyond its capacity", async () => {
  const { base } = await boot({ maxPlayers: 2 });
  const { socket: host, token } = await loginHost(base);
  const sets = (await (await fetch(`${base}/api/host/sets`, { headers: { authorization: `Bearer ${token}` } })).json()).sets;
  const room = await emitAck(host, "room:create", { setId: sets[0].id });
  await playerSocket(base, "One", room.lobby.code);
  await playerSocket(base, "Two", room.lobby.code);
  const thirdSocket = connectSocket(base, { transports: ["websocket"] });
  clients.push(thirdSocket);
  await eventOnce(thirdSocket, "connect");
  const third = await emitAck(thirdSocket, "room:join", { code: room.lobby.code, displayName: "Three", college: "Test" });
  assert.equal(third.ok, false);
  assert.equal(third.code, "full");
});
