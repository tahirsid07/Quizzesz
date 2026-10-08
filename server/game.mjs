import { randomInt } from "node:crypto";
import {
  getFinalResults,
  getLeaderboard,
  getPlayers,
  getQuestionSet,
  getRoom,
  getRoundAnswers,
  hasAnswered,
  recordAnswer,
  roomPlayerCount,
  updateRoomState,
} from "./db.mjs";

export const MAX_LATENCY_COMPENSATION_MS = 150;

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function scoreCorrectAnswer({ durationMs, responseMs }) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (!Number.isFinite(responseMs) || responseMs < 0 || responseMs > durationMs) return 0;
  return 100 + Math.floor(900 * ((durationMs - responseMs) / durationMs));
}

export function shuffledOptions(options, random = Math.random) {
  const copy = [...options];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class GameController {
  constructor({ db, io, questionSeconds = 30, latencyGraceMs = MAX_LATENCY_COMPENSATION_MS, maxPlayers = 50 }) {
    this.db = db;
    this.io = io;
    this.questionSeconds = questionSeconds;
    this.maxPlayers = maxPlayers;
    this.latencyGraceMs = Math.min(MAX_LATENCY_COMPENSATION_MS, Math.max(0, latencyGraceMs));
    this.timers = new Map();
    this.optionOrders = new Map();
    this.previousRanks = new Map();
  }

  roomOptionMap(roomCode, questionIndex) {
    if (!this.optionOrders.has(roomCode)) this.optionOrders.set(roomCode, new Map());
    const byQuestion = this.optionOrders.get(roomCode);
    if (!byQuestion.has(questionIndex)) byQuestion.set(questionIndex, new Map());
    return byQuestion.get(questionIndex);
  }

  playerQuestion(roomCode, playerId) {
    const room = getRoom(this.db, roomCode);
    if (!room || room.status !== "active") return null;
    const set = getQuestionSet(this.db, room.set_id);
    const question = set?.questions[room.current_index];
    if (!question) return null;
    const optionMap = this.roomOptionMap(roomCode, room.current_index);
    if (!optionMap.has(playerId)) {
      const shuffled = shuffledOptions(question.options, () => randomInt(0, 1_000_000) / 1_000_000);
      optionMap.set(playerId, shuffled.map((option) => option.id));
    }
    const ids = optionMap.get(playerId);
    const byId = new Map(question.options.map((option) => [option.id, option]));
    return {
      questionId: question.id,
      prompt: question.prompt,
      options: ids.map((id) => byId.get(id)),
      topic: question.topic,
      difficulty: question.difficulty,
      imageUrl: question.imageUrl,
      tableData: question.tableData,
      questionIndex: room.current_index,
      totalQuestions: set.questions.length,
      startedAt: room.started_at,
      endsAt: room.ends_at,
      serverNow: Date.now(),
      hasAnswered: hasAnswered(this.db, roomCode, playerId, room.current_index),
    };
  }

  async sendCurrentState(socket, roomCode, playerId) {
    const room = getRoom(this.db, roomCode);
    if (!room) return;
    if (room.status === "lobby") {
      socket.emit("room:lobby", this.lobby(roomCode));
    } else if (room.status === "active") {
      const question = this.playerQuestion(roomCode, playerId);
      if (question) socket.emit("game:question", question);
    } else if (room.status === "leaderboard") {
      socket.emit("game:leaderboard", this.leaderboardPayload(roomCode, room.current_index));
    } else if (room.status === "ended") {
      socket.emit("game:final", getFinalResults(this.db, roomCode));
    }
  }

  async start(roomCode) {
    const room = getRoom(this.db, roomCode);
    if (!room) throw new Error("Room not found.");
    if (room.status !== "lobby") throw new Error("This room has already started.");
    const set = getQuestionSet(this.db, room.set_id);
    if (!set?.questions.length) throw new Error("Add at least one question before starting.");
    await this.beginQuestion(roomCode, 0);
  }

  async beginQuestion(roomCode, questionIndex) {
    const room = getRoom(this.db, roomCode);
    const set = getQuestionSet(this.db, room.set_id);
    if (!set || questionIndex >= set.questions.length) return this.finish(roomCode);
    const startedAt = Date.now();
    const durationMs = this.questionSeconds * 1000;
    const endsAt = startedAt + durationMs;
    updateRoomState(this.db, roomCode, { status: "active", currentIndex: questionIndex, startedAt, endsAt });
    const previousTimer = this.timers.get(roomCode);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => this.endQuestion(roomCode, questionIndex), durationMs + this.latencyGraceMs);
    timer.unref?.();
    this.timers.set(roomCode, timer);

    const sockets = await this.io.in(roomCode).fetchSockets();
    for (const socket of sockets) {
      if (socket.data.role === "player" && socket.data.playerId) {
        socket.emit("game:question", this.playerQuestion(roomCode, socket.data.playerId));
      } else if (socket.data.role === "host") {
        const question = set.questions[questionIndex];
        socket.emit("host:question", {
          questionId: question.id,
          prompt: question.prompt,
          topic: question.topic,
          difficulty: question.difficulty,
          questionIndex,
          totalQuestions: set.questions.length,
          startedAt,
          endsAt,
          serverNow: Date.now(),
        });
      }
    }
    this.io.to(roomCode).emit("room:status", { status: "active", questionIndex, endsAt, serverNow: Date.now() });
  }

  submit({ roomCode, playerId, questionIndex, optionId, receivedAt = Date.now(), latencyRttMs = 0 }) {
    const room = getRoom(this.db, roomCode);
    if (!room || room.status !== "active" || room.current_index !== questionIndex) return { accepted: false, reason: "not-active" };
    const set = getQuestionSet(this.db, room.set_id);
    const question = set?.questions[questionIndex];
    if (!question || !question.options.some((option) => option.id === optionId)) return { accepted: false, reason: "invalid-option" };
    if (hasAnswered(this.db, roomCode, playerId, questionIndex)) return { accepted: false, reason: "duplicate" };

    const allowance = Math.min(this.latencyGraceMs, Math.max(0, Math.floor(latencyRttMs / 2)));
    const effectiveAt = receivedAt - allowance;
    if (effectiveAt > room.ends_at || receivedAt > room.ends_at + this.latencyGraceMs) return { accepted: false, reason: "late" };
    const durationMs = room.ends_at - room.started_at;
    const responseMs = Math.max(0, Math.min(durationMs, effectiveAt - room.started_at));
    const isCorrect = optionId === question.correctOptionId;
    const scoreDelta = isCorrect ? scoreCorrectAnswer({ durationMs, responseMs }) : 0;
    const saved = recordAnswer(this.db, {
      roomCode,
      playerId,
      questionId: question.id,
      questionIndex,
      selectedOptionId: optionId,
      isCorrect,
      responseMs,
      scoreDelta,
      receivedAt,
    });
    if (!saved.accepted) return saved;

    const playerCount = roomPlayerCount(this.db, roomCode);
    const submittedCount = this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE room_code = ? AND question_index = ?")
      .get(roomCode, questionIndex).n;
    this.emitLiveStandings(roomCode, questionIndex, submittedCount, playerCount);
    const roundAnswers = getRoundAnswers(this.db, roomCode, questionIndex);
    this.io.to(roomCode).emit("game:analytics", {
      questionIndex,
      submittedCount,
      playerCount,
      correctCount: roundAnswers.filter((answer) => answer.isCorrect).length,
      incorrectCount: roundAnswers.filter((answer) => !answer.isCorrect).length,
      averageResponseMs: roundAnswers.length
        ? Math.round(roundAnswers.reduce((total, answer) => total + answer.responseMs, 0) / roundAnswers.length)
        : 0,
    });
    if (playerCount > 0 && submittedCount >= playerCount) {
      const timer = this.timers.get(roomCode);
      if (timer) clearTimeout(timer);
      this.endQuestion(roomCode, questionIndex);
    }
    return { accepted: true, isCorrect, scoreDelta };
  }

  emitLiveStandings(roomCode, questionIndex, answeredCount, playerCount) {
    const previousRanks = this.previousRanks.get(roomCode);
    const leaderboard = getLeaderboard(this.db, roomCode).map((row, index) => {
      const rank = index + 1;
      const previous = previousRanks?.get(row.playerId);
      return { ...row, rank, rankMovement: previous == null ? 0 : previous - rank };
    });
    this.previousRanks.set(roomCode, new Map(leaderboard.map((row) => [row.playerId, row.rank])));
    this.io.to(roomCode).emit("game:standings", { questionIndex, answeredCount, playerCount, leaderboard });
  }

  endQuestion(roomCode, questionIndex) {
    const room = getRoom(this.db, roomCode);
    if (!room || room.status !== "active" || room.current_index !== questionIndex) return;
    const timer = this.timers.get(roomCode);
    if (timer) clearTimeout(timer);
    this.timers.delete(roomCode);
    updateRoomState(this.db, roomCode, { status: "leaderboard", currentIndex: questionIndex, startedAt: room.started_at, endsAt: room.ends_at });
    this.emitLeaderboard(roomCode, questionIndex);
  }

  emitLeaderboard(roomCode, questionIndex) {
    const payload = this.leaderboardPayload(roomCode, questionIndex);
    this.io.to(roomCode).emit("game:leaderboard", payload);
    this.io.to(roomCode).emit("room:status", { status: "leaderboard", questionIndex });
  }

  leaderboardPayload(roomCode, questionIndex) {
    const room = getRoom(this.db, roomCode);
    const set = getQuestionSet(this.db, room.set_id);
    const question = set?.questions[questionIndex];
    const leaderboard = getLeaderboard(this.db, roomCode).map((row, index) => {
      const rank = index + 1;
      const previous = this.previousRanks.get(roomCode)?.get(row.playerId);
      return { ...row, rank, rankMovement: previous == null ? 0 : previous - rank };
    });
    this.previousRanks.set(roomCode, new Map(leaderboard.map((row) => [row.playerId, row.rank])));
    const answers = getRoundAnswers(this.db, roomCode, questionIndex);
    const playerCount = roomPlayerCount(this.db, roomCode);
    return {
      questionIndex,
      totalQuestions: set.questions.length,
      playerCount,
      correctCount: answers.filter((answer) => answer.isCorrect).length,
      incorrectCount: answers.filter((answer) => !answer.isCorrect).length,
      timeoutCount: Math.max(0, playerCount - answers.length),
      question: question?.prompt,
      correctOptionId: question?.correctOptionId,
      correctAnswer: question?.options.find((option) => option.id === question?.correctOptionId)?.text,
      answers: answers.map((answer) => {
        const peers = answers.filter((peer) => peer.playerId !== answer.playerId);
        const slowerPeers = peers.filter((peer) => peer.responseMs > answer.responseMs).length;
        return {
          ...answer,
          speedPercentile: peers.length ? Math.round((slowerPeers / peers.length) * 100) : 0,
        };
      }),
      leaderboard,
    };
  }

  async next(roomCode) {
    const room = getRoom(this.db, roomCode);
    if (!room || room.status !== "leaderboard") throw new Error("The current round is not ready to advance.");
    const set = getQuestionSet(this.db, room.set_id);
    const nextIndex = room.current_index + 1;
    if (nextIndex >= set.questions.length) return this.finish(roomCode);
    await this.beginQuestion(roomCode, nextIndex);
  }

  finish(roomCode) {
    const room = getRoom(this.db, roomCode);
    if (!room) return;
    const timer = this.timers.get(roomCode);
    if (timer) clearTimeout(timer);
    this.timers.delete(roomCode);
    updateRoomState(this.db, roomCode, { status: "ended", currentIndex: room.current_index, startedAt: room.started_at, endsAt: room.ends_at });
    const result = getFinalResults(this.db, roomCode);
    const previousRanks = this.previousRanks.get(roomCode);
    result.players = result.players.map((player, index) => ({
      ...player,
      rankMovement: previousRanks?.has(player.playerId) ? previousRanks.get(player.playerId) - (index + 1) : 0,
    }));
    this.io.to(roomCode).emit("game:final", result);
    this.io.to(roomCode).emit("room:status", { status: "ended", questionIndex: room.current_index });
  }

  lobby(roomCode) {
    const room = getRoom(this.db, roomCode);
    if (!room) return null;
    const set = getQuestionSet(this.db, room.set_id);
    return { code: roomCode, college: room.college, status: room.status, players: getPlayers(this.db, roomCode), questionSet: set?.title, totalQuestions: set?.questions.length || 0, maxPlayers: this.maxPlayers };
  }

  cleanup() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
