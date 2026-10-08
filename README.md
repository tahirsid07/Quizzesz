# AptiQuiz

## 1. What it does

AptiQuiz is a mobile-friendly, real-time multiplayer aptitude quiz. A host manages question sets, assigns an official college to each room, and opens it; players join with a six-digit code, answer timed questions, and see round and final results. The seeded demo set contains five questions.

## 2. Problem Statement Number

**Problem Statement 3 — AptiQuiz.** This implementation covers the central multiplayer quiz flow and a basic college league.

## 3. Done / Left / Plan

| Requirement | Status | Code / evidence | Demo ready? |
|---|---|---|---|
| Host question sets, editing, reorder, duplicate, topic/difficulty, image URL and table data | Implemented | `server/index.mjs`, `server/db.mjs`, `public/app.js` | Yes |
| Six-digit rooms, lobby, join and 50-player room cap | Implemented | `server/index.mjs`; capacity integration test | Yes |
| Server-timed live rounds, answer validation and round transitions | Implemented | `server/game.mjs` | Yes |
| Server-side accuracy/speed scoring and live/final results | Implemented | `server/game.mjs`, `server/db.mjs` | Yes |
| College and player league aggregation | Implemented using the host-selected college for each room | `GET /api/league` | Yes |
| Question-level host CSV export | Implemented for a room's owning host | `GET /api/host/rooms/:code/export.csv` | Yes |
| Player accounts | Email/username sign-up and login; scrypt password hashes | `/api/account/*` | Yes |
| Option shuffle, hidden answers, late/duplicate rejection | Implemented | `server/game.mjs`; integration tests | Yes |
| Rejoin after refresh or temporary reconnect | Implemented with a resume token | `server/index.mjs`, `public/app.js`; reconnect tests | Yes |
| Network-delay allowance | Basic bounded compensation; see section 6 | `server/index.mjs`, `server/game.mjs` | Yes, explain the cap |
| 50-player simulation | Passed locally for five rounds; see section 10 | `scripts/loadtest.mjs` | Yes |
| Public deployment and live URL | **Not done** | No hosting account, service, or URL is configured | No |

**Plan:** deploy to one always-on Node.js service with a persistent volume, configure the host access code and allowed origin, then repeat the browser and load checks against the public deployment. The current database and Socket.IO state are designed for one server process; horizontal scaling needs a shared database and Socket.IO adapter.

## 4. Architecture and Why

- **Frontend:** plain HTML, CSS and browser JavaScript served by Express. This keeps the demo easy to install and run without a frontend build step.
- **Backend:** Node.js and Express serve the app and validated host/league APIs.
- **Realtime:** Socket.IO carries lobby changes, questions, answers, leaderboards and reconnection state.
- **Database:** Node's built-in `node:sqlite` persists sets, rooms, players and answers without an external database service.
- **Validation:** Zod validates HTTP and Socket.IO inputs.

This is a compact single-process hackathon MVP. It does not use the initially suggested Next.js, TypeScript, PostgreSQL or Prisma stack. SQLite needs a persistent disk in deployment, and this implementation is not configured for multiple server instances.

## 5. What We Added

- Host access-code sign-in, question-set authoring, editing, ordering and duplication.
- Six-digit room codes, lobby updates and a configurable capacity capped at 50.
- Per-player option shuffling; correct answers are sent only after the round ends.
- Server-owned question deadlines, answer acceptance and score calculation.
- Round leaderboard with rank movement, accuracy and average response time; final topic results.
- Reconnection tokens for players and host room resumption.
- A college league endpoint using host-selected room affiliation and responsive player/host screens.
- Host-authorized CSV export with question, topic, difficulty, player, answers, correctness, response time and points.
- Player sign-up/sign-in using username or email with salted scrypt password hashing.
- Health endpoint at `/api/health` and an isolated 50-client simulation.

## 6. How to Run It

### Requirements

- Node.js **22.13 or later** (uses the built-in `node:sqlite` module and `--env-file-if-exists`).
- pnpm, available through Corepack in current Node distributions.

### Start locally

From this directory:

```sh
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env` and replace `HOST_ACCESS_CODE` with a private value, then run:

```sh
corepack pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Create a player account or sign in; the main site is behind the account gate. Select **Host**, sign in using the access code, choose the seeded question set, enter the room's official college, and create a room. Open another browser or phone, choose **Join quiz**, and join with the displayed six-digit code. The host starts and advances the quiz. College scores are attributed to the college selected by the host for that room, not the optional college text entered by each player.

The production command is `corepack pnpm start`. There is no separate frontend build step.

### 3-minute demo flow

1. On the host laptop, open `http://localhost:3000`, sign in, select **Campus Aptitude Sprint**, and create a room. Say: “The host controls the quiz and the server is the scoring referee.”
2. On two phones (or separate browser windows), join using the room code and different college names. Show the lobby updating on the host.
3. Start the quiz. Show the same prompt and server deadline on both phones. Have one player answer quickly and the other wait briefly before answering. Correct answers earn 100 base points plus up to 900 speed points; a wrong answer earns 0 points with no deduction.
4. Show the answer reveal and leaderboard; point out scores, accuracy and rank movement. Advance to final results; the host can export the round data as CSV.
5. Select **League** to show college totals. Refresh a player tab during a later round if time allows; its saved resume token restores that player's state.

If the demo room is stale, use **Host → New room**. If a player cannot reconnect, use the same browser profile so its local resume token remains available. Keep the local server terminal open throughout.

## 7. Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `HOST_ACCESS_CODE` | Shared secret required for host sign-in | Empty; host sign-in is unavailable |
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind address for the standalone server | `0.0.0.0` |
| `DB_PATH` | SQLite database file | `./data/aptiquiz.sqlite` |
| `QUESTION_SECONDS` | Duration of each question | `30` |
| `MAX_PLAYERS_PER_ROOM` | Room capacity, always capped at 50 | `50` |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed by Socket.IO in production | Restrictive in production; set the deployed origin explicitly |

The app loads `.env` through Node's environment-file option. `.env` and SQLite files are ignored by Git.

Player accounts are stored in the same SQLite database. Passwords use scrypt with a random salt per account. A successful login creates a seven-day bearer session held in server memory; restarting the server expires those sessions. Password reset and Google OAuth are not configured.

## 8. Tools and AI Used

- Codex assisted with implementation, debugging and the test/load-test pass.
- Runtime and packages: Node.js, Express, Socket.IO, `node:sqlite`, Zod and pnpm.
- Verification: Node's built-in test runner and a Socket.IO client simulation.
- No external AI API, cloud database, or hosting service is connected.

## 9. Who It Is For

Students and campus groups who want to practice quantitative aptitude, logical reasoning, verbal questions and data interpretation together. Hosts can run a classroom or hackathon quiz; players can compare their results and college totals.

## 10. Testing

Run the checks from this directory:

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm loadtest
```

`check` performs JavaScript syntax checks and runs the Node test suite. There is no TypeScript, lint, or frontend build configuration in this plain-JavaScript app, so no separate typecheck/lint/build command is claimed. The integration tests cover host authorization, invalid option IDs, authoritative scoring and answer reveal, duplicate answers, player resume, leaderboard-only resume, and room capacity.

## 11. 50-Player Load Test

Run:

```sh
corepack pnpm loadtest
```

The script starts an isolated server with a temporary SQLite file, assigns its room to **AptiQuiz Load Test College**, joins 50 Socket.IO clients, plays five rounds, checks synchronized questions and answer concealment, submits answers concurrently, verifies 50 leaderboard/final rows and the room-owned college league result, then removes the temporary database. College league attribution comes from the college the host assigns to the room; players' college profile text is not used for league totals.


**Verified final local run:** passed with 50 players and five questions. All clients joined in 182 ms; the full simulation took 1,357 ms; each round produced 50 leaderboard rows and final results contained 50 players. The league had one row for the room's host-assigned college. These are machine-local timings, not a production capacity guarantee. The script does not test browser rendering, real mobile networks, multiple server instances, or sustained traffic beyond this one room.
## 12. Security / Anti-Cheating

- The server owns room state, deadlines, answer validation and scoring. The browser submits an option ID; it cannot submit a score.
- Correct-option data is omitted from active questions and revealed with the round leaderboard.
- Options are shuffled independently for each player and question.
- Duplicate and late answers are rejected. Host-only actions require a valid host session and room ownership.
- Inputs are validated with Zod; displayed user content is HTML-escaped.
- The timer starts and ends using server timestamps; the browser countdown is display-only. When an answer arrives, the server records its own receive time. It estimates network delay from recent server-ping round-trip measurements, subtracts up to half the median RTT, and caps this adjustment at **150 ms**. This gives a small allowance when two players answer at about the same time but their packets arrive at different speeds. It is an estimate, not proof of the physical tap time. A player's device clock never decides correctness or score.
- Correct answers earn 100 base points plus up to 900 points based on server-measured response time. Wrong answers earn 0 points with no deduction. The rule is shown to players during live play.

This is basic quiz integrity, not proctoring. It cannot prevent collusion, a player sharing answers, or a user inspecting their own browser. The host access code is shared by all hosts, player accounts do not verify real-world identity, and rate limiting is not configured.

## 13. Reconnection

On first join, the server creates a high-entropy resume token. The browser saves it in local storage and resubmits it after refresh or Socket.IO reconnect. The server finds the existing room player, preserves their score, and sends the current question (including whether it was already answered), leaderboard, or final result. Tests cover reconnecting into a live leaderboard and preserving a single player row.

The host session and active timers live in server memory. Restarting the server invalidates host sessions and interrupts active rounds; player rows and completed answer data remain in SQLite.

## 14. Deployment

The Vercel project serves the static frontend. Its `/api/*` requests are proxied to a single-process Node service, while Socket.IO connects directly to that service.

This repository includes a Render Blueprint (`render.yaml`) for the free web service and a Vercel rewrite (`vercel.json`) for HTTP API calls. The free backend uses SQLite on temporary storage: accounts, quiz data, and room state can be lost whenever Render restarts, redeploys, or spins down the service after 15 minutes without traffic. The free service may take about a minute to wake up. This setup has no hosting charge, but it is suitable only as a temporary/demo deployment. Durable accounts require a persistent database or paid persistent disk.

Deployment steps:

1. Create the Render service from this repository's Blueprint.
2. Confirm the service hostname is `https://quizzesz-api-tahirsid07.onrender.com`. If it differs, update the origin in `vercel.json` and `public/index.html`.
3. Confirm `ALLOWED_ORIGINS` is `https://quizzesz.vercel.app`.
4. Deploy the updated `main` branch to Vercel. Check `/api/health`, account sign-in, and a Socket.IO connection.
5. The generated `HOST_ACCESS_CODE` is available in Render's environment settings for host sign-in.

Use one backend process: host sessions, active rounds, and timers live in process memory.

## 15. Limitations

- No permanent public deployment; quick-tunnel URLs are temporary and process-bound.
- Single-process SQLite design; no horizontal scaling or database migration framework.
- Host access uses a shared access code. Player accounts have no password reset, email verification, or real-world identity verification.
- College league affiliation is selected by the room host and is not institution-verified.
- Host sessions and live round timers do not survive a server restart.
- Image questions use an external image URL; uploads are not implemented.
- The 50-player result is a local functional simulation, not a production capacity guarantee or network benchmark.
- Accessibility and mobile layout have been implemented with semantic controls and responsive CSS, but no formal accessibility audit or broad device matrix has been run.
- Current automated coverage is focused on server behavior; there is no browser end-to-end suite.

