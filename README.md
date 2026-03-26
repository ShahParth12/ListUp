# ListUp

A real-time multiplayer word-list party game. Create a room, share the code, and play with up to **12 people**.

## Rules

- Each round, a **letter** is chosen and **12 categories** are shown.
- You have **2 minutes** to write one answer per category. Every answer must **start with the round letter** (words like "A", "An", "The" don’t count). The round ends when **everyone has submitted** or time runs out.
- Answers are validated: they must **fit the category** and start with the letter. **Unique** valid answers get **1 point**; duplicates or invalid answers get **0**.
- **Validation:** (1) The server checks the starting letter. (2) Optional: set `OPENAI_API_KEY` to use AI to check if an answer fits the category. (3) During scoring, players can **challenge** any +1 answer they think doesn’t fit; if 2+ players challenge (or 1 in a 2-player game), the point is removed.
- After **3 rounds**, the player with the most points wins.

## How to run (local)

Requires **PostgreSQL** and a `DATABASE_URL` (see `.env.example`).

```bash
cp .env.example .env
# Edit .env: set DATABASE_URL to your Postgres (Neon free tier, Docker, etc.)

npm install
npx prisma migrate dev   # first time: applies migrations to your DB
npm start
```

Room state, players, scores, answers (by stable seat), and correction data are persisted so a server restart can restore in-progress games (players reconnect with the same name as before).

Open **http://localhost:3000** in your browser.

### Local Postgres with Docker (optional)

```bash
docker run --name listup-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
# In .env:
# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
```

## Deploy (Neon + Render)

1. **Neon** — Create a project → copy the **connection string** → use as `DATABASE_URL` (add `?sslmode=require` if Neon’s UI doesn’t already).
2. **Render** — New **Web Service** → connect this Git repo.
   - **Build command:** `npm install && npx prisma generate && npx prisma migrate deploy`
   - **Start command:** `npm start`
   - **Environment:** add `DATABASE_URL` (and `OPENAI_API_KEY` if you use AI validation).
3. Push to GitHub; Render deploys on each push.

**Note:** Render’s free tier **spins down** when idle; the first request after idle can take ~30–60s. Paid instances stay warm.

## How to play

1. **Create a room** – Enter your name and click “Create room”. You’ll get a 6-character room code.
2. **Share the code** – Others open the same URL, enter the code and their name, and click “Join room” (max 12 players).
3. **Start the game** – Once at least 2 players are in, the host clicks “Start game”.
4. **Play each round** – Fill in one answer per category starting with the given letter. Click “Submit answers”. The round ends when everyone has submitted or the 2-minute timer ends.
5. **See scores** – After each round, answers are checked (letter + category fit). You can **Challenge** any +1 answer that doesn’t fit the category; with enough challenges the point is removed. The host starts the next round (or the game ends after round 3).

## Optional: AI category validation

To have the server automatically check whether answers fit the category (using OpenAI), set:

```bash
export OPENAI_API_KEY=sk-...
npm start
```

If unset, only the starting letter is checked automatically; players can still **Challenge** answers during scoring.

## Tech

- **Node.js** + **Express** – HTTP server and static files
- **Prisma** + **PostgreSQL** – Persistent rooms, players, scores, and round payload (no login; names unchanged)
- **Socket.io** – Real-time rooms, join/leave, game events
- **OpenAI** (optional) – Category-fit validation when `OPENAI_API_KEY` is set
- Vanilla JS frontend – No build step

## Project structure

- `server.js` – Express + Socket.io server, room and game logic
- `prisma/schema.prisma` – Room + RoomPlayer models
- `lib/roomDb.js` – Save/load rooms via Prisma
- `validateCategory.js` – Optional OpenAI-based “does this answer fit the category?” check
- `categories.js` – Category lists and letter/round helpers
- `public/` – Static frontend (HTML, CSS, JS)
