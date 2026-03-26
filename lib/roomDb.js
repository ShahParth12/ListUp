const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function bigIntOrNull(n) {
  if (n == null || n === "") return null;
  try {
    return BigInt(Math.trunc(Number(n)));
  } catch {
    return null;
  }
}

/**
 * Serialize in-memory room (answers/corrections/targets keyed by seatId) for Prisma Json fields.
 */
function jsonStr(v) {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function jsonParse(s, fallback) {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function roomToRow(room, recentlyDisconnectedForRoom) {
  return {
    code: room.roomCode,
    hostSeatId: room.hostSeatId,
    phase: room.phase,
    round: room.round,
    letter: room.letter,
    roundEndsAt: bigIntOrNull(room.roundEndsAt),
    roundSeconds: room.roundSeconds ?? 120,
    questionsPerRound: room.questionsPerRound ?? 12,
    scoringCategoryIndex: room.scoringCategoryIndex ?? 0,
    correctionCategoryIndex: room.correctionCategoryIndex ?? 0,
    categories: jsonStr(room.categories),
    roundScores: jsonStr(room.roundScores),
    answers: jsonStr(room.answers ?? {}),
    corrections: room.corrections != null ? jsonStr(room.corrections) : null,
    correctionTargets: room.correctionTargets != null ? jsonStr(room.correctionTargets) : null,
    correctionProgress: room.correctionProgress != null ? jsonStr(room.correctionProgress) : null,
    recentlyDisconnected: recentlyDisconnectedForRoom != null ? jsonStr(recentlyDisconnectedForRoom) : null,
    categoryPools: room.categoryPools != null ? jsonStr(room.categoryPools) : null,
    letterPool: room.letterPool != null ? jsonStr(room.letterPool) : null
  };
}

/**
 * @param {import("@prisma/client").Room & { players: import("@prisma/client").RoomPlayer[] }} row
 */
function rowToRoom(row) {
  const players = (row.players || [])
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((rp) => ({
      seatId: rp.seatId,
      // Cold start: ignore stale socket ids from DB — everyone reattaches via rejoin_room
      id: rp.seatId,
      name: rp.name,
      score: rp.score ?? 0,
      waitingForNextRound: !!rp.waitingForNextRound,
      disconnected: true,
      disconnectTimeoutId: null
    }));

  const re = row.roundEndsAt != null ? Number(row.roundEndsAt) : null;

  return {
    roomCode: row.code,
    hostSeatId: row.hostSeatId,
    hostId: null,
    players,
    phase: row.phase,
    round: row.round,
    letter: row.letter,
    roundEndsAt: Number.isFinite(re) ? re : null,
    roundScores: jsonParse(row.roundScores, null),
    categories: jsonParse(row.categories, null),
    answers: (() => {
      const a = jsonParse(row.answers, {});
      return a && typeof a === "object" ? { ...a } : {};
    })(),
    corrections: (() => {
      const c = jsonParse(row.corrections, null);
      return c && typeof c === "object" ? { ...c } : {};
    })(),
    correctionTargets: (() => {
      const t = jsonParse(row.correctionTargets, null);
      return t && typeof t === "object" ? { ...t } : {};
    })(),
    correctionProgress: (() => {
      const p = jsonParse(row.correctionProgress, null);
      return p && typeof p === "object" ? { ...p } : {};
    })(),
    roundSeconds: row.roundSeconds,
    questionsPerRound: row.questionsPerRound,
    scoringCategoryIndex: row.scoringCategoryIndex ?? 0,
    correctionCategoryIndex: row.correctionCategoryIndex ?? 0,
    categoryPools: (() => {
      const c = jsonParse(row.categoryPools, null);
      return c && typeof c === "object" ? c : null;
    })(),
    letterPool: (() => {
      const a = jsonParse(row.letterPool, null);
      return Array.isArray(a) ? a : null;
    })()
  };
}

function syncHostSocketId(room) {
  const host = room.players.find((p) => p.seatId === room.hostSeatId);
  room.hostId = host ? host.id : room.players[0]?.id ?? null;
}

/**
 * Persist full room + players. Fire-and-forget safe: logs errors, does not throw to caller.
 */
async function saveRoom(room, recentlyDisconnectedForRoom) {
  const code = room.roomCode;
  if (!code) return;
  try {
    syncHostSocketId(room);
    const row = roomToRow(room, recentlyDisconnectedForRoom);
    const playersPayload = room.players.map((p, i) => ({
      seatId: p.seatId,
      roomCode: code,
      socketId: p.disconnected ? null : p.id,
      name: p.name,
      score: p.score ?? 0,
      waitingForNextRound: !!p.waitingForNextRound,
      disconnected: !!p.disconnected,
      sortOrder: i
    }));

    await prisma.$transaction(async (tx) => {
      await tx.room.upsert({
        where: { code },
        create: row,
        update: row
      });
      await tx.roomPlayer.deleteMany({ where: { roomCode: code } });
      if (playersPayload.length) await tx.roomPlayer.createMany({ data: playersPayload });
    });
  } catch (e) {
    console.error("[roomDb] saveRoom failed", code, e.message || e);
  }
}

function queueSave(room, recentlyDisconnected) {
  const recent = recentlyDisconnected.get(room.roomCode) || null;
  saveRoom(room, recent).catch(() => {});
}

/**
 * Load all rooms from DB into memory map. Does not register socket.io rooms.
 * @returns {Promise<Map<string, object>>}
 */
async function loadAllRooms(recentlyDisconnected) {
  const map = new Map();
  const rows = await prisma.room.findMany({
    include: { players: true }
  });
  for (const row of rows) {
    const room = rowToRoom(row);
    syncHostSocketId(room);
    const rd = jsonParse(row.recentlyDisconnected, null);
    if (rd != null) {
      recentlyDisconnected.set(row.code, Array.isArray(rd) ? rd : []);
    }
    map.set(room.roomCode, room);
  }
  return map;
}

async function deleteRoomFromDb(code) {
  try {
    await prisma.room.delete({ where: { code } });
  } catch {
    // already gone
  }
}

module.exports = {
  prisma,
  saveRoom,
  queueSave,
  loadAllRooms,
  deleteRoomFromDb,
  syncHostSocketId,
  rowToRoom
};
