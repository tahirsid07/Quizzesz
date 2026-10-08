const app = document.getElementById("app");
const toast = document.getElementById("toast");
const state = {
  view: localStorage.getItem("aqAccountToken") ? "accountLoading" : "account",
  role: null,
  hostToken: localStorage.getItem("aqHostToken") || "",
  accountToken: localStorage.getItem("aqAccountToken") || "",
  account: null,
  authMode: "login",
  socket: null,
  lobby: null,
  currentCode: "",
  playerId: "",
  resumeToken: "",
  playerName: "",
  college: "",
  pendingJoin: null,
  sets: [],
  selectedSetId: "",
  editingSet: null,
  editingQuestionIndex: null,
  question: null,
  selectedOptionId: "",
  hostQuestion: null,
  leaderboard: null,
  liveStandings: null,
  finalResults: null,
  analytics: null,
  liveOverview: null,
  homeLiveUnavailable: false,
  homeLeague: null,
  leaguePeriod: "week",
  leagueRequestId: 0,
  hasAnswered: false,
  answerConfirmed: false,
  timerInterval: null,
  serverOffset: 0,
  connection: "offline",
  aiTopic: "Aptitude",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function showToast(message, kind = "") {
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 3000);
}

function showMessage(id, message, kind = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message;
  element.className = `inline-message ${kind}`;
}

function navActive() {
  document.querySelectorAll("[data-nav]").forEach((button) => {
    const nav = button.dataset.nav;
    const active = (nav === "home" && state.view === "home") ||
      (nav === "join" && state.view === "join") ||
      (nav === "performance" && state.view === "performance") ||
      (nav === "account" && state.view === "account") ||
      (nav === "host" && state.view.startsWith("host")) || (nav === "league" && state.view === "league");
    button.classList.toggle("active", active);
  });
}

function setView(view) {
  const accountRoutes = ["account", "accountLoading"];
  if (!state.account && !accountRoutes.includes(view)) view = "account";
  if (view !== "home" && state.homePreviewInterval) {
    clearInterval(state.homePreviewInterval);
    state.homePreviewInterval = null;
  }
  state.view = view;
  render();
  navActive();
}

async function api(url, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.hostToken) headers.authorization = `Bearer ${state.hostToken}`;
  const response = await fetch(url, { ...options, headers });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

async function accountApi(url, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.accountToken) headers.authorization = `Bearer ${state.accountToken}`;
  const response = await fetch(url, { ...options, headers });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Account request failed (${response.status}).`);
  return payload;
}

function ensureSocket(hostToken = state.hostToken) {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  const socket = window.io({ auth: { hostToken } });
  state.socket = socket;
  socket.on("connect", () => {
    state.connection = "online";
    if (state.role === "host" && localStorage.getItem("aqHostRoom")) {
      const code = localStorage.getItem("aqHostRoom");
      socket.emit("host:resume", { code }, (result) => {
        if (result?.ok) {
          state.currentCode = code;
          state.lobby = result.lobby;
          setView("hostLobby");
        }
      });
    } else if (state.role === "player") {
      const savedRoom = JSON.parse(localStorage.getItem("aqLastRoom") || "null");
      const joinData = state.pendingJoin || (savedRoom?.resumeToken ? {
        code: savedRoom.code,
        displayName: savedRoom.displayName,
        college: savedRoom.college,
        resumeToken: savedRoom.resumeToken,
      } : null);
      if (joinData) {
        state.pendingJoin = joinData;
        socket.emit("room:join", joinData, handleJoinResult);
      }
    }
    render();
  });
  socket.on("disconnect", () => {
    state.connection = "reconnecting";
    render();
  });
  socket.io.on("reconnect_attempt", () => {
    state.connection = "reconnecting";
    render();
  });
  socket.io.on("reconnect_failed", () => {
    state.connection = "lost";
    render();
  });
  socket.on("connect_error", () => {
    state.connection = "reconnecting";
    render();
  });
  socket.on("server:ping", ({ nonce }) => socket.emit("client:pong", { nonce }));
  socket.on("room:lobby", (lobby) => {
    state.lobby = lobby;
    state.currentCode = lobby.code;
    if (["hostLobby", "playerLobby", "hostGame"].includes(state.view)) render();
  });
  socket.on("room:status", (message) => {
    if (state.lobby) state.lobby.status = message.status;
  });
  socket.on("host:question", (question) => {
    state.hostQuestion = question;
    state.analytics = null;
    state.liveStandings = null;
    state.serverOffset = question.serverNow - Date.now();
    state.hasAnswered = false;
    state.selectedOptionId = "";
    setView("hostGame");
    startTimer();
  });
  socket.on("game:question", (question) => {
    state.question = question;
    state.liveStandings = null;
    state.serverOffset = question.serverNow - Date.now();
    state.hasAnswered = question.hasAnswered;
    state.answerConfirmed = question.hasAnswered;
    state.selectedOptionId = "";
    setView("playerGame");
    startTimer();
  });
  socket.on("game:leaderboard", (result) => {
    state.leaderboard = result;
    stopTimer();
    setView("leaderboard");
  });
  socket.on("game:analytics", (analytics) => {
    state.analytics = analytics;
    if (state.view === "hostGame") render();
  });
  socket.on("game:standings", (standings) => {
    state.liveStandings = standings;
    if (["playerGame", "hostGame"].includes(state.view)) render();
  });
  socket.on("game:final", (result) => {
    state.finalResults = result;
    stopTimer();
    setView("final");
  });
  socket.on("answer:received", ({ scoreDelta }) => {
    state.hasAnswered = true;
    state.answerConfirmed = true;
    render();
    showToast(scoreDelta > 0 ? `Answer saved. ${scoreDelta} points earned.` : "Answer saved.", "success");
  });
  socket.on("answer:rejected", ({ reason }) => {
    const messages = { duplicate: "Your answer is already saved.", late: "That answer arrived after time was up.", "not-active": "This question is no longer active." };
    showToast(messages[reason] || "The answer was not accepted.", "error");
  });
  return socket;
}

function handleJoinResult(result) {
  if (!result?.ok) {
    showMessage("joinMessage", result?.error || "Could not join the room.", "error");
    return;
  }
  state.playerId = result.playerId;
  state.resumeToken = result.resumeToken;
  state.lobby = result.lobby;
  state.currentCode = result.lobby.code;
  localStorage.setItem(`aqPlayer:${state.currentCode}`, JSON.stringify({
    resumeToken: state.resumeToken,
    displayName: state.playerName,
    college: state.college,
  }));
  localStorage.setItem("aqLastRoom", JSON.stringify({
    code: state.currentCode,
    resumeToken: state.resumeToken,
    displayName: state.playerName,
    college: state.college,
  }));
  state.pendingJoin = null;
  setView(result.lobby.status === "lobby" ? "playerLobby" : "playerLobby");
}

async function loadSets() {
  const data = await api("/api/host/sets");
  state.sets = data.sets;
  if (!state.selectedSetId && state.sets.length) state.selectedSetId = state.sets[0].id;
}

function connectionMark() {
  const labels = { online: "Connected", reconnecting: "Reconnecting · score safe", lost: "Connection lost · score safe" };
  return `<span class="connection ${state.connection === "online" ? "online" : state.connection === "lost" ? "offline" : "reconnecting"}" role="status">${labels[state.connection] || "Connecting"}</span>`;
}

function renderPlayerPerformanceCard(answer, peers) {
  if (!answer) return "";
  const basePoints = answer.isCorrect ? 100 : 0;
  const speedBonus = Math.max(0, answer.scoreDelta - basePoints);
  return `
    <div class="performance-card ${answer.isCorrect ? "correct" : "incorrect"}">
      <div class="performance-head">
        <div>
          <p class="eyebrow compact">Question performance</p>
          <h3>${answer.isCorrect ? "Correct answer" : "Keep building"}</h3>
        </div>
        <span class="chip ${answer.isCorrect ? "success" : "neutral"}">${answer.scoreDelta} points</span>
      </div>
      <div class="stat-grid compact-grid">
        <div class="mini-stat"><strong>${basePoints}</strong><span>Base points</span></div>
        <div class="mini-stat"><strong>+${speedBonus}</strong><span>Speed bonus</span></div>
        <div class="mini-stat"><strong>${(answer.responseMs / 1000).toFixed(1)}s</strong><span>Response time</span></div>
        <div class="mini-stat"><strong>${answer.speedPercentile}%</strong><span>Faster than ${answer.speedPercentile}% of ${peers} other responders</span></div>
        <div class="mini-stat"><strong>${answer.isCorrect ? "Correct" : "Incorrect"}</strong><span>Answer result</span></div>
        <div class="mini-stat"><strong>${answer.scoreDelta}</strong><span>Total this round</span></div>
      </div>
      <div class="status-row">
        <span class="chip ${state.connection === "online" ? "success" : "neutral"}">${state.connection === "online" ? "Connected" : "Reconnecting"}</span>
        <span class="chip neutral">Server-validated timing and submissions</span>
      </div>
    </div>`;
}

function renderLiveStandings() {
  const standings = state.liveStandings;
  if (!standings?.leaderboard?.length) return "";
  return `
    <section class="live-standings" aria-label="Live standings">
      <div class="live-standings-head"><h2>Live standings</h2><span>${standings.answeredCount}/${standings.playerCount} answered</span></div>
      <div class="live-standings-list">${standings.leaderboard.slice(0, 5).map((player) => `
        <div class="live-standing-row">
          <span class="rank-number">#${player.rank}</span>
          <strong>${esc(player.name)}</strong>
          <span class="rank-score">${player.score} pts</span>
          <span class="rank-move ${player.rankMovement < 0 ? "down" : ""}">${player.rankMovement > 0 ? `↑ ${player.rankMovement}` : player.rankMovement < 0 ? `↓ ${Math.abs(player.rankMovement)}` : "—"}</span>
        </div>`).join("")}</div>
    </section>`;
}

function renderHomeLeaguePreview() {
  if (!state.homeLeague) return `<p class="preview-empty">Loading live standings…</p>`;
  const colleges = state.homeLeague.colleges.slice(0, 3);
  if (!colleges.length) return `<p class="preview-empty">No completed college scores yet.</p>`;
  return colleges.map((college, index) => `
    <div class="preview-leader"><span class="preview-rank">0${index + 1}</span><strong>${esc(college.college)}</strong><span>${college.score} pts</span></div>`).join("");
}

function renderHomePlayerPreview() {
  if (!state.homeLeague) return `<p class="preview-empty">Loading weekly leaderboard…</p>`;
  const players = state.homeLeague.players.slice(0, 3);
  if (!players.length) return `<p class="preview-empty">No completed player scores yet.</p>`;
  return players.map((player, index) => `
    <div class="preview-leader"><span class="preview-rank">0${index + 1}</span><strong>${esc(player.name)}</strong><span>${player.score} pts</span></div>`).join("");
}

async function loadHomePreview() {
  const [liveResult, leagueResult] = await Promise.allSettled([
    state.homeLiveUnavailable ? Promise.reject(new Error("Live count endpoint unavailable")) : fetch("/api/live"),
    fetch("/api/league?days=7"),
  ]);
  if (state.view !== "home") return;
  const liveStatus = document.querySelector("[data-preview-status]");
  if (liveResult.status === "fulfilled" && liveResult.value.ok) {
    state.liveOverview = await liveResult.value.json();
    state.homeLiveUnavailable = false;
    document.querySelector("[data-live-players]").textContent = state.liveOverview.players;
    document.querySelector("[data-live-rooms]").textContent = state.liveOverview.rooms;
    liveStatus.textContent = "Live counts · auto-refreshing";
  } else {
    state.homeLiveUnavailable = true;
    document.querySelector("[data-live-players]").textContent = "—";
    document.querySelector("[data-live-rooms]").textContent = "—";
    liveStatus.innerHTML = `Live counts unavailable <button class="preview-retry" data-action="refresh-preview">Retry</button>`;
  }
  if (leagueResult.status === "fulfilled" && leagueResult.value.ok) {
    state.homeLeague = await leagueResult.value.json();
    document.querySelector("[data-home-leaders]").innerHTML = renderHomeLeaguePreview();
    document.querySelector("[data-home-players]").innerHTML = renderHomePlayerPreview();
  } else {
    document.querySelector("[data-home-leaders]").innerHTML = `<p class="preview-empty">College standings unavailable.</p>`;
    document.querySelector("[data-home-players]").innerHTML = `<p class="preview-empty">Player standings unavailable.</p>`;
  }
}

function renderHome() {
  return `
    <section class="hero hero-landing">
      <div class="hero-copy-wrap">
        <p class="eyebrow">A live campus quiz arena</p>
        <h1>Think fast.<br />Answer faster.</h1>
        <p class="hero-copy">One room. One clock. Every answer moves your rank. Join a live aptitude showdown or host your own campus arena.</p>
        <div class="hero-actions">
          <button class="button button-light" data-action="go-join">Join a live quiz</button>
          <button class="button button-ghost" data-action="go-host">Host a quiz</button>
          <button class="button button-ghost" data-action="go-league">View league</button>
        </div>
      </div>
      <div class="hero-panel" aria-label="Live AptiQuiz arena preview">
        <div class="arena-preview">
          <div class="arena-preview-head"><span class="live-indicator"><span class="live-dot"></span>Live arena</span><span class="preview-mark">AQ / 01</span></div>
          <p class="preview-label">Campus pulse right now</p>
          <div class="preview-counts">
            <div><strong data-live-players>${state.liveOverview?.players ?? "—"}</strong><span>Players online</span></div>
            <div><strong data-live-rooms>${state.liveOverview?.rooms ?? "—"}</strong><span>Open rooms</span></div>
          </div>
          <p class="preview-status" data-preview-status>Live counts · auto-refreshing</p>
          <div class="preview-board">
            <div class="preview-board-head"><span>College league</span><span>7D</span></div>
            <div data-home-leaders>${renderHomeLeaguePreview()}</div>
          </div>
          <div class="preview-board">
            <div class="preview-board-head"><span>Top players</span><span>7D</span></div>
            <div data-home-players>${renderHomePlayerPreview()}</div>
          </div>
          <p class="preview-footnote">Counts refresh from active rooms. Rankings update after completed rounds.</p>
        </div>
      </div>
    </section>

    <section class="arena-panel">
      <div class="arena-panel-head">
        <div>
          <p class="eyebrow">Live game arena</p>
          <h2>Built for speed, fairness, and competition</h2>
        </div>
      </div>
      <div class="arena-grid">
        <article class="arena-card"><span class="arena-label">Speed scoring</span><strong>Up to 900 bonus</strong><p>Correct answers earn a base score plus a speed bonus set by the server.</p></article>
        <article class="arena-card"><span class="arena-label">Leaderboard</span><strong>Round rankings</strong><p>Scores and rank movement recalculate after each timed question.</p></article>
        <article class="arena-card"><span class="arena-label">Player safety</span><strong>Server validated</strong><p>Connection state, timing, and duplicate submissions are checked by the server.</p></article>
      </div>
    </section>

    <section class="mode-grid" aria-label="AptiQuiz game modes">
      <button class="mode-card mode-primary" data-action="go-join">
        <span class="mode-tag">Play now</span>
        <h3>Join a quiz room</h3>
        <p>Enter the room code and jump straight into the question timer.</p>
      </button>
      <button class="mode-card" data-action="go-host">
        <span class="mode-tag">Host</span>
        <h3>Create your own room</h3>
        <p>Set questions, start the round, and watch your batch compete live.</p>
      </button>
      <button class="mode-card" data-action="generate-ai-home">
        <span class="mode-tag">AI quiz</span>
        <h3>Generate a smart set</h3>
        <p>Build a fresh aptitude or practice quiz from any topic in seconds.</p>
      </button>
      <button class="mode-card" data-action="go-league">
        <span class="mode-tag">League</span>
        <h3>Check the rankings</h3>
        <p>Compare colleges and track who’s leading the leaderboard this month.</p>
      </button>
    </section>

    <div class="section-head"><div><h2>Why students keep coming back</h2><p>Short, competitive rounds for placement prep and class activity.</p></div></div>
    <section class="feature-grid" aria-label="AptiQuiz features">
      <article class="feature"><span class="feature-num">01</span><h3>Real-time pressure</h3><p>Every player answers under the same countdown, so momentum and accuracy matter.</p></article>
      <article class="feature"><span class="feature-num">02</span><h3>Performance insight</h3><p>See score, speed, accuracy, and topic trends after each round.</p></article>
      <article class="feature"><span class="feature-num">03</span><h3>Campus competition</h3><p>Host an event, invite teams, and turn every room into a live college challenge.</p></article>
    </section>

    <section class="how-section" aria-labelledby="how-title">
      <div class="section-head"><div><p class="eyebrow">Three moves to game time</p><h2 id="how-title">How it works</h2></div></div>
      <div class="how-steps">
        <article><span>01</span><h3>Join or host</h3><p>Enter a six-digit room code, or choose a set and open a private lobby.</p></article>
        <article><span>02</span><h3>Beat the clock</h3><p>Answer on your phone. Correct answers earn more when you answer sooner.</p></article>
        <article><span>03</span><h3>Climb together</h3><p>Track round ranks, personal performance, and college contribution.</p></article>
      </div>
    </section>

    <section class="final-cta">
      <div><p class="eyebrow">Your next round starts here</p><h2>Ready when you are.</h2><p>Bring your class, club, or campus into the arena.</p></div>
      <button class="button button-light" data-action="go-join">Join a live quiz</button>
    </section>

    <section class="feature-grid extra-grid" aria-label="AptiQuiz quick start actions">
      <article class="feature feature-highlight">
        <span class="feature-num">04</span>
        <h3>Quick start</h3>
        <p>Use a room code to start in seconds and keep the energy high.</p>
      </article>
      <article class="feature feature-highlight">
        <span class="feature-num">05</span>
        <h3>Practice in batches</h3>
        <p>Set challenge rounds for labs, clubs, or placement prep sessions.</p>
      </article>
      <article class="feature feature-highlight">
        <span class="feature-num">06</span>
        <h3>Built to replay</h3>
        <p>Run multiple rounds, duplicate question sets, and compare scores over time.</p>
      </article>
    </section>`;
}

function renderJoin() {
  return `
    <section class="panel" style="max-width:720px;margin:0 auto">
      <div class="panel-head"><div><p class="eyebrow">Player entry</p><h1>Join a quiz room</h1><p>Enter the six-digit code shared by your host.</p></div>${state.account ? `<span class="chip success">Signed in as ${esc(state.account.displayName)}</span>` : `<button class="button button-outline button-small" data-action="open-account">Sign in</button>`}</div>
      <form id="joinForm">
        <div class="form-grid">
          <div class="field"><label for="joinCode">Room code</label><input id="joinCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="123456" /></div>
          <div class="field"><label for="joinName">Your name</label><input id="joinName" name="displayName" value="${esc(state.account?.displayName || "")}" maxlength="28" required placeholder="Aarav" /></div>
        </div>
        <div class="field"><label for="joinCollege">College <span class="subtle">(optional, for the league)</span></label><input id="joinCollege" name="college" value="${esc(state.account?.college || "")}" maxlength="80" placeholder="College name" /></div>
        <div class="form-actions"><button class="button button-primary" type="submit">Join lobby</button><button class="button button-outline" type="button" data-action="go-home">Back</button></div>
        <p id="joinMessage" class="inline-message" role="status"></p>
      </form>
    </section>`;
}

function renderAccount() {
  const isSignup = state.authMode === "signup";
  if (state.account) {
    return `<section class="auth-screen"><div class="auth-background" aria-hidden="true"><img src="https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=2000&q=85" alt="" fetchpriority="high" /></div><div class="auth-story"><p class="auth-kicker">APTIQUIZ · CAMPUS ARENA</p><h2>Think sharp.<br /><span>Rise together.</span></h2><p>Your next quiz is one tap away.</p></div><section class="panel account-panel"><div class="account-heading"><span class="account-monogram">AQ</span><p class="account-brand">Apti<span>Quiz</span></p><h1>Welcome, ${esc(state.account.displayName)}</h1><p>Your player profile is ready.</p></div><div class="account-profile"><div class="account-avatar">${esc(state.account.displayName.slice(0, 1).toUpperCase())}</div><div><strong>${esc(state.account.email)}</strong><span>${esc(state.account.college || "College not set")}</span></div></div><div class="form-actions"><button class="button button-primary account-submit" data-action="go-home">Enter AptiQuiz</button><button class="button button-outline" data-action="account-logout">Sign out</button></div></section></section>`;
  }
  return `
    <section class="auth-screen">
      <div class="auth-background" aria-hidden="true"><img src="https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=2000&q=85" alt="" fetchpriority="high" /></div>
      <div class="auth-story"><p class="auth-kicker">APTIQUIZ · CAMPUS ARENA</p><h2>${isSignup ? "Make your mark." : "Think sharp."}<br /><span>${isSignup ? "Join the challenge." : "Rise together."}</span></h2><p>Fast rounds. Bright minds. One campus leaderboard.</p><div class="auth-proof"><span>01</span> Your next quiz starts here</div></div>
      <section class="panel account-panel">
      <div class="account-heading"><span class="account-monogram">AQ</span><p class="account-brand">Apti<span>Quiz</span></p><h1>${isSignup ? "Create your account" : "Welcome back"}</h1><p>${isSignup ? "Create your player profile to enter the arena." : "Login to enter the AptiQuiz arena."}</p></div>
      <form id="accountForm" class="account-form" autocomplete="on">
        ${isSignup ? `<div class="field"><label for="accountName">Display name</label><input id="accountName" name="displayName" maxlength="28" autocomplete="name" required placeholder="Your name" /></div>` : ""}
        ${isSignup ? `<div class="field"><label for="accountUsername">Username</label><input id="accountUsername" name="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9_.\\-]+" autocomplete="username" required placeholder="Choose a username" /></div>` : ""}
        <div class="field"><label for="accountIdentifier">${isSignup ? "Email" : "Email / Username"}</label><input id="accountIdentifier" name="identifier" ${isSignup ? "type=\"email\"" : "type=\"text\""} maxlength="254" autocomplete="${isSignup ? "email" : "username"}" required placeholder="${isSignup ? "you@example.com" : "Email or username"}" /></div>
        ${isSignup ? `<div class="field"><label for="accountCollege">College <span class="subtle">(optional)</span></label><input id="accountCollege" name="college" maxlength="80" autocomplete="organization" placeholder="College name" /></div>` : ""}
        <div class="field"><label for="accountPassword">Password</label><input id="accountPassword" name="password" type="password" minlength="${isSignup ? "8" : "1"}" maxlength="200" autocomplete="${isSignup ? "new-password" : "current-password"}" required placeholder="${isSignup ? "At least 8 characters" : "Your password"}" /></div>
        ${!isSignup ? `<div class="account-forgot"><button type="button" data-action="forgot-password">Forgot Password?</button></div>` : ""}
        <p id="accountMessage" class="inline-message" role="status"></p>
        <button class="button button-primary account-submit" type="submit">${isSignup ? "Create account" : "Login"}</button>
      </form>
      <div class="account-divider"><span>Quiz together, think faster</span></div>
      <p class="account-switch">${isSignup ? "Already registered?" : "New to AptiQuiz?"}<button type="button" data-action="toggle-auth">${isSignup ? "Login" : "Create Account / Sign Up"}</button></p>
      </section>
    </section>`;
}

function renderHostLogin() {
  return `
    <section class="panel" style="max-width:600px;margin:0 auto">
      <div class="panel-head"><div><p class="eyebrow">Host tools</p><h1>Sign in to host</h1><p>Use the access code configured by the person running the server.</p></div></div>
      <form id="hostLoginForm">
        <div class="field"><label for="accessCode">Host access code</label><input id="accessCode" name="accessCode" type="password" autocomplete="current-password" required /></div>
        <div class="form-actions"><button class="button button-primary" type="submit">Continue</button><button class="button button-outline" type="button" data-action="go-home">Back</button></div>
        <p id="hostLoginMessage" class="inline-message" role="status"></p>
      </form>
    </section>`;
}

function renderHostDashboard() {
  const selected = state.selectedSetId || "";
  const rows = state.sets.map((set) => `
    <div class="set-row">
      <div><p class="set-title">${esc(set.title)}</p><span class="set-meta">${set.question_count} questions</span></div>
      <div class="set-actions">
        <button class="button button-outline button-small" data-action="edit-set" data-id="${esc(set.id)}">Edit</button>
        <button class="button button-outline button-small" data-action="duplicate-set" data-id="${esc(set.id)}">Duplicate</button>
      </div>
    </div>`).join("");
  return `
    <section class="panel">
      <div class="panel-head"><div><p class="eyebrow">Host dashboard</p><h1>Set up a quiz</h1><p>Create a question set, then open a room for players.</p></div><button class="button button-outline button-small" data-action="host-logout">Sign out</button></div>
      <div class="form-grid">
        <div class="field"><label for="setSelect">Question set</label><select id="setSelect">${state.sets.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? "selected" : ""}>${esc(s.title)} (${s.question_count})</option>`).join("")}</select></div>
        <div class="field"><label for="roomCollege">Room college <span class="subtle">(official league affiliation)</span></label><input id="roomCollege" maxlength="80" value="${esc(state.account?.college || "")}" placeholder="College or campus name" /></div>
      </div>
      <div class="form-actions"><button class="button button-primary" data-action="create-room">Create room</button></div>
      <p id="hostMessage" class="inline-message" role="status"></p>
    </section>
    <section class="panel">
      <div class="row-between"><div><h2 style="margin:0 0 6px;font-size:21px">Question sets</h2><p class="subtle">Edit, reorder, or duplicate a set for another round.</p></div><div class="set-actions"><button class="button button-outline" data-action="new-set">New question set</button><button class="button button-primary button-small" data-action="generate-ai-home">AI generate</button></div></div>
      <div class="set-list" style="margin-top:18px">${rows || `<div class="empty-state"><strong>No question sets yet</strong>Create a set to open your first room.</div>`}</div>
    </section>`;
}

function renderQuestionRows() {
  return state.editingSet.questions.map((question, index) => `
    <div class="question-item">
      <div class="question-item-head"><p>${index + 1}. ${esc(question.prompt)}</p><div class="set-actions">
        <button class="button button-outline button-small" data-action="move-question" data-index="${index}" data-delta="-1" aria-label="Move question up" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="button button-outline button-small" data-action="move-question" data-index="${index}" data-delta="1" aria-label="Move question down" ${index === state.editingSet.questions.length - 1 ? "disabled" : ""}>↓</button>
        <button class="button button-outline button-small" data-action="edit-question" data-index="${index}">Edit</button>
        <button class="button button-danger button-small" data-action="remove-question" data-index="${index}">Remove</button>
      </div></div>
      <div class="option-preview">${question.options.map((option) => `<span>${option.id === question.correctOptionId ? "✓ " : ""}${esc(option.text)}</span>`).join("")}</div>
      <span class="set-meta">${esc(question.topic)} · ${esc(question.difficulty)}</span>
    </div>`).join("");
}

function renderEditor() {
  const isEditing = Boolean(state.editingSet.id);
  return `
    <section class="panel">
      <div class="panel-head"><div><p class="eyebrow">Question authoring</p><h1>${isEditing ? "Edit question set" : "New question set"}</h1><p>Four options per question. The correct answer stays on the server until each round ends.</p></div></div>
      <div class="field"><label for="setTitle">Set title</label><input id="setTitle" value="${esc(state.editingSet.title)}" maxlength="100" placeholder="Placement practice round" /></div>

      <div class="ai-panel">
        <div class="row-between"><h2 style="font-size:20px;margin:0">AI quiz generator</h2><span class="subtle">Smart fill for a quick topic-based set</span></div>
        <div class="form-grid" style="margin-top:16px">
          <div class="field"><label for="aiTopicInput">Topic</label><input id="aiTopicInput" value="${esc(state.aiTopic || "Aptitude")}" maxlength="40" placeholder="Quantitative, verbal, reasoning..." /></div>
          <div class="field"><label for="aiQuestionCount">Questions</label><select id="aiQuestionCount">
            <option value="3">3</option>
            <option value="5" selected>5</option>
            <option value="8">8</option>
            <option value="10">10</option>
          </select></div>
        </div>
        <div class="form-actions"><button class="button button-primary" type="button" data-action="generate-ai">Generate AI quiz</button></div>
      </div>

      <div class="row-between"><h2 style="font-size:20px;margin:10px 0">Questions <span class="subtle">(${state.editingSet.questions.length})</span></h2><button class="button button-outline button-small" data-action="cancel-editor">Back to dashboard</button></div>
      <div>${renderQuestionRows() || `<div class="empty-state"><strong>No questions yet</strong>Add at least one question before saving.</div>`}</div>
      <div class="question-editor">
        <h2 id="draftHeading" style="font-size:20px;margin:0 0 16px">${state.editingQuestionIndex == null ? "Add a question" : "Update question"}</h2>
        <form id="questionDraftForm">
          <div class="field"><label for="qPrompt">Question</label><textarea id="qPrompt" maxlength="600" required placeholder="Enter the question"></textarea></div>
          <div class="form-grid">
            ${[0,1,2,3].map((i) => `<div class="field"><label for="opt${i}">Option ${String.fromCharCode(65+i)}</label><input id="opt${i}" maxlength="300" required placeholder="Answer choice ${String.fromCharCode(65+i)}" /></div>`).join("")}
          </div>
          <div class="form-grid">
            <div class="field"><label for="correctOption">Correct answer</label><select id="correctOption"><option value="a">Option A</option><option value="b">Option B</option><option value="c">Option C</option><option value="d">Option D</option></select></div>
            <div class="field"><label for="qTopic">Topic</label><select id="qTopic"><option>Quantitative</option><option>Logical Reasoning</option><option>Verbal</option><option>Data Interpretation</option></select></div>
            <div class="field"><label for="qDifficulty">Difficulty</label><select id="qDifficulty"><option>Easy</option><option>Medium</option><option>Hard</option></select></div>
            <div class="field"><label for="qImage">Image URL <span class="subtle">(optional)</span></label><input id="qImage" type="url" placeholder="https://…" /></div>
          </div>
          <div class="field"><label for="qTable">Table data <span class="subtle">(optional JSON: {"columns":[],"rows":[]})</span></label><textarea id="qTable" placeholder='{"columns":["Month","Units"],"rows":[["Jan",40],["Feb",50]]}'></textarea></div>
          <div class="form-actions"><button class="button button-outline" type="submit">${state.editingQuestionIndex == null ? "Add question" : "Update question"}</button><button class="button button-primary" type="button" data-action="save-set">Save question set</button></div>
          <p id="editorMessage" class="inline-message" role="status"></p>
        </form>
      </div>
    </section>`;
}

function renderRoomLobby(isHost) {
  const lobby = state.lobby || { code: state.currentCode, players: [], status: "lobby", maxPlayers: 50 };
  const players = lobby.players || [];
  const maxPlayers = lobby.maxPlayers || 50;
  const connectedPlayers = players.filter((player) => player.connected).length;
  const playerHtml = players.map((player) => `
    <div class="player-pill"><span class="avatar" aria-hidden="true">${esc(player.displayName?.slice(0,1)?.toUpperCase() || "P")}</span><strong>${esc(player.displayName)}</strong><span class="player-state ${player.connected ? "" : "offline"}" title="${player.connected ? "Connected" : "Disconnected"}"></span></div>`).join("");
  return `
    <section class="panel">
      <div class="panel-head"><div><p class="eyebrow">${isHost ? "Host room" : "Player lobby"}</p><h1>${isHost ? "Waiting room" : "You’re in"}</h1><p>${esc(lobby.questionSet || "AptiQuiz room")} · ${lobby.totalQuestions || 0} questions · ${esc(lobby.college || "Unaffiliated room")}</p></div>${connectionMark()}</div>
      <div class="room-summary"><div><span class="subtle">ROOM CODE</span><br /><span class="room-code">${esc(lobby.code)}</span></div><div class="subtle">Share this code with players. Up to 50 can join.</div></div>
      <div class="lobby-safety">
        <span class="chip success">Secure room code</span>
        <span class="chip neutral">${connectedPlayers} connected</span>
        <span class="chip neutral">${state.connection === "online" ? "Reconnected" : "Reconnecting"}</span>
        <span class="chip neutral">Server validates timing and duplicate submissions</span>
      </div>
      <div class="row-between" style="margin-top:28px"><h2 style="font-size:20px;margin:0">Players <span class="subtle">(${connectedPlayers}/${maxPlayers} connected · ${players.length} joined)</span></h2>${isHost ? `<button class="button button-primary" data-action="start-game" ${players.length === 0 ? "disabled" : ""}>Start quiz</button>` : `<span class="subtle">Waiting for the host to start…</span>`}</div>
      <div class="player-list">${playerHtml || `<div class="empty-state"><strong>No players yet</strong>Players appear here when they join.</div>`}</div>
      ${isHost ? `
        <div class="analytics-grid">
          <div class="mini-analytics"><strong>${connectedPlayers}/${maxPlayers}</strong><span>Players connected / capacity</span></div>
          <div class="mini-analytics"><strong>${lobby.totalQuestions || 0}</strong><span>Questions in set</span></div>
          <div class="mini-analytics"><strong>${esc(lobby.status)}</strong><span>Room state</span></div>
        </div>` : ""}
      <p id="lobbyMessage" class="inline-message" role="status"></p>
    </section>`;
}

function renderTable(tableData) {
  if (!tableData || !Array.isArray(tableData.columns) || !Array.isArray(tableData.rows)) return "";
  return `<table class="quiz-table"><thead><tr>${tableData.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${tableData.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderPlayerGame() {
  const q = state.question;
  if (!q) return `<section class="panel"><div class="empty-state"><strong>Waiting for the next question</strong>Keep this tab open.</div></section>`;
  const options = q.options.map((option, index) => `<button class="option-button ${state.selectedOptionId === option.id ? "selected" : ""}" data-action="answer" data-option="${esc(option.id)}" aria-pressed="${state.selectedOptionId === option.id}" ${state.hasAnswered ? "disabled" : ""}><span class="option-key">${String.fromCharCode(65+index)}</span>${esc(option.text)}</button>`).join("");
  const progress = Math.round(((q.questionIndex + 1) / q.totalQuestions) * 100);
  return `
    <section class="panel">
      <div class="game-sticky-bar">
        <div class="game-room-info"><span class="room-code compact-code">${esc(state.currentCode)}</span><span class="live-indicator"><span class="live-dot"></span>LIVE</span>${connectionMark()}</div>
        <div class="timer timer-large" aria-label="Time remaining"><span data-timer-label aria-live="off">30s</span><span class="timer-track" role="progressbar" aria-label="Question time remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span class="timer-fill" data-timer-fill></span></span></div>
      </div>
      <div class="question-progress"><span>Question ${q.questionIndex + 1} / ${q.totalQuestions}</span><span>${progress}%</span><span class="question-progress-track"><span style="width:${progress}%"></span></span></div>
      <div class="status-row">
        <span class="chip success">Difficulty: ${esc(q.difficulty)}</span>
        <span class="chip neutral">Up to 900 speed bonus</span>
        <span class="chip neutral">${esc(q.topic)}</span>
        <span class="chip neutral">Players answered: ${state.liveStandings?.answeredCount || 0}/${state.liveStandings?.playerCount || state.lobby?.players?.length || 0}</span>
      </div>
      <h1 class="question-prompt">${esc(q.prompt)}</h1>
      ${q.imageUrl ? `<img src="${esc(q.imageUrl)}" alt="Question image" style="max-width:100%;max-height:260px;border-radius:12px;margin-bottom:18px" />` : ""}
      ${renderTable(q.tableData)}
      <div class="status-row"><span class="chip neutral">Correct: 100–1000 points, with a speed bonus</span><span class="chip neutral">Wrong: 0 points, no penalty</span><span class="chip neutral">Fair play · Server timing · Randomized options</span></div>
      <div class="quiz-options">${options}</div>
      ${renderLiveStandings()}
      <div class="answer-controls"><p id="answerMessage" class="inline-message" role="status">${state.answerConfirmed ? "Answer saved on the server. The correct answer reveals when the round ends." : state.selectedOptionId ? "Submitting answer securely…" : "Choose an answer. Use 1–4 or A–D on your keyboard."}</p><button class="button button-outline button-small" data-action="leave-room">Leave quiz</button></div>
    </section>
    <p class="subtle" style="margin:14px 4px">The server controls timing, validates submissions, and restores your active question after reconnect.</p>`;
}

function renderHostGame() {
  const q = state.hostQuestion;
  if (!q) return `<section class="panel"><div class="empty-state"><strong>Quiz is starting</strong>Players will see the first question shortly.</div></section>`;
  const roomPlayers = state.lobby?.players || [];
  const connectedPlayers = roomPlayers.filter((player) => player.connected).length;
  return `
    <section class="panel">
      <div class="panel-head"><div><p class="eyebrow">Host view · Room ${esc(state.currentCode)}</p><h1>Question ${q.questionIndex + 1} of ${q.totalQuestions}</h1><p>${esc(q.topic)} · ${esc(q.difficulty)}</p></div>${connectionMark()}</div>
      <div class="game-sticky-bar"><div class="game-room-info"><span class="room-code compact-code">${esc(state.currentCode)}</span><span class="live-indicator"><span class="live-dot"></span>LIVE</span>${connectionMark()}</div><div class="timer timer-large"><span data-timer-label aria-live="off">30s</span><span class="timer-track" role="progressbar" aria-label="Question time remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span class="timer-fill" data-timer-fill></span></span></div></div>
      <div class="question-progress"><span>Question ${q.questionIndex + 1} / ${q.totalQuestions}</span><span>${Math.round(((q.questionIndex + 1) / q.totalQuestions) * 100)}%</span><span class="question-progress-track"><span style="width:${Math.round(((q.questionIndex + 1) / q.totalQuestions) * 100)}%"></span></span></div>
      <div class="status-row">
        <span class="chip success">Live player count: ${connectedPlayers}</span>
        <span class="chip neutral">Correct: ${state.analytics?.questionIndex === q.questionIndex ? state.analytics.correctCount : 0}</span>
        <span class="chip neutral">Incorrect: ${state.analytics?.questionIndex === q.questionIndex ? state.analytics.incorrectCount : 0}</span>
        <span class="chip neutral">Difficulty: ${esc(q.difficulty)}</span>
      </div>
      <h2 class="question-prompt">${esc(q.prompt)}</h2>
      <p class="subtle">The correct answer is withheld until the round ends.</p>
      <div class="analytics-grid">
        <div class="mini-analytics"><strong>${connectedPlayers}</strong><span>Players connected</span></div>
        <div class="mini-analytics"><strong>${state.analytics?.questionIndex === q.questionIndex ? `${state.analytics.submittedCount}/${state.analytics.playerCount}` : `0/${(state.lobby?.players || []).length}`}</strong><span>Answers submitted</span></div>
        <div class="mini-analytics"><strong>${state.analytics?.questionIndex === q.questionIndex ? state.analytics.correctCount : 0}</strong><span>Correct answers</span></div>
        <div class="mini-analytics"><strong>${state.analytics?.questionIndex === q.questionIndex ? state.analytics.incorrectCount : 0}</strong><span>Incorrect answers</span></div>
        <div class="mini-analytics"><strong>${state.analytics?.questionIndex === q.questionIndex && state.analytics.submittedCount ? `${(state.analytics.averageResponseMs / 1000).toFixed(1)}s` : "—"}</strong><span>Average response time</span></div>
      </div>
      ${renderLiveStandings()}
      <div class="player-list">${(state.lobby?.players || []).map((p) => `<div class="player-pill"><span class="avatar">${esc(p.displayName.slice(0,1).toUpperCase())}</span><strong>${esc(p.displayName)}</strong><span class="player-state ${p.connected ? "" : "offline"}"></span></div>`).join("")}</div>
      <div class="form-actions"><button class="button button-danger" data-action="end-game">End quiz</button></div>
    </section>`;
}

function renderLeaderboardRows(rows) {
  return `<div class="rank-grid leaderboard-grid rank-header"><span>#</span><span>Player</span><span class="rank-col-extra">College</span><span>Score</span><span>Accuracy</span><span class="rank-col-extra">Round +</span><span class="rank-col-extra">Avg speed</span><span>Move</span></div>${rows.map((r) => {
    const roundPoints = state.leaderboard?.answers.find((answer) => answer.playerId === r.playerId)?.scoreDelta ?? 0;
    const isYou = state.role === "player" && r.playerId === state.playerId;
    const initial = r.name?.trim().slice(0, 1).toUpperCase() || "P";
    return `<div class="rank-grid leaderboard-grid rank-row ${isYou ? "you-row" : ""}"><span class="rank-number">${r.rank || "—"}</span><span class="rank-player"><span class="avatar rank-avatar">${esc(initial)}</span><strong>${esc(r.name)}</strong>${isYou ? `<span class="you-mark">You</span>` : ""}</span><span class="rank-col-extra">${esc(r.college || "—")}</span><span class="rank-score">${r.score}</span><span>${r.accuracy}%</span><span class="rank-col-extra round-points">+${roundPoints}</span><span class="rank-col-extra">${r.avgResponseMs ? `${(r.avgResponseMs/1000).toFixed(1)}s` : "—"}</span><span class="rank-move ${r.rankMovement < 0 ? "down" : ""}">${r.rankMovement > 0 ? `↑ ${r.rankMovement}` : r.rankMovement < 0 ? `↓ ${Math.abs(r.rankMovement)}` : "—"}</span></div>`;
  }).join("")}`;
}

function renderLeaderboard() {
  const result = state.leaderboard || { leaderboard: [], answers: [], questionIndex: 0, totalQuestions: 0 };
  const answerForPlayer = result.answers.find((a) => a.playerId === state.playerId);
  const podium = result.leaderboard.slice(0, 3);
  const podiumHtml = podium.length ? `<div class="podium" aria-label="Top three players">${podium.map((player) => `<div class="podium-place podium-${player.rank}"><span class="podium-rank">#${player.rank}</span><span class="avatar podium-avatar">${esc(player.name?.slice(0, 1).toUpperCase() || "P")}</span><strong>${esc(player.name)}${state.role === "player" && player.playerId === state.playerId ? " · You" : ""}</strong><span>${player.score} pts</span></div>`).join("")}</div>` : "";
  return `
    <section class="panel">
      <div class="panel-head"><div><p class="eyebrow">Round ${result.questionIndex + 1} complete</p><h1>Leaderboard</h1><p>${esc(result.question || "Round results")}</p></div>${connectionMark()}</div>
      <p class="correct-answer">Correct answer: ${esc(result.correctAnswer || "—")}${answerForPlayer ? ` · Your answer ${answerForPlayer.isCorrect ? "was correct" : "was not correct"}` : ""}</p>
      <div class="status-row">
        <span class="chip success">Dynamic leaderboard</span>
        <span class="chip neutral">${result.answers.length} responses recorded</span>
        <span class="chip neutral">Rank movement from live scores</span>
      </div>
      ${state.role === "host" ? `<div class="analytics-grid round-breakdown"><div class="mini-analytics"><strong>${result.correctCount}</strong><span>Correct</span></div><div class="mini-analytics"><strong>${result.incorrectCount}</strong><span>Incorrect</span></div><div class="mini-analytics"><strong>${result.timeoutCount}</strong><span>Timeouts</span></div></div>` : ""}
      ${podiumHtml}
      ${state.role === "player" ? answerForPlayer ? renderPlayerPerformanceCard(answerForPlayer, Math.max(0, result.answers.length - 1)) : `<div class="performance-card timeout-card"><strong>Time expired</strong><span>No answer was recorded for this question.</span></div>` : ""}
      <div style="overflow-x:auto;margin-top:22px">${renderLeaderboardRows(result.leaderboard)}</div>
      ${state.role === "host" ? `<div class="form-actions" style="margin-top:22px"><button class="button button-primary" data-action="next-question">${result.questionIndex + 1 >= result.totalQuestions ? "Show final results" : "Next question"}</button></div>` : `<p class="inline-message">Waiting for the host to continue…</p>`}
    </section>`;
}

function renderFinal() {
  const result = state.finalResults || { players: [], topics: [] };
  const me = result.players.find((p) => p.playerId === state.playerId);
  return `
    <section class="panel">
      <div class="results-top"><span class="trophy" aria-hidden="true">★</span><div><p class="eyebrow" style="margin-bottom:4px">Quiz complete</p><h1 style="font-size:32px;margin:0">Final results</h1></div></div>
      <div class="status-row">
        <span class="chip success">College contribution</span>
        <span class="chip neutral">Topic-wise performance</span>
        <span class="chip neutral">Final leaderboard</span>
      </div>
      ${me ? `<div class="stats-grid"><div class="stat"><strong>#${result.players.findIndex((p) => p.playerId === me.playerId) + 1}</strong><span>Your overall rank</span></div><div class="stat"><strong>${me.score}</strong><span>Points earned</span></div><div class="stat"><strong>${me.accuracy}%</strong><span>Accuracy</span></div><div class="stat"><strong>${me.avgResponseMs ? `${(me.avgResponseMs / 1000).toFixed(1)}s` : "—"}</strong><span>Average response</span></div></div>` : ""}
      <h2 style="font-size:20px;margin:26px 0 8px">Player results</h2><div style="overflow-x:auto">${renderLeaderboardRows(result.players.map((r, i) => ({ ...r, rank: i + 1 })))}</div>
      <h2 style="font-size:20px;margin:28px 0 8px">Topic strengths</h2>
      <div class="stats-grid">${result.topics.map((topic) => `<div class="stat"><strong>${topic.accuracy}%</strong><span>${esc(topic.topic)} · ${topic.correct}/${topic.answered} correct</span></div>`).join("") || `<p class="subtle">No answers were recorded.</p>`}</div>
      <h2 style="font-size:20px;margin:28px 0 8px">College contribution</h2>
      <div class="stats-grid">${Object.entries(result.players.reduce((totals, player) => {
        const college = player.college || "Unaffiliated";
        totals[college] = (totals[college] || 0) + player.score;
        return totals;
      }, {})).sort((a, b) => b[1] - a[1]).map(([college, score]) => `<div class="stat"><strong>${score} pts</strong><span>${esc(college)}</span></div>`).join("") || `<p class="subtle">No college contributions recorded.</p>`}</div>
      <div class="form-actions" style="margin-top:20px">${state.role === "host" ? `<button class="button button-primary" data-action="new-host-room">Host another room</button><button class="button button-outline" data-action="export-results">Export CSV</button>` : `<button class="button button-primary" data-action="go-join">Join another quiz</button><button class="button button-outline" data-action="go-home">Return home</button>`}<button class="button button-outline" data-action="go-performance">My performance</button><button class="button button-outline" data-action="go-league">View college league</button><button class="button button-outline" data-action="share-results">Share result</button></div>
    </section>`;
}

function renderPerformance() {
  const result = state.finalResults || { players: [], topics: [] };
  const me = result.players.find((player) => player.playerId === state.playerId);
  if (!me) {
    return `<section class="panel empty-state"><strong>No saved performance in this session</strong>Finish a quiz to see your score, accuracy, response speed, topic strengths, and achievements here.<div class="form-actions" style="justify-content:center"><button class="button button-primary" data-action="go-join">Join a quiz</button></div></section>`;
  }
  const rank = result.players.findIndex((player) => player.playerId === me.playerId) + 1;
  const fasterPeers = result.players.filter((player) => player.playerId !== me.playerId && player.answered > 0 && player.avgResponseMs > me.avgResponseMs).length;
  const peers = result.players.filter((player) => player.playerId !== me.playerId && player.answered > 0).length;
  const percentile = peers ? Math.round((fasterPeers / peers) * 100) : 0;
  const topics = result.topics;
  const strongest = [...topics].sort((a, b) => b.accuracy - a.accuracy)[0];
  const needsWork = [...topics].filter((topic) => topic.answered > 0).sort((a, b) => a.accuracy - b.accuracy)[0];
  const achievements = [];
  if (me.correct === result.totalQuestions && result.totalQuestions > 0) achievements.push("Perfect round");
  if (peers && fasterPeers === peers) achievements.push("Speed demon");
  if (rank === 1) achievements.push("Campus champion");
  if (me.longestCorrectStreak >= 3) achievements.push("Hot streak");
  if (me.rankMovement > 0) achievements.push("Leaderboard climber");
  if (topics.some((topic) => /logic/i.test(topic.topic) && topic.accuracy >= 80)) achievements.push("Logic master");
  return `
    <section class="panel performance-page">
      <div class="panel-head"><div><p class="eyebrow">Player intelligence</p><h1>${esc(me.name)}’s performance</h1><p>Calculated from your completed quiz in this session.</p></div>${connectionMark()}</div>
      <div class="performance-summary">
        <div class="performance-rank"><span>Overall rank</span><strong>#${rank}</strong><span>${esc(me.college || "Unaffiliated")}</span></div>
        <div class="stats-grid">
          <div class="stat"><strong>${me.score}</strong><span>Total score</span></div>
          <div class="stat"><strong>${me.accuracy}%</strong><span>Accuracy · ${me.correct} correct</span></div>
          <div class="stat"><strong>${me.avgResponseMs ? `${(me.avgResponseMs / 1000).toFixed(1)}s` : "—"}</strong><span>Average response time</span></div>
          <div class="stat"><strong>${percentile}%</strong><span>Faster than ${percentile}% of responders</span></div>
          <div class="stat"><strong>${me.answered}</strong><span>Questions answered</span></div>
          <div class="stat"><strong>${me.incorrect}</strong><span>Incorrect answers</span></div>
          <div class="stat"><strong>${me.timeouts}</strong><span>Timeouts</span></div>
        </div>
      </div>
      <div class="performance-insights">
        <div><span class="arena-label">Strength</span><strong>${strongest ? `${esc(strongest.topic)} · ${strongest.accuracy}%` : "Not enough data"}</strong></div>
        <div><span class="arena-label">Practice next</span><strong>${needsWork ? `${esc(needsWork.topic)} · ${needsWork.accuracy}%` : "Not enough data"}</strong></div>
      </div>
      <h2 class="section-title">Achievements</h2>
      <div class="achievement-row">${achievements.map((achievement) => `<span class="achievement">${esc(achievement)}</span>`).join("") || `<span class="subtle">Keep playing to unlock result-based achievements.</span>`}</div>
      <h2 class="section-title">Topic performance</h2>
      <div class="stats-grid">${topics.map((topic) => `<div class="stat"><strong>${topic.accuracy}%</strong><span>${esc(topic.topic)} · ${topic.correct}/${topic.answered} correct</span></div>`).join("") || `<p class="subtle">No topic results recorded.</p>`}</div>
    </section>`;
}

async function renderLeague() {
  const requestId = ++state.leagueRequestId;
  app.innerHTML = `<section class="panel"><div class="panel-head"><div><p class="eyebrow">Campus competition</p><h1>College league</h1><p>Loading current standings…</p></div></div><div class="loading-skeleton" aria-label="Loading league standings"><span></span><span></span><span></span></div></section>`;
  let league;
  let loadError = "";
  const period = state.leaguePeriod === "all" ? "all" : "week";
  try { league = await api(`/api/league?period=${period}`); } catch (error) { loadError = error.message; }
  if (state.view !== "league" || requestId !== state.leagueRequestId) return;
  if (loadError) {
    app.innerHTML = `<section class="panel empty-state"><strong>League standings could not load</strong>${esc(loadError)}<div class="form-actions" style="justify-content:center"><button class="button button-primary" data-action="retry-league">Retry</button></div></section>`;
    return;
  }
  const playerCollege = (state.college || "").trim().toLocaleLowerCase();
  const contribution = state.finalResults?.players
    .filter((player) => (player.college || "").trim().toLocaleLowerCase() === playerCollege)
    .reduce((total, player) => total + player.score, 0) || 0;
  app.innerHTML = `
    <section class="panel">
      <div class="panel-head"><div><p class="eyebrow">Campus competition</p><h1>College league</h1><p>Scores and accuracy are aggregated from completed quiz rooms.</p></div></div>
      <div class="league-toolbar"><div class="segmented-control" role="group" aria-label="League period"><button class="segment ${period === "week" ? "active" : ""}" data-action="league-period" data-period="week" aria-pressed="${period === "week"}">This week</button><button class="segment ${period === "all" ? "active" : ""}" data-action="league-period" data-period="all" aria-pressed="${period === "all"}">All time</button></div>${playerCollege ? `<span class="your-contribution">Your college contribution this round: <strong>+${contribution}</strong></span>` : ""}</div>
      <h2 class="section-title">Top colleges</h2>
      <div class="league-table-wrap"><div class="rank-grid league-college-grid rank-header"><span>#</span><span>College</span><span>Rooms</span><span>Players</span><span>Accuracy</span><span>Points</span></div>
      ${league.colleges.map((row, i) => {
        const isMine = playerCollege && row.college.trim().toLocaleLowerCase() === playerCollege;
        const initials = row.college.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
        return `<div class="rank-grid league-college-grid rank-row ${isMine ? "your-college" : ""}"><span class="rank-number">${i + 1}</span><span class="college-name"><span class="college-mark">${esc(initials)}</span><strong>${esc(row.college)}</strong>${isMine ? `<span class="you-mark">Your college</span>` : ""}</span><span>${row.rooms}</span><span>${row.players}</span><span>${row.accuracy}%</span><span class="rank-score">${row.score}</span></div>`;
      }).join("") || `<div class="empty-state"><strong>No league scores yet</strong>Play a room and add a college name to contribute.</div>`}</div>
      <h2 class="section-title section-title-spaced">Top player from each college</h2>
      <div class="college-leaders">${(league.topPlayersByCollege || []).map((row) => `<div class="college-leader"><span class="college-mark">${esc(row.college.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase())}</span><span><strong>${esc(row.name)}</strong><small>${esc(row.college)} · ${row.rooms} rooms</small></span><b>${row.score} pts</b></div>`).join("") || `<p class="subtle">Completed player scores appear here.</p>`}</div>
      <h2 class="section-title section-title-spaced">Top players</h2>
      <div class="league-table-wrap"><div class="rank-grid league-player-grid rank-header"><span>#</span><span>Player</span><span>College</span><span>Rooms</span><span>Score</span></div>
      ${league.players.map((row, i) => `<div class="rank-grid league-player-grid rank-row"><span class="rank-number">${i + 1}</span><strong>${esc(row.name)}</strong><span>${esc(row.college)}</span><span>${row.rooms}</span><span class="rank-score">${row.score}</span></div>`).join("") || `<div class="empty-state">No player scores yet.</div>`}</div>
    </section>`;
}

function generateAiQuizSet(topic, count) {
  const normalizedTopic = (topic || "Aptitude").trim() || "Aptitude";
  const safeCount = Math.max(3, Math.min(10, Number(count) || 5));
  const templates = [
    {
      prompt: `A student scored ${Math.round(80 + Math.random() * 35)}% in a ${normalizedTopic.toLowerCase()} test. Which option best describes the result?`,
      options: [
        `${normalizedTopic} mastery is strong and above average`,
        `${normalizedTopic} performance is random and unreliable`,
        `${normalizedTopic} understanding is not relevant to results`,
        `${normalizedTopic} scores cannot be compared across tests`
      ],
      correct: "a",
      difficulty: "Medium",
      topic: normalizedTopic,
    },
    {
      prompt: `Choose the most accurate statement about improving ${normalizedTopic.toLowerCase()} skills in a timed practice session.`,
      options: [
        `Consistent short drills improve speed and accuracy`,
        `Skipping review helps maintain confusion`,
        `Long breaks reduce learning in all cases`,
        `Only memorizing answers improves performance`
      ],
      correct: "a",
      difficulty: "Easy",
      topic: normalizedTopic,
    },
    {
      prompt: `If a learner practices ${normalizedTopic.toLowerCase()} questions daily, which outcome is most likely?`,
      options: [
        `Faster pattern recognition and better confidence`,
        `No change in accuracy at all`,
        `Lower focus during timed rounds`,
        `The quiz becomes impossible to solve`
      ],
      correct: "a",
      difficulty: "Easy",
      topic: normalizedTopic,
    },
    {
      prompt: `During a live challenge, which strategy works best for ${normalizedTopic.toLowerCase()} questions?`,
      options: [
        `Read carefully, eliminate options, and answer quickly`,
        `Rush without checking the question`,
        `Skip every difficult question`,
        `Answer based on guesswork only`
      ],
      correct: "a",
      difficulty: "Medium",
      topic: normalizedTopic,
    },
    {
      prompt: `What makes a ${normalizedTopic.toLowerCase()} practice set effective for revision?`,
      options: [
        `Balanced difficulty, timed rounds, and clear explanations`,
        `Random questions without feedback`,
        `Avoiding repetition completely`,
        `Only reading the answer key without solving`
      ],
      correct: "a",
      difficulty: "Medium",
      topic: normalizedTopic,
    }
  ];

  const generated = [];
  for (let i = 0; i < safeCount; i += 1) {
    const base = templates[i % templates.length];
    const labelOffset = i % 4;
    const options = base.options.map((text, index) => ({ id: String.fromCharCode(97 + index), text }));
    generated.push({
      prompt: `${base.prompt} (${i + 1})`,
      options,
      correctOptionId: base.correct,
      topic: `${normalizedTopic} · Practice`,
      difficulty: i % 3 === 0 ? "Hard" : i % 2 === 0 ? "Medium" : "Easy",
      imageUrl: "",
      tableData: null,
    });
  }
  return generated;
}

function render() {
  if (state.view === "home") {
    app.innerHTML = renderHome();
    loadHomePreview();
    if (!state.homePreviewInterval) state.homePreviewInterval = setInterval(() => {
      if (state.view !== "home" || state.homeLiveUnavailable) return;
      loadHomePreview();
    }, 15000);
  }
  else if (state.view === "join") app.innerHTML = renderJoin();
  else if (state.view === "hostLogin") app.innerHTML = renderHostLogin();
  else if (state.view === "hostDashboard") app.innerHTML = renderHostDashboard();
  else if (state.view === "hostEditor") app.innerHTML = renderEditor();
  else if (state.view === "hostLobby") app.innerHTML = renderRoomLobby(true);
  else if (state.view === "playerLobby") app.innerHTML = renderRoomLobby(false);
  else if (state.view === "playerGame") app.innerHTML = renderPlayerGame();
  else if (state.view === "hostGame") app.innerHTML = renderHostGame();
  else if (state.view === "leaderboard") app.innerHTML = renderLeaderboard();
  else if (state.view === "final") app.innerHTML = renderFinal();
  else if (state.view === "performance") app.innerHTML = renderPerformance();
  else if (state.view === "account") app.innerHTML = renderAccount();
  else if (state.view === "accountLoading") app.innerHTML = `<section class="auth-screen auth-loading" role="status"><div class="auth-background" aria-hidden="true"><img src="https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=2000&q=85" alt="" fetchpriority="high" /></div><span class="account-monogram">AQ</span><p>Checking your AptiQuiz session…</p></section>`;
  else if (state.view === "league") { renderLeague(); }
  navActive();
}

function startTimer() {
  stopTimer();
  const update = () => {
    const question = state.question || state.hostQuestion;
    if (!question) return;
    const remaining = Math.max(0, question.endsAt - (Date.now() + state.serverOffset));
    const seconds = Math.ceil(remaining / 1000);
    const label = document.querySelector("[data-timer-label]");
    const fill = document.querySelector("[data-timer-fill]");
    if (label) label.textContent = `${seconds}s`;
    if (label) label.classList.toggle("urgent", seconds <= 5);
    if (fill) {
      const percent = Math.max(0, Math.min(100, remaining / (question.endsAt - question.startedAt) * 100));
      fill.style.width = `${percent}%`;
      fill.classList.toggle("low", seconds <= 7);
      fill.parentElement?.setAttribute("aria-valuenow", String(Math.round(percent)));
    }
  };
  update();
  state.timerInterval = setInterval(update, 200);
}

function stopTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

async function openHost() {
  state.role = "host";
  if (!state.hostToken) {
    setView("hostLogin");
    return;
  }
  try {
    await loadSets();
    ensureSocket(state.hostToken);
    setView("hostDashboard");
  } catch (error) {
    state.hostToken = "";
    localStorage.removeItem("aqHostToken");
    setView("hostLogin");
    showToast(error.message, "error");
  }
}

function startJoin(code, displayName, college) {
  const saved = JSON.parse(localStorage.getItem(`aqPlayer:${code}`) || "null");
  state.role = "player";
  state.playerName = displayName;
  state.college = college;
  state.currentCode = code;
  state.resumeToken = saved?.resumeToken || "";
  state.pendingJoin = { code, displayName: saved?.displayName || displayName, college: saved?.college || college, resumeToken: state.resumeToken || undefined };
  const socket = ensureSocket("");
  if (socket.connected) socket.emit("room:join", state.pendingJoin, handleJoinResult);
  else showMessage("joinMessage", "Connecting to the room…");
}

function newQuestionDraft(question = null, index = null) {
  state.editingQuestionIndex = index;
  render();
  if (!question) return;
  document.getElementById("qPrompt").value = question.prompt;
  [0,1,2,3].forEach((i) => { document.getElementById(`opt${i}`).value = question.options[i]?.text || ""; });
  document.getElementById("correctOption").value = question.correctOptionId;
  document.getElementById("qTopic").value = question.topic;
  document.getElementById("qDifficulty").value = question.difficulty;
  document.getElementById("qImage").value = question.imageUrl || "";
  document.getElementById("qTable").value = question.tableData ? JSON.stringify(question.tableData) : "";
}

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "go-home") setView("home");
    else if (action === "refresh-preview") {
      state.homeLiveUnavailable = false;
      loadHomePreview();
    }
    else if (action === "share-results") {
      const player = state.finalResults?.players.find((entry) => entry.playerId === state.playerId);
      const rank = state.finalResults?.players.findIndex((entry) => entry.playerId === state.playerId) + 1;
      const shareText = player ? `${player.name} finished #${rank} in AptiQuiz with ${player.score} points and ${player.accuracy}% accuracy.` : "We just finished an AptiQuiz round!";
      if (navigator.share) await navigator.share({ title: "AptiQuiz result", text: shareText });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(shareText); showToast("Result copied to clipboard.", "success"); }
      else showToast(shareText);
    }
    else if (action === "go-join") setView("join");
    else if (action === "go-performance") setView("performance");
    else if (action === "open-account") { state.authMode = "login"; setView("account"); }
    else if (action === "toggle-auth") { state.authMode = state.authMode === "login" ? "signup" : "login"; setView("account"); }
    else if (action === "forgot-password") showMessage("accountMessage", "Password reset is not configured yet. Contact your AptiQuiz administrator to reset your account password.", "error");
    else if (action === "account-logout") {
      try { await accountApi("/api/account/logout", { method: "POST" }); } catch {}
      state.accountToken = "";
      state.account = null;
      localStorage.removeItem("aqAccountToken");
      setView("account");
      showToast("Signed out.", "success");
    }
    else if (action === "go-host") await openHost();
    else if (action === "go-league") { state.leaguePeriod = "week"; setView("league"); }
    else if (action === "league-period") { state.leaguePeriod = button.dataset.period; renderLeague(); }
    else if (action === "retry-league") renderLeague();
    else if (action === "generate-ai-home") {
      openAiGenerator();
    } else if (action === "generate-ai") {
      generateAiQuestionsFromPrompt();
    } else if (action === "new-host-room") {
      localStorage.removeItem("aqHostRoom");
      state.currentCode = "";
      state.lobby = null;
      state.hostQuestion = null;
      await loadSets();
      setView("hostDashboard");
    } else if (action === "leave-room") {
      if (state.view === "playerGame" && !window.confirm("Leave this quiz now? Answers already recorded will remain on the server.")) return;
      localStorage.removeItem("aqLastRoom");
      if (state.currentCode) localStorage.removeItem(`aqPlayer:${state.currentCode}`);
      state.role = null;
      state.currentCode = "";
      state.playerId = "";
      state.resumeToken = "";
      state.socket?.disconnect();
      state.socket = null;
      setView("home");
    }
    else if (action === "start-game") {
      state.socket.emit("game:start", { code: state.currentCode }, (result) => {
        if (!result?.ok) showMessage("lobbyMessage", result?.error || "Could not start the quiz.", "error");
      });
    } else if (action === "next-question") {
      state.socket.emit("game:next", { code: state.currentCode }, (result) => {
        if (!result?.ok) showToast(result?.error || "Could not continue.", "error");
      });
    } else if (action === "end-game") {
      if (!window.confirm("End this quiz for everyone and show final results?")) return;
      state.socket.emit("game:end", { code: state.currentCode }, (result) => {
        if (!result?.ok) showToast(result?.error || "Could not end the quiz.", "error");
      });
    } else if (action === "export-results") {
      const response = await fetch(`/api/host/rooms/${encodeURIComponent(state.currentCode)}/export.csv`, {
        headers: { authorization: `Bearer ${state.hostToken}` },
      });
      if (!response.ok) throw new Error("Could not export these room results.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `aptiquiz-${state.currentCode}-results.csv`;
      link.click();
      URL.revokeObjectURL(url);
      showToast("Results exported.", "success");
    } else if (action === "create-room") {
      state.selectedSetId = document.getElementById("setSelect")?.value || "";
      if (!state.selectedSetId) return showMessage("hostMessage", "Create or select a question set first.", "error");
      if (!state.socket?.connected) ensureSocket(state.hostToken);
      const college = document.getElementById("roomCollege")?.value.trim() || "";
      state.socket.emit("room:create", { setId: state.selectedSetId, college }, (result) => {
        if (!result?.ok) return showMessage("hostMessage", result?.error || "Could not create room.", "error");
        state.lobby = result.lobby;
        state.currentCode = result.lobby.code;
        localStorage.setItem("aqHostRoom", state.currentCode);
        setView("hostLobby");
      });
    } else if (action === "host-logout") {
      state.hostToken = "";
      state.role = null;
      localStorage.removeItem("aqHostToken");
      localStorage.removeItem("aqHostRoom");
      state.socket?.disconnect();
      state.socket = null;
      setView("home");
    } else if (action === "new-set") {
      state.editingSet = { title: "", questions: [] };
      state.editingQuestionIndex = null;
      setView("hostEditor");
    } else if (action === "cancel-editor") {
      state.editingSet = null;
      await loadSets();
      setView("hostDashboard");
    } else if (action === "edit-set") {
      const data = await api(`/api/host/sets/${button.dataset.id}`);
      state.editingSet = data.set;
      state.editingQuestionIndex = null;
      setView("hostEditor");
    } else if (action === "duplicate-set") {
      const data = await api(`/api/host/sets/${button.dataset.id}`);
      const copy = data.set;
      const result = await api("/api/host/sets", { method: "POST", body: JSON.stringify({ title: `${copy.title} copy`, questions: copy.questions }) });
      await loadSets();
      showToast(`Created “${result.set.title}”.`, "success");
      render();
    } else if (action === "edit-question") {
      const index = Number(button.dataset.index);
      newQuestionDraft(state.editingSet.questions[index], index);
    } else if (action === "remove-question") {
      state.editingSet.questions.splice(Number(button.dataset.index), 1);
      state.editingQuestionIndex = null;
      render();
    } else if (action === "move-question") {
      const index = Number(button.dataset.index);
      const next = index + Number(button.dataset.delta);
      if (next >= 0 && next < state.editingSet.questions.length) {
        [state.editingSet.questions[index], state.editingSet.questions[next]] = [state.editingSet.questions[next], state.editingSet.questions[index]];
        render();
      }
    } else if (action === "save-set") {
      await saveSet();
    } else if (action === "answer") {
      if (!state.socket?.connected || state.hasAnswered) return;
      state.hasAnswered = true;
      state.answerConfirmed = false;
      state.selectedOptionId = button.dataset.option;
      render();
      state.socket.emit("answer:submit", { questionIndex: state.question.questionIndex, optionId: button.dataset.option }, (result) => {
        if (!result?.ok) {
          state.hasAnswered = false;
          state.answerConfirmed = false;
          state.selectedOptionId = "";
          render();
          showToast(result?.error || "Answer was not accepted.", "error");
        }
      });
    }
  } catch (error) {
    showToast(error.message, "error");
  }
});

document.addEventListener("keydown", (event) => {
  if (state.view !== "playerGame" || state.hasAnswered || event.altKey || event.ctrlKey || event.metaKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "")) return;
  const index = /^[1-4]$/.test(event.key) ? Number(event.key) - 1 : /^[a-d]$/i.test(event.key) ? event.key.toLowerCase().charCodeAt(0) - 97 : -1;
  if (index < 0) return;
  document.querySelectorAll(".option-button:not(:disabled)")[index]?.click();
});

async function saveSet() {
  const title = document.getElementById("setTitle")?.value.trim();
  if (!title) return showMessage("editorMessage", "Add a title for this question set.", "error");
  if (!state.editingSet.questions.length) return showMessage("editorMessage", "Add at least one question before saving.", "error");
  try {
    const body = { title, questions: state.editingSet.questions };
    const url = state.editingSet.id ? `/api/host/sets/${state.editingSet.id}` : "/api/host/sets";
    const result = await api(url, { method: state.editingSet.id ? "PUT" : "POST", body: JSON.stringify(body) });
    state.selectedSetId = result.set.id;
    state.editingSet = null;
    await loadSets();
    setView("hostDashboard");
    showToast("Question set saved.", "success");
  } catch (error) {
    showMessage("editorMessage", error.message, "error");
  }
}

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "joinForm") {
      const code = form.code.value.trim();
      if (!/^\d{6}$/.test(code)) return showMessage("joinMessage", "Enter the six-digit room code.", "error");
      startJoin(code, form.displayName.value.trim(), form.college.value.trim());
    } else if (form.id === "hostLoginForm") {
      const result = await api("/api/host/session", { method: "POST", body: JSON.stringify({ accessCode: form.accessCode.value }) });
      state.hostToken = result.token;
      state.role = "host";
      localStorage.setItem("aqHostToken", state.hostToken);
      ensureSocket(state.hostToken);
      await loadSets();
      setView("hostDashboard");
    } else if (form.id === "questionDraftForm") {
      const options = [0,1,2,3].map((i, index) => ({ id: String.fromCharCode(97 + index), text: document.getElementById(`opt${i}`).value.trim() }));
      let tableData;
      const rawTable = document.getElementById("qTable").value.trim();
      if (rawTable) tableData = JSON.parse(rawTable);
      const question = {
        prompt: document.getElementById("qPrompt").value.trim(),
        options,
        correctOptionId: document.getElementById("correctOption").value,
        topic: document.getElementById("qTopic").value,
        difficulty: document.getElementById("qDifficulty").value,
        imageUrl: document.getElementById("qImage").value.trim(),
        tableData,
      };
      if (state.editingQuestionIndex == null) state.editingSet.questions.push(question);
      else state.editingSet.questions[state.editingQuestionIndex] = question;
      state.editingQuestionIndex = null;
      render();
      showToast("Question added to the set.", "success");
    }
  } catch (error) {
    const messageId = form.id === "hostLoginForm" ? "hostLoginMessage" : form.id === "questionDraftForm" ? "editorMessage" : "joinMessage";
    showMessage(messageId, error.message, "error");
  }
});

document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", async () => {
  if (button.dataset.nav === "home") setView("home");
  else if (button.dataset.nav === "join") setView("join");
  else if (button.dataset.nav === "host") await openHost();
  else if (button.dataset.nav === "league") { state.leaguePeriod = "week"; setView("league"); }
  else if (button.dataset.nav === "performance") setView("performance");
  else if (button.dataset.nav === "account") { state.authMode = "login"; setView("account"); }
}));

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "accountForm") return;
  event.preventDefault();
  const form = event.target;
  const isSignup = state.authMode === "signup";
  const body = {
    password: form.password.value,
  };
  if (isSignup) {
    body.displayName = form.displayName.value.trim();
    body.username = form.username.value.trim();
    body.email = form.identifier.value.trim();
    body.college = form.college.value.trim();
  } else body.identifier = form.identifier.value.trim();
  try {
    const session = await accountApi(isSignup ? "/api/account/signup" : "/api/account/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.accountToken = session.token;
    state.account = session.account;
    localStorage.setItem("aqAccountToken", session.token);
    setView("home");
    showToast(isSignup ? "Account created." : "Signed in.", "success");
  } catch (error) {
    showMessage("accountMessage", error.message, "error");
  }
});

function openAiGenerator() {
  state.aiTopic = localStorage.getItem("aqAiTopic") || state.aiTopic || "Aptitude";
  if (!state.editingSet) {
    state.editingSet = { title: "AI quiz set", questions: [] };
  }
  setView("hostEditor");
}

function generateAiQuestionsFromPrompt() {
  const input = document.getElementById("aiTopicInput");
  const count = document.getElementById("aiQuestionCount");
  const topic = input?.value.trim() || state.aiTopic || "Aptitude";
  const number = Number(count?.value || 5);
  state.aiTopic = topic;
  localStorage.setItem("aqAiTopic", topic);
  const questions = generateAiQuizSet(topic, number);
  state.editingSet = {
    title: `${topic} smart quiz`,
    questions,
  };
  state.editingQuestionIndex = null;
  setView("hostEditor");
  showToast(`Generated ${questions.length} AI quiz questions.`, "success");
}

async function restoreAccountSession() {
  if (!state.accountToken) return;
  try {
    const { account } = await accountApi("/api/account/me");
    state.account = account;
    setView("home");
  } catch {
    state.accountToken = "";
    state.account = null;
    localStorage.removeItem("aqAccountToken");
    setView("account");
  }
}

render();
restoreAccountSession();
const previousPlayerRoom = JSON.parse(localStorage.getItem("aqLastRoom") || "null");
if (state.account && previousPlayerRoom?.code && previousPlayerRoom?.resumeToken) {
  startJoin(previousPlayerRoom.code, previousPlayerRoom.displayName, previousPlayerRoom.college || "");
}
