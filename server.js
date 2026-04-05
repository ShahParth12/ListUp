const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { randomUUID, randomInt } = require("crypto");
const { QUESTION_BANK, LETTERS } = require("./categories");
const {
  queueSave,
  loadAllRooms,
  deleteRoomFromDb,
  syncHostSocketId,
  cancelPendingSave,
  flushAllPendingSaves
} = require("./lib/roomDb");
const { withRoomLock } = require("./lib/roomLock");
const { clampAnswersPayload } = require("./lib/socketValidators");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/** Global lock so code allocation + insert cannot race with another create_room. */
const CREATE_ROOM_LOCK = "\0create_room";
function runRoomTask(code, fn) {
  return withRoomLock(code, fn).catch((e) =>
    console.error("[ListUp] room task failed", code, e && e.message ? e.message : e)
  );
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const MAX_PLAYERS_PER_ROOM = 12;
const DEFAULT_ROUND_TIME_SECONDS = 120; // 2 minutes
/** Prepended to each round so clients can show 3-2-1 without shortening play time. */
const ROUND_START_COUNTDOWN_MS = 3000;
const ALLOWED_ROUND_TIMES = [60, 90, 120];
const ALLOWED_QUESTION_COUNTS = [8, 10, 12];
const DEBUG_SCORING_LOGS = true;

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Random cycle each time: shuffled[i] corrects shuffled[(i+1) % n] (by seatId). */
function assignRandomCorrectionRing(players) {
  const targets = {};
  const list = shuffleArray(players);
  const n = list.length;
  if (n < 2) return targets;
  for (let i = 0; i < n; i++) {
    targets[list[i].seatId] = list[(i + 1) % n].seatId;
  }
  return targets;
}

function playerLabel(p) {
  if (!p) return "unknown";
  const flags = [
    p.waitingForNextRound ? "waiting" : null,
    p.disconnected ? "disconnected" : null
  ].filter(Boolean);
  return `${p.name}(${p.id.slice(0, 6)}${flags.length ? `;${flags.join(",")}` : ""})`;
}

function roomPlayersSnapshot(room) {
  return (room.players || []).map((p) => `${playerLabel(p)} score=${p.score ?? 0}`).join(" | ");
}

function logRoom(room, stage, details = {}) {
  if (!DEBUG_SCORING_LOGS) return;
  const payload = {
    stage,
    room: room.roomCode,
    phase: room.phase,
    round: room.round,
    players: roomPlayersSnapshot(room),
    ...details
  };
  console.log(`[LISTUP] ${JSON.stringify(payload)}`);
}

function personalizeCategoriesForRoom(room) {
  if (!room || !Array.isArray(room.categories)) return;
  const playerNames = (room.players || []).map((p) => p.name).filter(Boolean);
  if (!playerNames.length) return;

  room.categories = room.categories.map((cat) => {
    if (!cat || !cat.name || typeof cat.name !== "string") return cat;
    if (!cat.name.includes("<Name>")) return cat;
    const randomName = playerNames[Math.floor(Math.random() * playerNames.length)];
    return {
      ...cat,
      name: cat.name.replace(/<Name>/g, randomName)
    };
  });
}

const rooms = new Map(); // roomCode -> room state
const playerToRoom = new Map(); // socket.id -> roomCode

function newSeatId() {
  return randomUUID();
}

function isHostSocket(room, socketId) {
  const p = room.players.find((x) => x.id === socketId);
  return !!(p && room.hostSeatId && p.seatId === room.hostSeatId);
}

function persistRoom(room) {
  queueSave(room, recentlyDisconnected);
}
// When a player disconnects, we store { id, name, score } so rejoin_room can restore their score (same name = same person)
const recentlyDisconnected = new Map(); // roomCode -> Array<{ id, name, score }>, max 10 per room
const MAX_RECENT_DISCONNECTS = 10;

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const CATEGORY_BANK_BY_TYPE = {
  white: QUESTION_BANK.normal,
  blue: QUESTION_BANK.blue,
  red: QUESTION_BANK.red,
  green: QUESTION_BANK.green
};

/** Ensure room has per-type draw piles; each pile is shuffled remaining names for that type. */
function ensureCategoryPools(room) {
  if (!room.categoryPools || typeof room.categoryPools !== "object") {
    room.categoryPools = {};
  }
  for (const type of ["white", "blue", "red", "green"]) {
    if (!Array.isArray(room.categoryPools[type])) {
      room.categoryPools[type] = shuffleArray([...CATEGORY_BANK_BY_TYPE[type]]);
    }
  }
}

/** Draw n category names from one type’s pool; when the pool is empty it is refilled with a full shuffled bank. */
function takeNFromCategoryPool(room, type, n) {
  ensureCategoryPools(room);
  const bank = CATEGORY_BANK_BY_TYPE[type];
  const out = [];
  while (out.length < n) {
    if (!room.categoryPools[type].length) {
      room.categoryPools[type] = shuffleArray([...bank]);
    }
    const pool = room.categoryPools[type];
    const need = n - out.length;
    const take = Math.min(need, pool.length);
    out.push(...pool.splice(0, take));
  }
  return out;
}

/**
 * Pick this round’s categories without repeating a question until that type’s pool is exhausted and reshuffled.
 * Each round always uses neededWhites + 1 blue + 1 red + 1 green.
 */
function pickCategoriesForRoomFromPools(room) {
  const targetTotal = ALLOWED_QUESTION_COUNTS.includes(room.questionsPerRound) ? room.questionsPerRound : 12;
  const specialsCount = 3;
  const neededWhites = Math.max(0, targetTotal - specialsCount);
  const whites = takeNFromCategoryPool(room, "white", neededWhites);
  const blues = takeNFromCategoryPool(room, "blue", 1);
  const reds = takeNFromCategoryPool(room, "red", 1);
  const greens = takeNFromCategoryPool(room, "green", 1);
  const objects = [
    ...whites.map((name) => ({ name, type: "white" })),
    ...blues.map((name) => ({ name, type: "blue" })),
    ...reds.map((name) => ({ name, type: "red" })),
    ...greens.map((name) => ({ name, type: "green" }))
  ];
  return shuffleArray(objects);
}

/** Next round letter without repeating until every letter in LETTERS has been used, then reshuffle. */
function drawNextLetter(room) {
  if (!Array.isArray(room.letterPool) || room.letterPool.length === 0) {
    room.letterPool = shuffleArray([...LETTERS]);
  }
  return room.letterPool.shift();
}

const roundTimeouts = new Map(); // roomCode -> timeout handle

const HOST_CHANGE_VOTE_STALE_MS = 30 * 1000;

/** Active for host vote: in-round presence (not away, not waiting for next round). */
function activePlayersForHostVote(room) {
  return room.players.filter((p) => !p.waitingForNextRound && !p.disconnected);
}

/** Active players who may vote (host excluded); majority is computed over this set only. */
function activeNonHostVotersForHostVote(room) {
  return activePlayersForHostVote(room).filter((p) => p.seatId !== room.hostSeatId);
}

function pruneHostChangeVoteSeats(room) {
  if (!room.hostChangeVoteSeats) room.hostChangeVoteSeats = new Set();
  const active = activePlayersForHostVote(room);
  const act = new Set(active.map((p) => p.seatId));
  room.hostChangeVoteSeats = new Set(
    [...room.hostChangeVoteSeats].filter((s) => act.has(s) && s !== room.hostSeatId)
  );
}

function hostChangeVotePublicSnapshot(room) {
  const voters = activeNonHostVotersForHostVote(room);
  const voterSeats = new Set(voters.map((p) => p.seatId));
  const raw = room.hostChangeVoteSeats ? [...room.hostChangeVoteSeats] : [];
  const seats = raw.filter((s) => voterSeats.has(s));
  const needed = voters.length > 0 ? Math.floor(voters.length / 2) + 1 : 1;
  return { hostChangeVoteCount: seats.length, hostChangeVoteNeeded: needed, hostChangeVoteSeats: seats };
}

function clearHostChangeVoteRoomState(room) {
  if (room.hostChangeVoteTimerId) {
    clearTimeout(room.hostChangeVoteTimerId);
    room.hostChangeVoteTimerId = null;
  }
  room.hostChangeVoteSeats = new Set();
}

function scheduleHostChangeVoteStaleReset(room) {
  const code = room.roomCode;
  if (room.hostChangeVoteTimerId) clearTimeout(room.hostChangeVoteTimerId);
  room.hostChangeVoteTimerId = setTimeout(() => {
    room.hostChangeVoteTimerId = null;
    runRoomTask(code, () => {
      const r = rooms.get(code);
      if (!r) return;
      clearHostChangeVoteRoomState(r);
      persistRoom(r);
      if (r.phase === "correction") emitRoomStateToRoom(r);
      else io.to(code).emit("room_state", getRoomState(r));
    });
  }, HOST_CHANGE_VOTE_STALE_MS);
}

function removeRoomFromMemory(code) {
  const room = rooms.get(code);
  if (room) clearHostChangeVoteRoomState(room);
  const t = roundTimeouts.get(code);
  if (t) clearTimeout(t);
  roundTimeouts.delete(code);
  cancelPendingSave(code);
  rooms.delete(code);
  recentlyDisconnected.delete(code);
}

function endRoundForRoom(room) {
  if (room.phase !== "round") return;
  const code = room.roomCode;
  roundTimeouts.delete(code);

  // During round flow, disconnected players are still treated as active participants
  // unless they explicitly leave (or are removed by host from scoring screen).
  const activePlayers = room.players.filter((p) => !p.waitingForNextRound);
  activePlayers.sort((a, b) => a.id.localeCompare(b.id));
  const n = activePlayers.length;
  logRoom(room, "end_round_begin", {
    activePlayers: activePlayers.map(playerLabel),
    answersPresent: Object.keys(room.answers || {})
  });

  if (n < 2) {
    room.phase = "scoring";
    room.roundScores = room.categories.map((cat, catIndex) => ({
      category: typeof cat === "string" ? cat : cat.name,
      letter: room.letter,
      answers: room.players.map((p) => ({
        playerId: p.seatId,
        playerName: p.name,
        answer: (room.answers[p.seatId] && room.answers[p.seatId][catIndex]) || "",
        valid: false,
        points: 0,
        challenged: false,
        challengerNames: []
      }))
    }));
    room.scoringCategoryIndex = 0;
    persistRoom(room);
    io.to(code).emit("room_state", getRoomState(room));
    io.to(code).emit("round_scoring", {
      round: room.round,
      roundScores: room.roundScores,
      totals: room.players.map((p) => ({ id: p.id, seatId: p.seatId, name: p.name, score: p.score })),
      scoringCategoryIndex: 0
    });
    return;
  }

  // Ensure every active player has an answers array, even if they never submitted.
  if (!room.answers) room.answers = {};
  const categoryCount = (room.categories && room.categories.length) || 0;
  activePlayers.forEach((p) => {
    if (!Array.isArray(room.answers[p.seatId])) {
      room.answers[p.seatId] = new Array(categoryCount).fill("");
    } else if (room.answers[p.seatId].length < categoryCount) {
      room.answers[p.seatId] = [
        ...room.answers[p.seatId].slice(0, categoryCount),
        ...new Array(categoryCount - room.answers[p.seatId].length).fill("")
      ];
    } else if (room.answers[p.seatId].length > categoryCount) {
      room.answers[p.seatId] = room.answers[p.seatId].slice(0, categoryCount);
    }
  });

  room.phase = "correction";
  room.roundScores = null;
  room.scoringCategoryIndex = 0;
  room.correctionCategoryIndex = 0;
  room.corrections = {};
  room.correctionProgress = {};
  room.goldenBuzzers = {};
  room.correctionTargets = assignRandomCorrectionRing(activePlayers);
  logRoom(room, "correction_targets_assigned", {
    targets: Object.entries(room.correctionTargets).map(([correctorSeat, targetSeat]) => {
      const corrector = room.players.find((p) => p.seatId === correctorSeat);
      const target = room.players.find((p) => p.seatId === targetSeat);
      return `${playerLabel(corrector)} -> ${playerLabel(target)}`;
    })
  });

  persistRoom(room);
  // room_state + correction_start are both sent per-socket in emitRoomStateToRoom so every client (including late/rejoin) gets them
  emitRoomStateToRoom(room);
}

function getCategoryType(cat) {
  return typeof cat === "string" ? "white" : cat.type;
}

function normalizeCorrectionProgress(room) {
  if (!room.correctionProgress || typeof room.correctionProgress !== "object") {
    room.correctionProgress = {};
  }
}

/** Active, connected players who have someone to correct this round. */
function activeConnectedCorrectorSeats(room) {
  if (!room.correctionTargets) return [];
  return room.players.filter(
    (p) => !p.waitingForNextRound && !p.disconnected && room.correctionTargets[p.seatId]
  );
}

function isCorrectionSlotComplete(room, seatId, index) {
  const cats = room.categories;
  if (!cats || index < 0 || index >= cats.length) return false;
  const type = getCategoryType(cats[index]);
  const slot = room.correctionProgress?.[seatId]?.[String(index)];
  if (!slot || typeof slot !== "object") return false;
  if (type === "blue") {
    if (slot.notAnswered) return true;
    return slot.mark === "correct" || slot.mark === "wrong";
  }
  if (type === "red") {
    if (slot.common) return true;
    return slot.mark === "correct" || slot.mark === "wrong";
  }
  return slot.mark === "correct" || slot.mark === "wrong";
}

/** Submitted their full correction sheet — counts as done for any card for nav / ready tally. */
function hasSubmittedCorrections(room, seatId) {
  return !!(room.corrections && room.corrections[seatId]);
}

function isCorrectorReadyOnCurrentCard(room, seatId, curIdx) {
  if (hasSubmittedCorrections(room, seatId)) return true;
  return isCorrectionSlotComplete(room, seatId, curIdx);
}

function correctionCardProgressCounts(room, curIdx) {
  const seats = activeConnectedCorrectorSeats(room);
  const total = seats.length;
  const ready = seats.filter((p) => isCorrectorReadyOnCurrentCard(room, p.seatId, curIdx)).length;
  return { ready, total };
}

function correctionCanAdvanceNext(room) {
  const n = (room.categories && room.categories.length) || 0;
  if (n <= 0) return false;
  const cur = correctionCategoryIndexForRoom(room);
  if (cur >= n - 1) return false;
  const { ready, total } = correctionCardProgressCounts(room, cur);
  if (total <= 0) return true;
  return ready >= total;
}

function finishCorrectionAndGoToScoring(room) {
  // Score all round participants (including temporarily disconnected players),
  // while correction submission requirements remain "connected-only" elsewhere.
  const scoringPlayers = room.players.filter((p) => !p.waitingForNextRound);
  scoringPlayers.sort((a, b) => a.id.localeCompare(b.id));
  const n = scoringPlayers.length;
  logRoom(room, "finish_correction_begin", {
    activePlayers: scoringPlayers.map(playerLabel),
    correctionsBy: Object.keys(room.corrections || {})
  });

  const targetToCorrectorSeat = {};
  // Preserve original correction assignments for this round so disconnect/reconnect
  // during correction doesn't remap who corrected whom. Keys are seatIds.
  if (room.correctionTargets && Object.keys(room.correctionTargets).length > 0) {
    Object.entries(room.correctionTargets).forEach(([correctorSeat, targetSeat]) => {
      targetToCorrectorSeat[targetSeat] = correctorSeat;
    });
  } else {
    const fallbackRing = assignRandomCorrectionRing(scoringPlayers);
    Object.entries(fallbackRing).forEach(([correctorSeat, targetSeat]) => {
      targetToCorrectorSeat[targetSeat] = correctorSeat;
    });
  }

  const categoryTypes = room.categories.map(getCategoryType);
  const blueNotAnsweredByTarget = {};
  scoringPlayers.forEach((p) => {
    const correctorSeat = targetToCorrectorSeat[p.seatId];
    const correctionData = room.corrections[correctorSeat] && room.corrections[correctorSeat].corrections;
    const blueIndices = categoryTypes.map((t, i) => t === "blue" ? i : -1).filter((i) => i >= 0);
    blueNotAnsweredByTarget[p.seatId] = blueIndices.some((i) => correctionData && correctionData[i] && correctionData[i].notAnswered);
  });

  function pointsForCategory(correction, type) {
    const ticked = correction.mark === "correct";
    switch (type) {
      case "white": return ticked ? 1 : 0;
      case "blue": return ticked ? 1 : 0;
      case "red": return correction.common ? -3 : (ticked ? 3 : 0);
      case "green": return ticked ? 3 : 0;
      default: return ticked ? 1 : 0;
    }
  }

  room.roundScores = room.categories.map((cat, catIndex) => {
    const type = categoryTypes[catIndex];
    const catName = typeof cat === "string" ? cat : cat.name;
    const answers = scoringPlayers.map((p) => {
      const answerText = (room.answers[p.seatId] && room.answers[p.seatId][catIndex]) || "";
      const correctorSeat = targetToCorrectorSeat[p.seatId];
      const correctionData = room.corrections[correctorSeat] && room.corrections[correctorSeat].corrections;
      const correction = correctionData && correctionData[catIndex] ? correctionData[catIndex] : { mark: "wrong", notAnswered: false, common: false };
      const wholeRoundZero = blueNotAnsweredByTarget[p.seatId];
      const points = wholeRoundZero ? 0 : pointsForCategory(correction, type);
      if (DEBUG_SCORING_LOGS) {
        const corrector = room.players.find((x) => x.seatId === correctorSeat);
        console.log(`[LISTUP] ${JSON.stringify({
          stage: "score_item",
          room: room.roomCode,
          round: room.round,
          categoryIndex: catIndex,
          category: catName,
          type,
          target: playerLabel(p),
          corrector: playerLabel(corrector || null),
          answer: answerText,
          correction,
          wholeRoundZero,
          points
        })}`);
      }
      return {
        playerId: p.seatId,
        playerName: p.name,
        answer: answerText,
        valid: points > 0,
        points,
        challenged: false,
        challengerNames: []
      };
    });
    return {
      category: catName,
      type,
      letter: room.letter,
      answers
    };
  });

  scoringPlayers.forEach((p) => {
    const roundTotal = blueNotAnsweredByTarget[p.seatId] ? 0 : room.roundScores.reduce((sum, cat) => {
      const a = cat.answers.find((x) => x.playerId === p.seatId);
      return sum + (a && a.points != null ? a.points : 0);
    }, 0);
    p.score = (p.score ?? 0) + roundTotal;
    if (DEBUG_SCORING_LOGS) {
      console.log(`[LISTUP] ${JSON.stringify({
        stage: "score_total",
        room: room.roomCode,
        round: room.round,
        player: playerLabel(p),
        roundTotal,
        cumulative: p.score ?? 0
      })}`);
    }
  });

  room.phase = "scoring";
  room.scoringCategoryIndex = 0;
  room.correctionCategoryIndex = 0;
  delete room.corrections;
  delete room.correctionTargets;
  delete room.correctionProgress;
  delete room.goldenBuzzers;

  const code = room.roomCode;
  persistRoom(room);
  io.to(code).emit("room_state", getRoomState(room));
  io.to(code).emit("round_scoring", {
    round: room.round,
    roundScores: room.roundScores,
    totals: room.players.map((p) => ({ id: p.id, seatId: p.seatId, name: p.name, score: p.score })),
    scoringCategoryIndex: 0
  });
  logRoom(room, "round_scoring_emitted", {
    totals: room.players.map((p) => `${playerLabel(p)}=${p.score ?? 0}`)
  });
}

function correctionCategoryIndexForRoom(room) {
  const n = (room.categories && room.categories.length) || 0;
  let cci = typeof room.correctionCategoryIndex === "number" ? room.correctionCategoryIndex : 0;
  if (n <= 0) return 0;
  return Math.max(0, Math.min(cci, n - 1));
}

function clampCorrectionCategoryIndex(room) {
  room.correctionCategoryIndex = correctionCategoryIndexForRoom(room);
}

function getRoomState(room, forPlayerId) {
  syncHostSocketId(room);
  const players = room.players.map((p) => ({
    id: p.id,
    seatId: p.seatId,
    name: p.name,
    score: p.score ?? 0,
    waitingForNextRound: !!p.waitingForNextRound,
    disconnected: !!p.disconnected
  }));
  const activeRoundPlayers = room.players.filter((p) => !p.waitingForNextRound);
  const submittedPlayerIds =
    room.phase === "round" && room.answers
      ? activeRoundPlayers
          .filter((p) => Object.prototype.hasOwnProperty.call(room.answers, p.seatId))
          .map((p) => p.id)
      : [];
  const waitingPlayerIds = room.players.filter((p) => p.waitingForNextRound).map((p) => p.id);
  const answers = room.phase === "round" ? null : room.answers;
  const hv = hostChangeVotePublicSnapshot(room);
  const base = {
    roomCode: room.roomCode,
    hostId: room.hostId,
    hostSeatId: room.hostSeatId,
    hostChangeVoteCount: hv.hostChangeVoteCount,
    hostChangeVoteNeeded: hv.hostChangeVoteNeeded,
    hostChangeVoteSeats: hv.hostChangeVoteSeats,
    players,
    phase: room.phase,
    round: room.round,
    letter: room.letter,
    categories: room.categories,
    roundEndsAt: room.roundEndsAt,
    roundScores: room.roundScores,
    scoringCategoryIndex: room.scoringCategoryIndex ?? 0,
    roundSeconds: room.roundSeconds || DEFAULT_ROUND_TIME_SECONDS,
    questionsPerRound: room.questionsPerRound || 12,
    answers,
    submittedPlayerIds,
    waitingPlayerIds
  };
  if (room.phase === "round") {
    base.roundAnswersRequired = activeRoundPlayers.length;
    base.roundAnswersSubmitted = activeRoundPlayers.filter(
      (p) => room.answers && Object.prototype.hasOwnProperty.call(room.answers, p.seatId)
    ).length;
  }
  if (room.phase === "correction") {
    normalizeCorrectionProgress(room);
    const curIdx = correctionCategoryIndexForRoom(room);
    base.correctionCategoryIndex = curIdx;
    const { ready, total } = correctionCardProgressCounts(room, curIdx);
    base.correctionCurrentCardReady = ready;
    base.correctionCurrentCardTotal = total;
    base.correctionCanAdvanceNext = correctionCanAdvanceNext(room);
    base.goldenBuzzers =
      room.goldenBuzzers && typeof room.goldenBuzzers === "object" ? { ...room.goldenBuzzers } : {};
  }
  if (room.phase === "correction" && forPlayerId && room.correctionTargets) {
    const corrector = room.players.find((p) => p.id === forPlayerId);
    const targetSeatId = corrector ? room.correctionTargets[corrector.seatId] : null;
    if (targetSeatId) {
      const target = room.players.find((p) => p.seatId === targetSeatId);
      base.correctionTarget = {
        targetPlayerId: target ? target.id : null,
        targetPlayerName: (target && target.name) || "Someone",
        answers: room.categories.map((cat, i) => ({
          category: typeof cat === "string" ? cat : cat.name,
          type: typeof cat === "string" ? "white" : cat.type,
          answer: (room.answers[targetSeatId] && room.answers[targetSeatId][i]) || ""
        }))
      };
      base.myCorrections =
        corrector && room.corrections[corrector.seatId] ? room.corrections[corrector.seatId].corrections : null;
      normalizeCorrectionProgress(room);
      const mine = corrector && room.correctionProgress[corrector.seatId];
      if (mine && typeof mine === "object" && Object.keys(mine).length > 0) {
        base.correctionSlotsMine = { ...mine };
      }
    }
  }
  // Always send correction counts when in correction so clients see correct N after someone leaves
  if (room.phase === "correction") {
    const activeSeats = room.players.filter((p) => !p.waitingForNextRound).map((p) => p.seatId);
    base.correctionsSubmittedCount = activeSeats.filter((seat) => !!(room.corrections && room.corrections[seat])).length;
    base.correctionsTotalRequired = activeSeats.length;
  }
  return base;
}

function emitRoomStateToRoom(room) {
  const code = room.roomCode;
  if (room.phase === "correction") {
    io.in(code).fetchSockets().then((sockets) => {
      sockets.forEach((s) => {
        s.emit("room_state", getRoomState(room, s.id));
        // So clients that missed the initial correction_start (e.g. brief disconnect) still transition to correction
        s.emit("correction_start", {
          round: room.round,
          categories: room.categories,
          correctionCategoryIndex: correctionCategoryIndexForRoom(room)
        });
      });
    });
  } else {
    io.to(code).emit("room_state", getRoomState(room));
  }
}

io.on("connection", (socket) => {
  socket.on("create_room", (playerName, cb) => {
    const name = (playerName || "Player").trim().slice(0, 30);
    runRoomTask(CREATE_ROOM_LOCK, () => {
      let code = generateRoomCode();
      while (rooms.has(code)) code = generateRoomCode();

      const seatId = newSeatId();
      const room = {
        roomCode: code,
        hostSeatId: seatId,
        hostId: socket.id,
        players: [
          {
            seatId,
            id: socket.id,
            name,
            score: 0,
            waitingForNextRound: false,
            disconnected: false,
            disconnectTimeoutId: null
          }
        ],
        phase: "lobby",
        round: 0,
        letter: null,
        categories: null,
        roundEndsAt: null,
        roundScores: null,
        answers: null,
        // Game settings (host can adjust in lobby)
        roundSeconds: DEFAULT_ROUND_TIME_SECONDS,
        questionsPerRound: 12
      };
      rooms.set(code, room);
      playerToRoom.set(socket.id, code);
      socket.join(code);

      if (typeof cb === "function") cb({ roomCode: code, isHost: true });
      persistRoom(room);
      io.to(code).emit("room_state", getRoomState(room));
      logRoom(room, "create_room", { actor: name });
    });
  });

  socket.on("join_room", (roomCode, playerName, cb) => {
    const code = (roomCode || "").toUpperCase().trim();
    const name = (playerName || "Player").trim().slice(0, 30);
    if (!code) {
      if (typeof cb === "function") cb({ error: "Room not found" });
      return;
    }
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room) {
        if (typeof cb === "function") cb({ error: "Room not found" });
        return;
      }
      if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
        if (typeof cb === "function") cb({ error: "Room is full (max 12 players)" });
        return;
      }
      if (room.players.some((p) => p.id === socket.id)) {
        if (typeof cb === "function") cb({ error: "Already in room" });
        return;
      }
      if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase() && !p.disconnected)) {
        if (typeof cb === "function") cb({ error: "A player with that name is already in this room." });
        return;
      }
      // Allow join in any phase; during round/scoring, put player in waiting state for next round
      const isGameStarted = room.phase === "round" || room.phase === "scoring";
      const waitingForNextRound = isGameStarted;
      const seatId = newSeatId();
      room.players.push({
        seatId,
        id: socket.id,
        name,
        score: 0,
        waitingForNextRound,
        disconnected: false,
        disconnectTimeoutId: null
      });
      playerToRoom.set(socket.id, code);
      socket.join(code);

      if (typeof cb === "function") cb({ roomCode: code, isHost: false, isWaiting: waitingForNextRound });
      io.to(code).emit("player_toast", { type: "join", name });
      persistRoom(room);
      if (room.phase === "correction") {
        emitRoomStateToRoom(room);
      } else {
        io.to(code).emit("room_state", getRoomState(room));
      }
      logRoom(room, "join_room", { actor: name, waitingForNextRound });
    });
  });

  // Rejoin: either reattach to a disconnected slot (same name) or join as new using recentlyDisconnected for score
  socket.on("rejoin_room", (roomCode, playerName, cb) => {
    const code = (roomCode || "").toUpperCase().trim();
    const name = (playerName || "Player").trim().slice(0, 30);
    if (!code) {
      if (typeof cb === "function") cb({ error: "Room not found" });
      return;
    }
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room) {
        if (typeof cb === "function") cb({ error: "Room not found" });
        return;
      }
      if (room.players.some((p) => p.id === socket.id)) {
        if (typeof cb === "function") cb({ roomCode: code, isHost: isHostSocket(room, socket.id), isWaiting: false });
        return;
      }
      // If some other connected player is already using this exact name, block rejoin to avoid collision.
      if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase() && !p.disconnected)) {
        if (typeof cb === "function") cb({ error: "A player with that name is already in this room." });
        return;
      }
      const disconnectedSlot = room.players.find((p) => p.name === name && p.disconnected);
      if (disconnectedSlot) {
        disconnectedSlot.disconnectTimeoutId = null;
        disconnectedSlot.id = socket.id;
        disconnectedSlot.disconnected = false;
        syncHostSocketId(room);
        playerToRoom.set(socket.id, code);
        socket.join(code);
        if (typeof cb === "function") cb({ roomCode: code, isHost: isHostSocket(room, socket.id), isWaiting: false });
        persistRoom(room);
        io.to(code).emit("player_toast", { type: "reconnected", name });
        emitRoomStateToRoom(room);
        if (room.phase === "correction") {
          const s = io.sockets.sockets.get(socket.id);
          if (s) {
            s.emit("correction_start", {
              round: room.round,
              categories: room.categories,
              correctionCategoryIndex: correctionCategoryIndexForRoom(room)
            });
          }
        }
        return;
      }
      if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
        if (typeof cb === "function") cb({ error: "Room is full (max 12 players)" });
        return;
      }
      let score = 0;
      const list = recentlyDisconnected.get(code);
      if (list && list.length > 0) {
        const idx = list.findIndex((d) => d.name === name);
        if (idx !== -1) {
          score = list[idx].score ?? 0;
          list.splice(idx, 1);
          if (list.length === 0) recentlyDisconnected.delete(code);
        }
      }
      const seatId = newSeatId();
      room.players.push({
        seatId,
        id: socket.id,
        name,
        score,
        waitingForNextRound: false,
        disconnected: false,
        disconnectTimeoutId: null
      });
      playerToRoom.set(socket.id, code);
      socket.join(code);

      if (typeof cb === "function") cb({ roomCode: code, isHost: false, isWaiting: false });
      io.to(code).emit("player_toast", { type: "join", name });
      persistRoom(room);
      if (room.phase === "correction") {
        emitRoomStateToRoom(room);
      } else {
        io.to(code).emit("room_state", getRoomState(room));
      }
      logRoom(room, "rejoin_room", { actor: name });
    });
  });

  socket.on("start_game", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || !isHostSocket(room, socket.id) || room.phase !== "lobby") return;
      if (room.players.length < 2) return;

      room.phase = "round";
      room.round = 1;
      room.letter = drawNextLetter(room);
      room.categories = pickCategoriesForRoomFromPools(room);
      personalizeCategoriesForRoom(room);
      const roundSeconds = ALLOWED_ROUND_TIMES.includes(room.roundSeconds) ? room.roundSeconds : DEFAULT_ROUND_TIME_SECONDS;
      room.roundEndsAt = Date.now() + ROUND_START_COUNTDOWN_MS + roundSeconds * 1000;
      room.answers = {}; // socketId -> [answer per category]
      room.roundScores = null;

      const delay = ROUND_START_COUNTDOWN_MS + roundSeconds * 1000;
      const t = setTimeout(() => {
        runRoomTask(code, () => {
          const r = rooms.get(code);
          if (r) endRoundForRoom(r);
        });
      }, delay);
      roundTimeouts.set(code, t);

      persistRoom(room);
      io.to(code).emit("room_state", getRoomState(room));
      io.to(code).emit("round_start", {
        round: 1,
        letter: room.letter,
        categories: room.categories,
        endsAt: room.roundEndsAt,
        roundSeconds
      });
      logRoom(room, "start_game", {
        by: playerLabel(room.players.find((p) => p.id === socket.id)),
        roundSeconds,
        questionsPerRound: room.questionsPerRound,
        categories: room.categories.map((c) => `${c.type}:${c.name}`)
      });
    });
  });

  socket.on("submit_answers", (answers) => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || !Array.isArray(answers)) return;
      const actor = room.players.find((p) => p.id === socket.id);
      if (!actor) return;
      if (actor.waitingForNextRound) return;
      const seatKey = actor.seatId;
      // Normally answers are only accepted during the round, but we also accept them
      // in the early correction phase so that late auto-submits (e.g. on timer expiry)
      // still populate answers for correction/scoring.
      if (room.phase !== "round" && room.phase !== "correction") return;

      const catLen = (room.categories && room.categories.length) || 0;
      const incoming = clampAnswersPayload(answers, catLen);
      const existing = room.answers && room.answers[seatKey];
      const incomingAllEmpty = incoming.every((a) => !a || !String(a).trim());
      const existingHasContent =
        Array.isArray(existing) &&
        existing.length > 0 &&
        existing.some((a) => a != null && String(a).trim() !== "");
      // Late timer / reconnect can emit empty submit_answers during correction and wipe stored answers.
      const skipEmptyOverwrite = room.phase === "correction" && incomingAllEmpty && existingHasContent;
      if (skipEmptyOverwrite) {
        logRoom(room, "submit_answers_skipped_empty_overwrite", {
          by: playerLabel(room.players.find((p) => p.id === socket.id))
        });
      } else {
        room.answers[seatKey] = incoming;
      }
      logRoom(room, "submit_answers", {
        by: playerLabel(actor),
        skippedEmptyOverwrite: skipEmptyOverwrite,
        submittedCount: Object.keys(room.answers || {}).length,
        answers: room.answers[seatKey]
      });
      socket.emit("answers_received");
      persistRoom(room);
      if (room.phase === "correction") {
        // Preserve per-player correctionTarget/myCorrections shaping
        emitRoomStateToRoom(room);
      } else {
        io.to(code).emit("room_state", getRoomState(room));
      }

      // End round when everyone (except players waiting for next round) has submitted.
      // Disconnected players are still counted as active in-round.
      const activePlayers = room.players.filter((p) => !p.waitingForNextRound);
      const submittedCount = activePlayers.filter(
        (p) => room.answers && Object.prototype.hasOwnProperty.call(room.answers, p.seatId)
      ).length;
      if (submittedCount >= activePlayers.length && activePlayers.length > 0) {
        const t = roundTimeouts.get(code);
        if (t) clearTimeout(t);
        roundTimeouts.delete(code);
        // Short delay so clients can show "Everyone submitted! Round ending…"
        setTimeout(() => {
          runRoomTask(code, () => {
            const r = rooms.get(code);
            if (r) endRoundForRoom(r);
          });
        }, 1500);
      }
    });
  });

  socket.on("submit_corrections", (payload) => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "correction" || !Array.isArray(payload)) return;
      const corrector = room.players.find((p) => p.id === socket.id);
      if (!corrector || corrector.waitingForNextRound) return;
      const targetSeatId = room.correctionTargets && room.correctionTargets[corrector.seatId];
      if (!targetSeatId) return;
      const target = room.players.find((p) => p.seatId === targetSeatId);
      if (!target) return;
      const expectedLen = (room.categories && room.categories.length) || 0;
      const corrections = payload.slice(0, expectedLen).map((item) => {
        const mark = (item && item.mark) === "wrong" ? "wrong" : "correct";
        const notAnswered = !!(item && item.notAnswered);
        const common = !!(item && item.common);
        return { mark, notAnswered, common };
      });
      if (corrections.length !== expectedLen) return;
      room.corrections[corrector.seatId] = { targetPlayerId: target.id, corrections };
      normalizeCorrectionProgress(room);
      delete room.correctionProgress[corrector.seatId];
      const activePlayers = room.players.filter((p) => !p.waitingForNextRound);
      const submittedByActive = activePlayers.filter((p) => !!room.corrections[p.seatId]).length;
      logRoom(room, "submit_corrections", {
        by: playerLabel(corrector),
        target: playerLabel(target),
        submittedCorrections: submittedByActive,
        required: room.players.filter((p) => !p.waitingForNextRound).length
      });
      persistRoom(room);
      if (submittedByActive >= activePlayers.length) {
        finishCorrectionAndGoToScoring(room);
      } else {
        emitRoomStateToRoom(room);
      }
    });
  });

  socket.on("sync_correction_slot", (payload) => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "correction" || !payload || typeof payload !== "object") return;
      const actor = room.players.find((p) => p.id === socket.id);
      if (!actor || actor.waitingForNextRound || actor.disconnected) return;
      if (!room.correctionTargets || !room.correctionTargets[actor.seatId]) return;
      if (room.corrections && room.corrections[actor.seatId]) return;
      const expectedLen = (room.categories && room.categories.length) || 0;
      if (expectedLen <= 0) return;
      const idx = parseInt(payload.index, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= expectedLen) return;
      normalizeCorrectionProgress(room);
      const markRaw = payload.mark;
      const mark = markRaw === "wrong" ? "wrong" : markRaw === "correct" ? "correct" : null;
      const slot = {
        mark,
        notAnswered: !!payload.notAnswered,
        common: !!payload.common
      };
      if (!room.correctionProgress[actor.seatId]) room.correctionProgress[actor.seatId] = {};
      room.correctionProgress[actor.seatId][String(idx)] = slot;
      persistRoom(room);
      emitRoomStateToRoom(room);
    });
  });

  socket.on("golden_buzzer", (payload) => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "correction") return;
      const actor = room.players.find((p) => p.id === socket.id);
      if (!actor || actor.waitingForNextRound || actor.disconnected) return;
      if (!room.correctionTargets || !room.correctionTargets[actor.seatId]) return;
      if (room.corrections && room.corrections[actor.seatId]) return;
      const curIdx = correctionCategoryIndexForRoom(room);
      const idx = payload && parseInt(payload.categoryIndex, 10);
      if (!Number.isFinite(idx) || idx !== curIdx) return;
      const n = (room.categories && room.categories.length) || 0;
      if (n <= 0 || idx < 0 || idx >= n) return;
      if (!room.goldenBuzzers || typeof room.goldenBuzzers !== "object") room.goldenBuzzers = {};
      if (room.goldenBuzzers[String(idx)]) return;
      const targetSeatId = room.correctionTargets[actor.seatId];
      const target = room.players.find((p) => p.seatId === targetSeatId);
      if (!target) return;
      const targetName = (target.name || "Someone").trim().slice(0, 40);
      room.goldenBuzzers[String(idx)] = {
        bySeatId: actor.seatId,
        targetSeatId: target.seatId,
        targetName
      };
      persistRoom(room);
      io.to(code).emit("golden_buzzer", { categoryIndex: idx, targetName });
      emitRoomStateToRoom(room);
      logRoom(room, "golden_buzzer", { categoryIndex: idx, targetName, by: playerLabel(actor) });
    });
  });

  socket.on("update_settings", (payload) => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || !isHostSocket(room, socket.id) || (room.phase !== "lobby" && room.phase !== "scoring")) return;
      if (!payload || typeof payload !== "object") return;
      let { roundSeconds, questionsPerRound } = payload;
      if (!ALLOWED_ROUND_TIMES.includes(roundSeconds)) roundSeconds = room.roundSeconds || DEFAULT_ROUND_TIME_SECONDS;
      if (!ALLOWED_QUESTION_COUNTS.includes(questionsPerRound)) questionsPerRound = room.questionsPerRound || 12;
      room.roundSeconds = roundSeconds;
      room.questionsPerRound = questionsPerRound;
      persistRoom(room);
      io.to(code).emit("room_state", getRoomState(room));
      logRoom(room, "update_settings", { by: playerLabel(room.players.find((p) => p.id === socket.id)), roundSeconds, questionsPerRound });
    });
  });

  function emitScoringToRoom(room) {
    const code = room.roomCode;
    const payload = getRoomState(room);
    const scoringPayload = {
      round: room.round,
      roundScores: room.roundScores,
      totals: room.players.map((p) => ({ id: p.id, seatId: p.seatId, name: p.name, score: p.score })),
      scoringCategoryIndex: room.scoringCategoryIndex ?? 0
    };
    io.to(code).emit("room_state", payload);
    io.to(code).emit("round_scoring", scoringPayload);
  }

  socket.on("next_scoring_question", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "scoring") return;
      if (!isHostSocket(room, socket.id)) return; // only host can advance
      const total = (room.roundScores && room.roundScores.length) || 0;
      if (total === 0) return;
      const current = typeof room.scoringCategoryIndex === "number" ? room.scoringCategoryIndex : 0;
      room.scoringCategoryIndex = Math.min(current + 1, total - 1);
      persistRoom(room);
      emitScoringToRoom(room);
      // Dedicated event so every client in the room (host + others) updates the displayed question
      io.in(code).emit("scoring_question_changed", { scoringCategoryIndex: room.scoringCategoryIndex ?? 0 });
    });
  });

  socket.on("prev_scoring_question", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "scoring" || !isHostSocket(room, socket.id)) return;
      const current = typeof room.scoringCategoryIndex === "number" ? room.scoringCategoryIndex : 0;
      room.scoringCategoryIndex = Math.max(current - 1, 0);
      persistRoom(room);
      emitScoringToRoom(room);
      io.in(code).emit("scoring_question_changed", { scoringCategoryIndex: room.scoringCategoryIndex ?? 0 });
    });
  });

  socket.on("next_correction_card", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "correction" || !isHostSocket(room, socket.id)) return;
      const total = (room.categories && room.categories.length) || 0;
      if (total <= 0) return;
      clampCorrectionCategoryIndex(room);
      if (!correctionCanAdvanceNext(room)) return;
      const cur = correctionCategoryIndexForRoom(room);
      room.correctionCategoryIndex = Math.min(cur + 1, total - 1);
      persistRoom(room);
      emitRoomStateToRoom(room);
    });
  });

  socket.on("prev_correction_card", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || room.phase !== "correction" || !isHostSocket(room, socket.id)) return;
      const total = (room.categories && room.categories.length) || 0;
      if (total <= 0) return;
      clampCorrectionCategoryIndex(room);
      room.correctionCategoryIndex = Math.max(room.correctionCategoryIndex - 1, 0);
      persistRoom(room);
      emitRoomStateToRoom(room);
    });
  });

  socket.on("next_round", (payload, cb) => {
    if (typeof payload === "function") {
      cb = payload;
      payload = {};
    }
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || !isHostSocket(room, socket.id)) return;

      const opts = (payload && typeof payload === "object") ? payload : {};
      const disconnectedActive = room.players.filter((p) => !p.waitingForNextRound && p.disconnected);
      const removeDisconnected = !!opts.removeDisconnected;
      if (disconnectedActive.length > 0 && !removeDisconnected) {
        if (typeof cb === "function") {
          cb({
            error: "disconnected_present",
            disconnectedCount: disconnectedActive.length,
            disconnectedNames: disconnectedActive.map((p) => p.name)
          });
        }
        return;
      }
      if (removeDisconnected && disconnectedActive.length > 0) {
        disconnectedActive.forEach((p) => {
          // preserve score for rejoin path
          let list = recentlyDisconnected.get(code);
          if (!list) {
            list = [];
            recentlyDisconnected.set(code, list);
          }
          list.push({ id: p.id, name: p.name, score: p.score ?? 0 });
          if (list.length > MAX_RECENT_DISCONNECTS) list.shift();
        p.disconnectTimeoutId = null;
          delete room.answers?.[p.seatId];
          io.to(code).emit("player_toast", { type: "leave", name: p.name });
        });
        room.players = room.players.filter((p) => !(p.disconnected && !p.waitingForNextRound));
        if (room.players.length === 0) {
          removeRoomFromMemory(code);
          deleteRoomFromDb(code);
          if (typeof cb === "function") cb({ error: "No players left in room" });
          return;
        }
        if (!room.players.some((p) => p.seatId === room.hostSeatId)) {
          room.hostSeatId = room.players[0].seatId;
          clearHostChangeVoteRoomState(room);
        }
        syncHostSocketId(room);
      }

      // Require at least 2 active players to start another round
      const activePlayers = room.players.filter((p) => !p.waitingForNextRound);
      if (activePlayers.length < 2) return;

      // Late joiners can play from this round on
      room.players.forEach((p) => { p.waitingForNextRound = false; });
      room.phase = "round";
      room.round += 1;
      room.letter = drawNextLetter(room);
      room.categories = pickCategoriesForRoomFromPools(room);
      personalizeCategoriesForRoom(room);
      const roundSeconds = ALLOWED_ROUND_TIMES.includes(room.roundSeconds) ? room.roundSeconds : DEFAULT_ROUND_TIME_SECONDS;
      room.roundEndsAt = Date.now() + ROUND_START_COUNTDOWN_MS + roundSeconds * 1000;
      room.answers = {};
      room.roundScores = null;

      const delay = ROUND_START_COUNTDOWN_MS + roundSeconds * 1000;
      const t = setTimeout(() => {
        runRoomTask(code, () => {
          const r = rooms.get(code);
          if (r) endRoundForRoom(r);
        });
      }, delay);
      roundTimeouts.set(code, t);

      io.to(code).emit("room_state", getRoomState(room));
      io.to(code).emit("round_start", {
        round: room.round,
        letter: room.letter,
        categories: room.categories,
        endsAt: room.roundEndsAt,
        roundSeconds
      });
      logRoom(room, "next_round", {
        by: playerLabel(room.players.find((p) => p.id === socket.id)),
        roundSeconds,
        questionsPerRound: room.questionsPerRound,
        categories: room.categories.map((c) => `${c.type}:${c.name}`)
      });
      persistRoom(room);
      if (typeof cb === "function") cb({ ok: true });
    });
  });

  socket.on("leave_game", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room) return;

      const left = room.players.find((p) => p.id === socket.id);

      // Explicit leave: do NOT add to recentlyDisconnected so we don't restore this player on rejoin.
      room.players = room.players.filter((p) => p.id !== socket.id);
      playerToRoom.delete(socket.id);
      socket.leave(code);

      if (room.players.length === 0) {
        removeRoomFromMemory(code);
        deleteRoomFromDb(code);
        return;
      }
      if (left && left.seatId === room.hostSeatId) {
        room.hostSeatId = room.players[0].seatId;
        clearHostChangeVoteRoomState(room);
      }
      syncHostSocketId(room);
      if (left) delete room.answers?.[left.seatId];
      if (left) {
        io.to(code).emit("player_toast", { type: "leave", name: left.name });
      }

      if (room.phase === "correction") {
        // Rebuild correction ring only among active players, drop previous corrections
        const activePlayers = room.players.filter((p) => !p.waitingForNextRound && !p.disconnected);
        if (activePlayers.length < 2) {
          finishCorrectionAndGoToScoring(room);
          return;
        }
        room.corrections = {};
        room.correctionProgress = {};
        room.correctionTargets = assignRandomCorrectionRing(activePlayers);
        clampCorrectionCategoryIndex(room);
        persistRoom(room);
        emitRoomStateToRoom(room);
      } else {
        persistRoom(room);
        io.to(code).emit("room_state", getRoomState(room));
      }
      logRoom(room, "leave_game", { by: playerLabel(left) });
    });
  });

  /** Host removes a player by seat (same cleanup as leave_game; target may reconnect with room code as new seat). */
  socket.on("kick_player", (payload, cb) => {
    const code = playerToRoom.get(socket.id);
    if (!code) {
      if (typeof cb === "function") cb({ error: "Not in a room" });
      return;
    }
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || !isHostSocket(room, socket.id)) {
        if (typeof cb === "function") cb({ error: "Only the host can remove players" });
        return;
      }
      const seatId = payload && typeof payload.seatId === "string" ? payload.seatId.trim() : "";
      if (!seatId) {
        if (typeof cb === "function") cb({ error: "Invalid player" });
        return;
      }
      if (seatId === room.hostSeatId) {
        if (typeof cb === "function") cb({ error: "Transfer host to someone else before removing yourself" });
        return;
      }
      const left = room.players.find((p) => p.seatId === seatId);
      if (!left) {
        if (typeof cb === "function") cb({ error: "Player not found" });
        return;
      }
      room.players = room.players.filter((p) => p.seatId !== seatId);
      const targetSock = left.id ? io.sockets.sockets.get(left.id) : null;
      if (targetSock) {
        playerToRoom.delete(left.id);
        targetSock.leave(code);
        targetSock.emit("kicked_from_room", { reason: "host_kick" });
      }
      if (room.players.length === 0) {
        removeRoomFromMemory(code);
        deleteRoomFromDb(code);
        if (typeof cb === "function") cb({ ok: true });
        return;
      }
      syncHostSocketId(room);
      delete room.answers?.[left.seatId];
      io.to(code).emit("player_toast", { type: "kicked", name: left.name });
      if (room.phase === "correction") {
        const activePlayers = room.players.filter((p) => !p.waitingForNextRound && !p.disconnected);
        if (activePlayers.length < 2) {
          finishCorrectionAndGoToScoring(room);
          if (typeof cb === "function") cb({ ok: true });
          return;
        }
        room.corrections = {};
        room.correctionProgress = {};
        room.correctionTargets = assignRandomCorrectionRing(activePlayers);
        clampCorrectionCategoryIndex(room);
        persistRoom(room);
        emitRoomStateToRoom(room);
      } else {
        persistRoom(room);
        io.to(code).emit("room_state", getRoomState(room));
      }
      logRoom(room, "kick_player", {
        by: playerLabel(room.players.find((p) => p.id === socket.id)),
        target: playerLabel(left)
      });
      if (typeof cb === "function") cb({ ok: true });
    });
  });

  socket.on("transfer_host", (payload, cb) => {
    const code = playerToRoom.get(socket.id);
    if (!code) {
      if (typeof cb === "function") cb({ error: "Not in a room" });
      return;
    }
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room || !isHostSocket(room, socket.id)) {
        if (typeof cb === "function") cb({ error: "Only the host can transfer host" });
        return;
      }
      const seatId = payload && typeof payload.seatId === "string" ? payload.seatId.trim() : "";
      if (!seatId) {
        if (typeof cb === "function") cb({ error: "Invalid player" });
        return;
      }
      if (seatId === room.hostSeatId) {
        if (typeof cb === "function") cb({ error: "That player is already the host" });
        return;
      }
      const nextHost = room.players.find((p) => p.seatId === seatId);
      if (!nextHost) {
        if (typeof cb === "function") cb({ error: "Player not found" });
        return;
      }
      room.hostSeatId = seatId;
      clearHostChangeVoteRoomState(room);
      syncHostSocketId(room);
      persistRoom(room);
      io.to(code).emit("player_toast", { type: "host_transferred", name: nextHost.name });
      if (room.phase === "correction") emitRoomStateToRoom(room);
      else io.to(code).emit("room_state", getRoomState(room));
      logRoom(room, "transfer_host", {
        by: playerLabel(room.players.find((p) => p.id === socket.id)),
        newHost: playerLabel(nextHost)
      });
      if (typeof cb === "function") cb({ ok: true });
    });
  });

  /**
   * Non-host active players vote to change host. Majority is over active players excluding the host only.
   * A random new host is chosen from active players other than the current host. Votes reset after 30s idle or after a new host is chosen.
   */
  socket.on("vote_change_host", (cb) => {
    const code = playerToRoom.get(socket.id);
    if (!code) {
      if (typeof cb === "function") cb({ error: "Not in a room" });
      return;
    }
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room) {
        if (typeof cb === "function") cb({ error: "Room not found" });
        return;
      }
      const actor = room.players.find((p) => p.id === socket.id);
      if (!actor || actor.disconnected || actor.waitingForNextRound) {
        if (typeof cb === "function") {
          cb({ error: "Only active players in the current round can vote" });
        }
        return;
      }
      if (actor.seatId === room.hostSeatId) {
        if (typeof cb === "function") cb({ error: "Host cannot vote" });
        return;
      }
      if (!room.hostChangeVoteSeats) room.hostChangeVoteSeats = new Set();
      pruneHostChangeVoteSeats(room);
      const already = room.hostChangeVoteSeats.has(actor.seatId);
      if (!already) room.hostChangeVoteSeats.add(actor.seatId);
      pruneHostChangeVoteSeats(room);

      const active = activePlayersForHostVote(room);
      const voters = activeNonHostVotersForHostVote(room);
      const needed = voters.length > 0 ? Math.floor(voters.length / 2) + 1 : 1;
      const counted = room.hostChangeVoteSeats.size;

      const respondSnap = () => {
        const snap = hostChangeVotePublicSnapshot(room);
        if (typeof cb === "function") {
          cb({
            ok: true,
            alreadyVoted: already,
            hostChanged: false,
            hostChangeVoteCount: snap.hostChangeVoteCount,
            hostChangeVoteNeeded: snap.hostChangeVoteNeeded
          });
        }
      };

      if (counted >= needed) {
        const candidates = active.filter((p) => p.seatId !== room.hostSeatId);
        if (candidates.length === 0) {
          clearHostChangeVoteRoomState(room);
          persistRoom(room);
          if (room.phase === "correction") emitRoomStateToRoom(room);
          else io.to(code).emit("room_state", getRoomState(room));
          if (typeof cb === "function") cb({ error: "No eligible player to become host" });
          return;
        }
        const pick = candidates[randomInt(0, candidates.length)];
        room.hostSeatId = pick.seatId;
        clearHostChangeVoteRoomState(room);
        syncHostSocketId(room);
        persistRoom(room);
        io.to(code).emit("player_toast", { type: "host_changed_vote", name: pick.name });
        if (room.phase === "correction") emitRoomStateToRoom(room);
        else io.to(code).emit("room_state", getRoomState(room));
        logRoom(room, "vote_change_host_elected", { newHost: playerLabel(pick) });
        if (typeof cb === "function") {
          const snapPost = hostChangeVotePublicSnapshot(room);
          cb({
            ok: true,
            hostChanged: true,
            hostChangeVoteCount: snapPost.hostChangeVoteCount,
            hostChangeVoteNeeded: snapPost.hostChangeVoteNeeded
          });
        }
        return;
      }

      scheduleHostChangeVoteStaleReset(room);
      persistRoom(room);
      if (room.phase === "correction") emitRoomStateToRoom(room);
      else io.to(code).emit("room_state", getRoomState(room));
      respondSnap();
    });
  });

  socket.on("disconnect", () => {
    const code = playerToRoom.get(socket.id);
    if (!code) return;
    runRoomTask(code, () => {
      const room = rooms.get(code);
      if (!room) return;

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) {
        playerToRoom.delete(socket.id);
        return;
      }
      // Stay in the room with disconnected=true; rejoin_room reattaches the same seat (no auto-kick timer).
      player.disconnected = true;
      playerToRoom.delete(socket.id);
      player.disconnectTimeoutId = null;

      persistRoom(room);
      emitRoomStateToRoom(room);
      logRoom(room, "disconnect_marked", { by: playerLabel(player) });
    });
  });
});

function restoreRoundTimerIfNeeded(room) {
  const code = room.roomCode;
  if (room.phase !== "round" || !room.roundEndsAt) return;
  const remaining = room.roundEndsAt - Date.now();
  if (remaining > 0) {
    const t = setTimeout(() => {
      runRoomTask(code, () => {
        const r = rooms.get(code);
        if (r) endRoundForRoom(r);
      });
    }, remaining);
    roundTimeouts.set(code, t);
  } else {
    setTimeout(() => {
      runRoomTask(code, () => {
        const r = rooms.get(code);
        if (r) endRoundForRoom(r);
      });
    }, 0);
  }
}

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    const loaded = await loadAllRooms(recentlyDisconnected);
    loaded.forEach((room, code) => {
      if (room.phase === "correction") clampCorrectionCategoryIndex(room);
      rooms.set(code, room);
      restoreRoundTimerIfNeeded(room);
    });
    if (loaded.size > 0) {
      console.log(`[roomDb] Restored ${loaded.size} room(s) from database`);
    }
  } catch (e) {
    console.error("[roomDb] Failed to load rooms:", e.message || e);
  }
  server.listen(PORT, () => {
    console.log(`ListUp server running at http://localhost:${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`[ListUp] ${signal} — flushing room saves…`);
  try {
    await flushAllPendingSaves();
  } catch (e) {
    console.error("[ListUp] flush failed:", e.message || e);
  }
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

startServer();
