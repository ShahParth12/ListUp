const socket = io();

let myId = null;
let myName = null;
let roomCode = null;
let isHost = false;
let state = {
  phase: null,
  players: [],
  hostId: null,
  hostSeatId: null,
  round: 0,
  letter: null,
  categories: [],
  roundEndsAt: null,
  submittedPlayerIds: [],
  waitingPlayerIds: [],
  roundAnswersSubmitted: 0,
  roundAnswersRequired: 0,
  correctionCategoryIndex: 0,
  correctionCurrentCardReady: 0,
  correctionCurrentCardTotal: 0,
  correctionCanAdvanceNext: false,
  goldenBuzzers: {},
  hostChangeVoteCount: 0,
  hostChangeVoteNeeded: 1,
  hostChangeVoteSeats: []
};
let roundInputs = [];
let timerInterval = null;
/** Previous whole-second “play phase” value (for 5→0 beeps; null during pre-round countdown). */
let lastRoundTimerSecondsLeft = null;
/** Matches server `ROUND_START_COUNTDOWN_MS` / 1000. */
const ROUND_START_COUNTDOWN_SEC = 3;
let lastRoundCountdownShown = null;
let wasRoundTimerInCountdown = false;
let roundTimerAudioCtx = null;
let roundTimerAudioUnlockAttached = false;

/** Background music during the answer phase; last N seconds of track match N-second round modes. */
const ROUND_BG_AUDIO_SRC = "/audio/round-bg.mp3";
let roundBgAudio = null;
let roundBgMusicStarted = false;

function getRoundTimerAudioContext() {
  if (!roundTimerAudioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    roundTimerAudioCtx = new AC();
  }
  return roundTimerAudioCtx;
}

/** Browsers start AudioContext suspended until user gesture — prime it on first tap/key. */
function attachRoundTimerAudioUnlock() {
  if (roundTimerAudioUnlockAttached) return;
  roundTimerAudioUnlockAttached = true;
  const unlock = () => {
    const ctx = getRoundTimerAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  };
  document.addEventListener("pointerdown", unlock, { capture: true });
  document.addEventListener("keydown", unlock, { capture: true });
}

attachRoundTimerAudioUnlock();

/** Subtle phone buzz in sync with round timer / countdown chimes (Vibration API). */
function pulseRoundTimerHaptic(durationSec = 0.12) {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    const ms =
      durationSec >= 0.5 ? 28 : durationSec >= 0.25 ? 22 : durationSec >= 0.15 ? 16 : 12;
    navigator.vibrate(ms);
  } catch {
    // ignore (unsupported or blocked)
  }
}

/**
 * Short piano-like chime: additive harmonics, fast attack, exponential decay (Web Audio API).
 */
function playRoundTimerSound(freqHz, durationSec, peakGain = 0.35) {
  const vol = getRoundTimerSoundVolume();
  if (vol <= 0) return;
  const ctx = getRoundTimerAudioContext();
  if (!ctx) return;
  const gPeak = peakGain * vol;

  const scheduleTone = () => {
    try {
      pulseRoundTimerHaptic(durationSec);
      const t0 = ctx.currentTime;
      const nyquist = ctx.sampleRate / 2;
      const attack = Math.min(0.014, Math.max(0.004, durationSec * 0.12));
      const endT = t0 + Math.max(durationSec, attack + 0.035);
      const stopT = endT + 0.08;

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.linearRampToValueAtTime(gPeak, t0 + attack);
      master.gain.exponentialRampToValueAtTime(0.0001, endT);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(10000, Math.max(2200, freqHz * 6)), t0);
      filter.Q.setValueAtTime(0.65, t0);
      master.connect(filter);
      filter.connect(ctx.destination);

      // Harmonic weights roughly like a struck tone (fundamental + upper partials, rolled off).
      const allRatios = [1, 0.5, 0.28, 0.15, 0.085, 0.045];
      const ratios =
        freqHz > 520 ? allRatios.slice(0, 5) : freqHz > 380 ? allRatios.slice(0, 6) : allRatios;
      const sumR = ratios.reduce((a, b) => a + b, 0);

      for (let i = 0; i < ratios.length; i++) {
        const partialFreq = freqHz * (i + 1);
        if (partialFreq > nyquist - 400) break;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(partialFreq, t0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(ratios[i] / sumR, t0);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(stopT);
      }
    } catch {
      // ignore
    }
  };

  if (ctx.state === "suspended") {
    ctx.resume().then(scheduleTone).catch(() => {});
  } else {
    scheduleTone();
  }
}

function maybePlayRoundTimerUrgencyCues(playLeftSeconds, prevPlaySeconds) {
  if (state.phase !== "round" || playLeftSeconds < 0) return;
  if (iHaveSubmitted || (state.submittedPlayerIds || []).includes(myId)) return;
  if (prevPlaySeconds == null) return;
  if (
    playLeftSeconds <= 5 &&
    playLeftSeconds >= 0 &&
    prevPlaySeconds === playLeftSeconds + 1
  ) {
    const peak = playLeftSeconds <= 2 ? 0.45 : playLeftSeconds <= 4 ? 0.38 : 0.32;
    playRoundTimerSound(580 + (5 - playLeftSeconds) * 44, 0.09, peak);
  }
}

function playRoundCountdownStepBeep(step) {
  const base = step === 3 ? 392 : step === 2 ? 440 : 523;
  playRoundTimerSound(base, 0.12, 0.34);
}

function playRoundGoBeep() {
  playRoundTimerSound(660, 0.75, 0.4);
}

/** Full-screen celebration + confetti for golden buzzer (all clients). */
function showGoldenBuzzerCelebration(targetName) {
  const overlay = document.getElementById("golden-buzzer-overlay");
  const nameEl = document.getElementById("golden-buzzer-achievement-name");
  if (nameEl) nameEl.textContent = targetName || "";
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }
  const cf = typeof window.confetti === "function" ? window.confetti : null;
  let bursts = 0;
  const maxBursts = 24;
  const intervalMs = 150;
  const id = setInterval(() => {
    if (cf) {
      cf({
        particleCount: 48,
        spread: 78,
        startVelocity: 38,
        ticks: 200,
        gravity: 1,
        origin: { x: Math.random() * 0.5 + 0.25, y: Math.random() * 0.2 + 0.25 },
        colors: ["#fbbf24", "#fde68a", "#f59e0b", "#fffdf5", "#fcd34d", "#d97706"]
      });
    }
    bursts += 1;
    if (bursts >= maxBursts) clearInterval(id);
  }, intervalMs);
  setTimeout(() => {
    clearInterval(id);
    if (overlay) {
      overlay.classList.add("hidden");
      overlay.setAttribute("aria-hidden", "true");
    }
  }, 4200);
}

function setRoundCountdownOverlay(visible, digitText) {
  const overlay = document.getElementById("round-countdown-overlay");
  const digit = document.getElementById("round-countdown-digit");
  if (!overlay || !digit) return;
  if (visible) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    digit.textContent = digitText;
  } else {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    digit.textContent = "";
  }
}

let iHaveSubmitted = false;
let mySubmittedAnswers = null; // cache so we can show them before room_state arrives
let resultCategoryIndex = 0; // synced from server scoringCategoryIndex
let correctionData = []; // { mark: "correct"|"wrong", notAnswered: boolean, common: boolean } per category during correction
let autoSubmittedThisRound = false;
let lastCorrectionRound = null; // used to reset correction UI across rounds
/** When correction target changes (e.g. ring rebuilt after someone leaves), clear local draft marks. */
let lastCorrectionTargetPlayerId = null;

const STORAGE_KEY = "listup_client_state_v1";
const SOUND_VOLUME_STORAGE_KEY = "listup_sound_volume";
/** @deprecated migrated into volume 0 */
const SOUND_MUTED_STORAGE_KEY = "listup_sound_muted";
/** Remember level when muting so the icon can restore it. */
const SOUND_UNMUTE_SNAPSHOT_KEY = "listup_sound_unmute_snapshot";

/** 0 = silent, 1 = full (persisted). */
function getRoundTimerSoundVolume() {
  try {
    const raw = window.localStorage.getItem(SOUND_VOLUME_STORAGE_KEY);
    if (raw != null && raw !== "") {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
    if (window.localStorage.getItem(SOUND_MUTED_STORAGE_KEY) === "1") {
      window.localStorage.removeItem(SOUND_MUTED_STORAGE_KEY);
      window.localStorage.setItem(SOUND_VOLUME_STORAGE_KEY, "0");
      return 0;
    }
  } catch {
    // ignore
  }
  return 1;
}

function setRoundTimerSoundVolume(level) {
  try {
    const n = Math.max(0, Math.min(1, Number(level)));
    window.localStorage.setItem(SOUND_VOLUME_STORAGE_KEY, String(n));
    window.localStorage.removeItem(SOUND_MUTED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function ensureRoundBgAudio() {
  if (!roundBgAudio) {
    roundBgAudio = new Audio(ROUND_BG_AUDIO_SRC);
    roundBgAudio.preload = "auto";
    roundBgAudio.loop = false;
  }
  return roundBgAudio;
}

function stopRoundBackgroundMusic() {
  roundBgMusicStarted = false;
  if (!roundBgAudio) return;
  try {
    roundBgAudio.pause();
    roundBgAudio.currentTime = 0;
  } catch {
    // ignore
  }
}

/** Keep BGM in sync with settings (same slider as timer beeps). */
function updateRoundBackgroundMusicVolume() {
  const a = roundBgAudio;
  if (!a) return;
  const v = getRoundTimerSoundVolume();
  a.volume = v;
  if (v <= 0.001) {
    try {
      a.pause();
    } catch {
      // ignore
    }
  } else if (roundBgMusicStarted && state.phase === "round") {
    a.play().catch(() => {});
  }
}

/**
 * During the play phase, map timer to the tail of the track: position = duration - secondsRemaining.
 * So 120s mode uses the last 120s, 90s the last 90s, 60s the last 60s (reconnect uses current playLeft).
 */
function maybeStartRoundBackgroundMusic(playLeftSeconds, roundSec) {
  if (roundBgMusicStarted || state.phase !== "round") return;
  const v = getRoundTimerSoundVolume();
  if (v <= 0.001) return;
  const a = ensureRoundBgAudio();
  a.volume = v;

  const seekAndPlay = () => {
    if (roundBgMusicStarted || state.phase !== "round") return;
    const dur = a.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const playLeft = Math.max(0, Math.min(roundSec, playLeftSeconds));
    const t = Math.max(0, Math.min(dur - 0.05, dur - playLeft));
    try {
      a.currentTime = t;
    } catch {
      return;
    }
    roundBgMusicStarted = true;
    a.play().catch(() => {});
  };

  if (Number.isFinite(a.duration) && a.duration > 0) {
    seekAndPlay();
  } else {
    const onReady = () => {
      a.removeEventListener("loadedmetadata", onReady);
      a.removeEventListener("canplay", onReady);
      seekAndPlay();
    };
    a.addEventListener("loadedmetadata", onReady);
    a.addEventListener("canplay", onReady);
    try {
      a.load();
    } catch {
      // ignore
    }
  }
}

function sanitizeSubmittedPlayerIds(players, ids, waitingIds) {
  const w = new Set(waitingIds || []);
  return (ids || []).filter((id) => {
    if (w.has(id)) return false;
    const p = players.find((pl) => pl.id === id);
    return !!(p && !p.waitingForNextRound);
  });
}

function updateRoundSubmissionProgress() {
  const el = document.getElementById("round-submission-progress");
  const btn = document.getElementById("btn-submit-round");
  if (!el || !btn) return;
  if (state.phase !== "round") {
    el.classList.add("hidden");
    el.textContent = "";
    btn.classList.remove("hidden");
    return;
  }
  const readOnly = iHaveSubmitted || (state.submittedPlayerIds || []).includes(myId);
  let req =
    typeof state.roundAnswersRequired === "number" ? state.roundAnswersRequired : null;
  let sub =
    typeof state.roundAnswersSubmitted === "number" ? state.roundAnswersSubmitted : null;
  if (req == null || req < 0) {
    req = (state.players || []).filter((p) => !p.waitingForNextRound).length;
  }
  if (sub == null || sub < 0) {
    sub = sanitizeSubmittedPlayerIds(
      state.players || [],
      state.submittedPlayerIds || [],
      state.waitingPlayerIds || []
    ).length;
  }
  if (req <= 0) {
    el.classList.add("hidden");
    el.textContent = "";
    btn.classList.remove("hidden");
    return;
  }
  if (readOnly) {
    btn.classList.add("hidden");
    el.classList.remove("hidden");
    el.textContent = `Submitted. Waiting for others (${sub}/${req}).`;
  } else {
    btn.classList.remove("hidden");
    el.classList.add("hidden");
    el.textContent = "";
  }
}

function saveClientState() {
  try {
    const data = {
      myName,
      roomCode,
      isHost,
      phase: state.phase
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // ignore storage errors (private mode, etc.)
  }
}

function loadClientState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  waiting: document.getElementById("screen-waiting"),
  round: document.getElementById("screen-round"),
  correction: document.getElementById("screen-correction"),
  scoring: document.getElementById("screen-scoring"),
  finished: document.getElementById("screen-finished")
};

function showScreen(name) {
  Object.keys(screens).forEach((k) => screens[k].classList.toggle("active", k === name));
  if (name !== "round") {
    const subEl = document.getElementById("round-submission-progress");
    if (subEl) {
      subEl.classList.add("hidden");
      subEl.textContent = "";
    }
    const roundSubmitBtn = document.getElementById("btn-submit-round");
    if (roundSubmitBtn) roundSubmitBtn.classList.remove("hidden");
  }
  // Persist last known phase so a refresh can restore quickly
  if (["home", "lobby", "waiting", "round", "correction", "scoring", "finished"].includes(name)) {
    state.phase = name === "home" ? null : name;
    saveClientState();
  }
  // Top-left room code: show only where the room code isn't already in the main content (lobby/waiting show "Room XXXX" in card)
  const roomCodeBadge = document.getElementById("header-room-code-badge");
  if (roomCodeBadge) {
    const showBadge = roomCode && ["round", "correction", "scoring", "finished"].includes(name);
    if (showBadge) {
      roomCodeBadge.textContent = roomCode;
      roomCodeBadge.classList.remove("hidden");
    } else {
      roomCodeBadge.classList.add("hidden");
    }
  }
}

function showError(msg) {
  const el = document.getElementById("home-error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function showJoinError(msg) {
  const el = document.getElementById("join-error");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function updateHostUI() {
  document.querySelectorAll(".host-only").forEach((el) => el.classList.toggle("hidden", !isHost));
  document.querySelectorAll(".host-hidden").forEach((el) => el.classList.toggle("hidden", isHost));
}

function updateHeaderGameInfo() {
  const el = document.getElementById("header-game-info");
  const nameEl = document.getElementById("header-player-name");
  const codeEl = document.getElementById("header-room-code");
  const hostEl = document.getElementById("header-host-name");
  const headerActions = document.getElementById("header-actions");
  if (roomCode && myName != null) {
    if (el) el.classList.add("hidden");
    if (nameEl) nameEl.textContent = myName;
    if (codeEl) codeEl.textContent = roomCode;
    const host = state.hostId && state.players ? state.players.find((p) => p.id === state.hostId) : null;
    if (hostEl) hostEl.textContent = host ? host.name : "—";
    if (headerActions) headerActions.classList.remove("hidden");
  } else {
    if (el) el.classList.add("hidden");
    if (headerActions) headerActions.classList.add("hidden");
  }
}

function leaveGameAndGoHome(opts = {}) {
  stopRoundBackgroundMusic();
  stopRoundTimer();
  if (!opts.skipLeaveEmit) {
    try {
      socket.emit("leave_game");
    } catch (e) {
      // ignore if socket not ready
    }
  }
  roomCode = null;
  myName = null;
  isHost = false;
  state = {
    phase: null,
    players: [],
    hostId: null,
    hostSeatId: null,
    round: 0,
    letter: null,
    categories: [],
    roundEndsAt: null,
    submittedPlayerIds: [],
    waitingPlayerIds: [],
    roundAnswersSubmitted: 0,
    roundAnswersRequired: 0,
    correctionCategoryIndex: 0,
    correctionCurrentCardReady: 0,
    correctionCurrentCardTotal: 0,
    correctionCanAdvanceNext: false,
    goldenBuzzers: {},
    hostChangeVoteCount: 0,
    hostChangeVoteNeeded: 1,
    hostChangeVoteSeats: []
  };
  updateHeaderGameInfo();
  showScreen("home");
  showError("");
  showJoinError("");
  const joinBackdrop = document.getElementById("join-dialog-backdrop");
  if (joinBackdrop) joinBackdrop.classList.add("hidden");
  closeScoringDialog();
  closePlayersDialog();
  closeConfirmDialog(false);
  const settingsBackdrop = document.getElementById("settings-dialog-backdrop");
  if (settingsBackdrop) settingsBackdrop.classList.add("hidden");
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}

// ----- Confirm dialog (shared) -----
const confirmDialogBackdrop = document.getElementById("confirm-dialog-backdrop");
const confirmDialogTitleEl = document.getElementById("confirm-dialog-title");
const confirmDialogMessageEl = document.getElementById("confirm-dialog-message");
const confirmDialogOkBtn = document.getElementById("btn-confirm-ok");
const confirmDialogCancelBtn = document.getElementById("btn-confirm-cancel");
let confirmDialogResolve = null;

function closeConfirmDialog(result) {
  if (confirmDialogBackdrop) {
    confirmDialogBackdrop.classList.add("hidden");
    confirmDialogBackdrop.setAttribute("aria-hidden", "true");
  }
  document.removeEventListener("keydown", onConfirmDialogKeydown);
  const r = confirmDialogResolve;
  confirmDialogResolve = null;
  if (r) r(!!result);
}

function onConfirmDialogKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeConfirmDialog(false);
  }
}

function openConfirmDialog({ title, message, confirmText = "OK", danger = false }) {
  return new Promise((resolve) => {
    if (!confirmDialogBackdrop || !confirmDialogTitleEl || !confirmDialogMessageEl || !confirmDialogOkBtn) {
      resolve(false);
      return;
    }
    confirmDialogResolve = resolve;
    confirmDialogTitleEl.textContent = title;
    confirmDialogMessageEl.textContent = message;
    confirmDialogOkBtn.textContent = confirmText;
    confirmDialogOkBtn.classList.toggle("btn-confirm-danger", !!danger);
    confirmDialogBackdrop.classList.remove("hidden");
    confirmDialogBackdrop.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onConfirmDialogKeydown);
    try {
      confirmDialogOkBtn.focus();
    } catch {
      // ignore
    }
  });
}

if (confirmDialogOkBtn) {
  confirmDialogOkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    closeConfirmDialog(true);
  });
}
if (confirmDialogCancelBtn) {
  confirmDialogCancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    closeConfirmDialog(false);
  });
}
if (confirmDialogBackdrop) {
  confirmDialogBackdrop.addEventListener("click", (e) => {
    if (e.target === confirmDialogBackdrop) closeConfirmDialog(false);
  });
}

// ----- Players dialog -----
const playersDialogBackdrop = document.getElementById("players-dialog-backdrop");
const playersDialogCloseBtn = document.getElementById("btn-players-dialog-close");
const playersDialogListEl = document.getElementById("players-dialog-list");
const playersHostVoteStatusEl = document.getElementById("players-host-vote-status");
const btnChangeHostVote = document.getElementById("btn-change-host-vote");
const headerPlayersBtn = document.getElementById("header-players-button");

function updatePlayersHostVoteFooter() {
  if (!playersHostVoteStatusEl || !btnChangeHostVote) return;
  const players = state.players || [];
  const me = myId ? players.find((p) => p.id === myId) : null;
  const iAmActive = !!(me && !me.disconnected && !me.waitingForNextRound);
  const hostSeatId =
    state.hostSeatId ||
    (state.hostId && players.find((p) => p.id === state.hostId)?.seatId) ||
    null;
  const mySeatId = me?.seatId;
  const count = typeof state.hostChangeVoteCount === "number" ? state.hostChangeVoteCount : 0;
  const needed = typeof state.hostChangeVoteNeeded === "number" ? state.hostChangeVoteNeeded : 1;
  const votedSeats = Array.isArray(state.hostChangeVoteSeats) ? state.hostChangeVoteSeats : [];
  const iVoted = !!(mySeatId && votedSeats.includes(mySeatId));

  playersHostVoteStatusEl.textContent = `Votes: ${count} / ${needed}`;

  const showBtn = !isHost && iAmActive && !!roomCode;
  btnChangeHostVote.classList.toggle("hidden", !showBtn);
  btnChangeHostVote.disabled = iVoted;
  btnChangeHostVote.textContent = iVoted ? "Change host (voted)" : "Change host";
}

function closePlayersDialog() {
  if (!playersDialogBackdrop) return;
  playersDialogBackdrop.classList.add("hidden");
  playersDialogBackdrop.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onPlayersDialogKeydown);
}

function onPlayersDialogKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closePlayersDialog();
  }
}

function openPlayersDialog() {
  if (!playersDialogBackdrop) return;
  renderPlayersPanel();
  playersDialogBackdrop.classList.remove("hidden");
  playersDialogBackdrop.setAttribute("aria-hidden", "false");
  document.addEventListener("keydown", onPlayersDialogKeydown);
  if (playersDialogCloseBtn) {
    try {
      playersDialogCloseBtn.focus();
    } catch {
      // ignore
    }
  }
}

function renderPlayersPanel() {
  if (!playersDialogListEl) return;
  const players = state.players || [];
  const hostSeatId =
    state.hostSeatId ||
    (state.hostId && players.find((p) => p.id === state.hostId)?.seatId) ||
    null;
  const mySeatId = myId ? players.find((p) => p.id === myId)?.seatId : null;

  if (players.length === 0) {
    playersDialogListEl.innerHTML = "<li class=\"players-dialog-hint\">No players listed yet.</li>";
    updatePlayersHostVoteFooter();
    return;
  }

  playersDialogListEl.innerHTML = players
    .map((p) => {
      const isRowHost = !!(hostSeatId && p.seatId === hostSeatId);
      const isYou = !!(myId && p.id === myId);
      const badges = [];
      if (isRowHost) badges.push("<span class=\"players-dialog-badge players-dialog-badge-host\">Host</span>");
      if (isYou) badges.push("<span class=\"players-dialog-badge players-dialog-badge-you\">You</span>");
      if (p.disconnected) badges.push("<span class=\"players-dialog-badge players-dialog-badge-offline\">Away</span>");
      if (p.waitingForNextRound) {
        badges.push("<span class=\"players-dialog-badge players-dialog-badge-you\">Next round</span>");
      }
      const canKick =
        isHost && !isYou && hostSeatId && p.seatId !== hostSeatId;
      const canTransfer =
        isHost && hostSeatId && p.seatId !== hostSeatId;
      const actions =
        canKick || canTransfer
          ? `<div class="players-dialog-actions">
              ${canTransfer ? `<button type="button" class="btn btn-secondary btn-players-make-host" data-seat-id="${escapeAttr(p.seatId)}">Make host</button>` : ""}
              ${canKick ? `<button type="button" class="btn btn-primary btn-players-kick" data-seat-id="${escapeAttr(p.seatId)}">Remove</button>` : ""}
            </div>`
          : "";
      return `<li class="players-dialog-row">
        <div class="players-dialog-name-wrap">
          <div class="players-dialog-name">${escapeHtml(p.name || "Player")}</div>
          <div class="players-dialog-badges">${badges.join("")}</div>
        </div>
        ${actions}
      </li>`;
    })
    .join("");
  updatePlayersHostVoteFooter();
}

async function onPlayersListClick(e) {
  const kickBtn = e.target.closest(".btn-players-kick");
  const hostBtn = e.target.closest(".btn-players-make-host");
  if (!kickBtn && !hostBtn) return;
  const seatId = (kickBtn || hostBtn).getAttribute("data-seat-id");
  if (!seatId) return;
  const targetName =
    (state.players || []).find((p) => p.seatId === seatId)?.name || "this player";

  if (kickBtn) {
    const ok = await openConfirmDialog({
      title: "Remove player?",
      message: `${targetName} will be removed from the room. They can join again with the room code if you allow it.`,
      confirmText: "Remove player",
      danger: true
    });
    if (!ok) return;
    socket.emit("kick_player", { seatId }, (res) => {
      if (res && res.error) {
        showToast(res.error);
        return;
      }
      showToast(`${targetName} was removed`);
      renderPlayersPanel();
    });
    return;
  }

  if (hostBtn) {
    const ok = await openConfirmDialog({
      title: "Transfer host?",
      message: `Make ${targetName} the host? You will lose host controls (starting rounds, settings, scoring navigation).`,
      confirmText: "Make host",
      danger: true
    });
    if (!ok) return;
    socket.emit("transfer_host", { seatId }, (res) => {
      if (res && res.error) {
        showToast(res.error);
        return;
      }
      showToast(`${targetName} is now the host`);
      renderPlayersPanel();
    });
  }
}

if (playersDialogListEl) {
  playersDialogListEl.addEventListener("click", onPlayersListClick);
}

if (playersDialogCloseBtn) {
  playersDialogCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    closePlayersDialog();
  });
}

if (playersDialogBackdrop) {
  playersDialogBackdrop.addEventListener("click", (e) => {
    if (e.target === playersDialogBackdrop) closePlayersDialog();
  });
}

if (headerPlayersBtn) {
  headerPlayersBtn.addEventListener("click", (e) => {
    e.preventDefault();
    openPlayersDialog();
  });
}

if (btnChangeHostVote) {
  btnChangeHostVote.addEventListener("click", (e) => {
    e.preventDefault();
    if (btnChangeHostVote.disabled) return;
    socket.emit("vote_change_host", (res) => {
      if (res && res.error) {
        showToast(res.error);
        return;
      }
      if (res && res.hostChanged) {
        showToast("A new host was chosen by vote.");
      }
      if (res && typeof res.hostChangeVoteCount === "number") {
        state.hostChangeVoteCount = res.hostChangeVoteCount;
        state.hostChangeVoteNeeded = res.hostChangeVoteNeeded ?? state.hostChangeVoteNeeded;
      }
      renderPlayersPanel();
    });
  });
}

// ----- Settings dialog -----
const settingsDialogBackdrop = document.getElementById("settings-dialog-backdrop");
const settingsButton = document.getElementById("header-settings-button");
const settingsCloseBtn = document.getElementById("btn-settings-close");
const leaveGameBtn = document.getElementById("btn-leave-game");
const settingsSoundVolumeInput = document.getElementById("settings-sound-volume");
const settingsSoundPctEl = document.getElementById("settings-sound-pct");
const settingsSoundTrackWrap = document.getElementById("settings-sound-track-wrap");
const settingsSoundMuteBtn = document.getElementById("btn-settings-sound-mute");

function updateSettingsSoundMuteIcon() {
  if (!settingsSoundMuteBtn) return;
  const muted = getRoundTimerSoundVolume() <= 0.001;
  settingsSoundMuteBtn.classList.toggle("is-muted", muted);
  settingsSoundMuteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  settingsSoundMuteBtn.setAttribute("aria-label", muted ? "Unmute sounds" : "Mute sounds");
}

function toggleSettingsSoundMute() {
  const v = getRoundTimerSoundVolume();
  if (v > 0.001) {
    try {
      window.localStorage.setItem(SOUND_UNMUTE_SNAPSHOT_KEY, String(v));
    } catch {
      // ignore
    }
    setRoundTimerSoundVolume(0);
  } else {
    let restore = 0.8;
    try {
      const s = window.localStorage.getItem(SOUND_UNMUTE_SNAPSHOT_KEY);
      if (s != null) {
        const n = parseFloat(s);
        if (Number.isFinite(n) && n > 0) restore = Math.min(1, n);
      }
    } catch {
      // ignore
    }
    setRoundTimerSoundVolume(restore);
  }
  syncSettingsSoundSlider();
}

function syncSettingsSoundSlider() {
  if (!settingsSoundVolumeInput) return;
  const pct = Math.round(getRoundTimerSoundVolume() * 100);
  settingsSoundVolumeInput.value = String(pct);
  settingsSoundVolumeInput.setAttribute("aria-valuenow", String(pct));
  settingsSoundVolumeInput.setAttribute("aria-valuetext", `${pct}% volume`);
  if (settingsSoundPctEl) settingsSoundPctEl.textContent = `${pct}%`;
  if (settingsSoundTrackWrap) settingsSoundTrackWrap.style.setProperty("--sound-fill", `${pct}%`);
  updateSettingsSoundMuteIcon();
  updateRoundBackgroundMusicVolume();
}

function openSettingsDialog() {
  if (!settingsDialogBackdrop) return;
  syncSettingsSoundSlider();
  settingsDialogBackdrop.classList.remove("hidden");
  settingsDialogBackdrop.setAttribute("aria-hidden", "false");
  if (settingsCloseBtn) {
    try {
      settingsCloseBtn.focus();
    } catch {
      // ignore
    }
  }
}

function closeSettingsDialog() {
  if (!settingsDialogBackdrop) return;
  settingsDialogBackdrop.classList.add("hidden");
  settingsDialogBackdrop.setAttribute("aria-hidden", "true");
}

if (settingsButton) {
  settingsButton.addEventListener("click", (e) => {
    e.preventDefault();
    openSettingsDialog();
  });
}

if (settingsCloseBtn) {
  settingsCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    closeSettingsDialog();
  });
}

if (settingsSoundMuteBtn) {
  settingsSoundMuteBtn.addEventListener("click", (e) => {
    e.preventDefault();
    toggleSettingsSoundMute();
  });
}

if (leaveGameBtn) {
  leaveGameBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    const ok = await openConfirmDialog({
      title: "Leave this game?",
      confirmText: "Leave game",
      danger: true
    });
    if (!ok) return;
    closeSettingsDialog();
    leaveGameAndGoHome();
  });
}

if (settingsSoundVolumeInput) {
  settingsSoundVolumeInput.addEventListener("input", () => {
    const v = parseInt(settingsSoundVolumeInput.value, 10);
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
    if (pct > 0) {
      try {
        window.localStorage.setItem(SOUND_UNMUTE_SNAPSHOT_KEY, String(pct / 100));
      } catch {
        // ignore
      }
    }
    setRoundTimerSoundVolume(pct / 100);
    settingsSoundVolumeInput.setAttribute("aria-valuenow", String(pct));
    settingsSoundVolumeInput.setAttribute("aria-valuetext", `${pct}% volume`);
    if (settingsSoundPctEl) settingsSoundPctEl.textContent = `${pct}%`;
    if (settingsSoundTrackWrap) settingsSoundTrackWrap.style.setProperty("--sound-fill", `${pct}%`);
    updateSettingsSoundMuteIcon();
    updateRoundBackgroundMusicVolume();
  });
  syncSettingsSoundSlider();
}

if (settingsDialogBackdrop) {
  settingsDialogBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsDialogBackdrop) closeSettingsDialog();
  });
}

// ----- Scoring help dialog -----
const scoringDialogBackdrop = document.getElementById("scoring-dialog-backdrop");
const scoringHelpBtn = document.getElementById("header-scoring-help");
const closeScoringBtn = document.getElementById("btn-close-scoring");
const scoringDialogCloseBtn = document.getElementById("btn-scoring-dialog-close");

function openScoringDialog() {
  if (!scoringDialogBackdrop) return;
  scoringDialogBackdrop.classList.remove("hidden");
  scoringDialogBackdrop.setAttribute("aria-hidden", "false");
  const focusEl = scoringDialogCloseBtn || closeScoringBtn;
  if (focusEl) {
    try {
      focusEl.focus();
    } catch {
      // ignore
    }
  }
  document.addEventListener("keydown", onScoringDialogKeydown);
}

function closeScoringDialog() {
  if (!scoringDialogBackdrop) return;
  scoringDialogBackdrop.classList.add("hidden");
  scoringDialogBackdrop.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onScoringDialogKeydown);
  if (scoringHelpBtn) scoringHelpBtn.focus();
}

function onScoringDialogKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeScoringDialog();
  }
}

if (scoringHelpBtn) scoringHelpBtn.addEventListener("click", openScoringDialog);
if (closeScoringBtn) closeScoringBtn.addEventListener("click", closeScoringDialog);
if (scoringDialogCloseBtn) scoringDialogCloseBtn.addEventListener("click", closeScoringDialog);
if (scoringDialogBackdrop) {
  scoringDialogBackdrop.addEventListener("click", (e) => {
    if (e.target === scoringDialogBackdrop) closeScoringDialog();
  });
}

// ----- Home -----
const joinDialogBackdrop = document.getElementById("join-dialog-backdrop");
const joinCodeInput = document.getElementById("join-code");

if (joinCodeInput) {
  joinCodeInput.addEventListener("input", () => {
    const start = joinCodeInput.selectionStart;
    const end = joinCodeInput.selectionEnd;
    joinCodeInput.value = (joinCodeInput.value || "").toUpperCase();
    // Preserve caret position as best as possible
    if (start != null && end != null) {
      joinCodeInput.setSelectionRange(start, end);
    }
  });
}

function openJoinDialog() {
  if (!joinDialogBackdrop) return;
  joinDialogBackdrop.classList.remove("hidden");
  joinDialogBackdrop.setAttribute("aria-hidden", "false");
  showJoinError("");
  if (joinCodeInput) {
    joinCodeInput.focus();
    joinCodeInput.select();
  }
}

function closeJoinDialog() {
  if (!joinDialogBackdrop) return;
  joinDialogBackdrop.classList.add("hidden");
  joinDialogBackdrop.setAttribute("aria-hidden", "true");
  showJoinError("");
}

document.getElementById("btn-open-join").addEventListener("click", () => {
  openJoinDialog();
});

document.getElementById("btn-join-cancel").addEventListener("click", () => {
  closeJoinDialog();
});

document.getElementById("btn-create").addEventListener("click", () => {
  const name = document.getElementById("player-name").value.trim();
  if (!name) {
    showError("Enter your name.");
    return;
  }
  showError("");
  socket.emit("create_room", name, (res) => {
    if (res && res.error) {
      showError(res.error);
      return;
    }
    myName = name;
    roomCode = res.roomCode;
    isHost = res.isHost;
    showScreen("lobby");
    updateHeaderGameInfo();
    updateHostUI();
    updateLobbyStartHint();
  });
});

document.getElementById("btn-join").addEventListener("click", () => {
  const code = (joinCodeInput && joinCodeInput.value || "").trim().toUpperCase();
  const name = (document.getElementById("player-name").value || "").trim();
  showJoinError("");
  showError("");
  if (!name) {
    // Show the name error inside the join dialog so it's visible while entering the room code
    showJoinError("Enter your name.");
    return;
  }
  if (!code) {
    showJoinError("Enter a room code.");
    return;
  }
  socket.emit("join_room", code, name, (res) => {
    if (res && res.error) {
      showJoinError(res.error);
      return;
    }
    closeJoinDialog();
    myName = name;
    roomCode = res.roomCode;
    isHost = res.isHost;
    updateHeaderGameInfo();
    if (res.isWaiting) {
      showScreen("waiting");
      document.getElementById("waiting-code").textContent = roomCode || "";
      document.getElementById("waiting-players").innerHTML = "";
    } else {
      showScreen("lobby");
      updateHostUI();
      updateLobbyStartHint();
    }
  });
});

// ----- Room state -----
/** Host-only: show while waiting for a second player; hidden for guests and when 2+ players. */
function updateLobbyStartHint() {
  const startHint = document.getElementById("start-hint");
  if (!startHint) return;
  startHint.classList.toggle("hidden", !(isHost && state.players.length < 2));
}

function renderLobby() {
  document.getElementById("lobby-code").textContent = roomCode || "";
  const list = document.getElementById("lobby-players");
  const hostId = state.hostId;
  list.innerHTML = state.players
    .map((p) => {
      const isYou = p.id === myId;
      const isHost = p.id === hostId;
      const classes = isYou ? "player-you" : "";
      const hostLabel = isHost ? ' <span class="host-label">(host)</span>' : "";
      const disconnectedLabel = p.disconnected ? ' <span class="disconnected-badge">(disconnected)</span>' : '';
      return `<li class="${classes}">${escapeHtml(p.name)}${hostLabel}${disconnectedLabel}</li>`;
    })
    .join("");

  const btnStart = document.getElementById("btn-start");
  btnStart.disabled = !isHost || state.players.length < 2;

  updateLobbyStartHint();

  const durationGroup = document.getElementById("lobby-round-duration");
  const questionsGroup = document.getElementById("lobby-question-count");
  if (durationGroup) {
    const val = String(state.roundSeconds || 120);
    durationGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
      const isActive = btn.getAttribute("data-value") === val;
      btn.classList.toggle("is-active", isActive);
      btn.classList.toggle("is-disabled", !isHost);
      btn.disabled = !isHost;
    });
  }
  if (questionsGroup) {
    const valQ = String(state.questionsPerRound || 12);
    questionsGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
      const isActive = btn.getAttribute("data-value") === valQ;
      btn.classList.toggle("is-active", isActive);
      btn.classList.toggle("is-disabled", !isHost);
      btn.disabled = !isHost;
    });
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Stable signature so we can skip DOM rebuild when only submittedPlayerIds etc. changed (keeps mobile keyboard open). */
function categoriesSignature(categories) {
  return (categories || [])
    .map((c, i) => {
      if (typeof c === "string") return `${i}|s|${c}`;
      const name = (c && c.name) || "";
      const type = (c && c.type) || "white";
      return `${i}|o|${name}|${type}`;
    })
    .join("§");
}

function renderRound() {
  document.getElementById("round-letter").textContent = state.letter || "?";
  document.getElementById("round-letter-hint").textContent = state.letter || "?";
  document.getElementById("round-num").textContent = state.round || 1;

  const container = document.getElementById("round-categories");
  const categories = state.categories || [];
  const readOnly = iHaveSubmitted || (state.submittedPlayerIds || []).includes(myId);
  // Preserve our own typed answers when server doesn't send them (round phase never includes answers).
  // Re-renders can happen when e.g. someone joins mid-round; preserve current inputs then. New round start must show empty fields.
  const isNewRoundStart = !!state.justStartedNewRound;
  if (isNewRoundStart) state.justStartedNewRound = false;
  const currentInputValues = (roundInputs.length === categories.length)
    ? roundInputs.map((input) => (input && input.value) ? input.value : "")
    : [];
  const savedAnswers =
    (state.answers && state.answers[myId]) ||
    mySubmittedAnswers ||
    (!isNewRoundStart && roundInputs.length === categories.length ? currentInputValues : []);

  const sig = categoriesSignature(categories);
  const domSig = container.getAttribute("data-categories-sig");
  const inputsStillLive =
    roundInputs.length === categories.length &&
    roundInputs.every((inp) => inp && container.contains(inp));

  // Avoid replacing inputs when nothing structural changed — destroying focused inputs dismisses mobile keyboards.
  if (!isNewRoundStart && inputsStillLive && domSig === sig && categories.length > 0) {
    categories.forEach((cat, i) => {
      const catName = typeof cat === "string" ? cat : (cat.name || "");
      const catType = typeof cat === "string" ? "white" : (cat.type || "white");
      const row = roundInputs[i] && roundInputs[i].closest(".category-row");
      if (!row || !roundInputs[i]) return;
      row.className = `category-row category-row-${catType}`;
      const label = row.querySelector(".category-label");
      if (label) {
        label.className = `category-label category-type-${catType}`;
        label.textContent = catName;
      }
      roundInputs[i].readOnly = readOnly;
      // Don’t push values while still typing — only sync when locked (submitted).
      if (readOnly && savedAnswers[i] !== undefined) {
        roundInputs[i].value = savedAnswers[i] || "";
      }
    });
    const btnSubmitRound = document.getElementById("btn-submit-round");
    if (btnSubmitRound) btnSubmitRound.disabled = readOnly;
    if (state.roundEndsAt) startTimer(state.roundEndsAt);
    updateRoundSubmissionProgress();
    return;
  }

  let restoreFocusIndex = -1;
  const ae = document.activeElement;
  if (
    ae &&
    ae.matches &&
    ae.matches("#round-categories input[type=\"text\"]") &&
    container.contains(ae)
  ) {
    const di = ae.getAttribute("data-index");
    restoreFocusIndex = di != null ? parseInt(di, 10) : -1;
    if (Number.isNaN(restoreFocusIndex)) restoreFocusIndex = -1;
  }

  container.innerHTML = "";
  container.setAttribute("data-categories-sig", sig);
  roundInputs = [];
  categories.forEach((cat, i) => {
    const catName = typeof cat === "string" ? cat : (cat.name || "");
    const catType = typeof cat === "string" ? "white" : (cat.type || "white");
    const row = document.createElement("div");
    row.className = `category-row category-row-${catType}`;
    row.innerHTML = `
      <span class="category-label category-type-${catType}">${escapeHtml(catName)}</span>
      <input type="text" data-index="${i}" placeholder="Answer..." maxlength="80" ${readOnly ? "readonly" : ""} />
    `;
    container.appendChild(row);
    const input = row.querySelector("input");
    if (savedAnswers[i] !== undefined) input.value = savedAnswers[i] || "";
    roundInputs.push(input);
  });

  const btnSubmitRound = document.getElementById("btn-submit-round");
  if (btnSubmitRound) btnSubmitRound.disabled = readOnly;

  if (state.roundEndsAt) startTimer(state.roundEndsAt);
  updateRoundSubmissionProgress();

  if (restoreFocusIndex >= 0 && roundInputs[restoreFocusIndex] && !readOnly) {
    const el = roundInputs[restoreFocusIndex];
    requestAnimationFrame(() => {
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    });
  }
}

function stopRoundTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  lastRoundTimerSecondsLeft = null;
  lastRoundCountdownShown = null;
  wasRoundTimerInCountdown = false;
  setRoundCountdownOverlay(false);
}

function startTimer(endsAt) {
  stopRoundTimer();
  lastRoundTimerSecondsLeft = null;
  function tick() {
    // Phase may have advanced to correction/scoring while the interval was still running.
    if (state.phase !== "round") {
      stopRoundBackgroundMusic();
      stopRoundTimer();
      return;
    }
    const roundSec = state.roundSeconds || 120;
    const totalLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const inCountdown = totalLeft > roundSec;
    const playLeft = inCountdown ? roundSec : totalLeft;
    const displayLeft = inCountdown ? roundSec : totalLeft;

    if (wasRoundTimerInCountdown && !inCountdown) {
      playRoundGoBeep();
    }
    wasRoundTimerInCountdown = inCountdown;

    const m = Math.floor(displayLeft / 60);
    const s = displayLeft % 60;
    const el = document.getElementById("round-timer");
    el.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    el.classList.remove("low", "critical");
    if (playLeft <= 30) el.classList.add("critical");
    else if (playLeft <= 60) el.classList.add("low");

    if (inCountdown) {
      stopRoundBackgroundMusic();
      const cd = totalLeft - roundSec;
      if (cd >= 1 && cd <= ROUND_START_COUNTDOWN_SEC) {
        setRoundCountdownOverlay(true, String(cd));
        if (lastRoundCountdownShown !== cd) {
          lastRoundCountdownShown = cd;
          playRoundCountdownStepBeep(cd);
        }
      } else {
        setRoundCountdownOverlay(false);
        lastRoundCountdownShown = null;
      }
      lastRoundTimerSecondsLeft = null;
    } else {
      setRoundCountdownOverlay(false);
      lastRoundCountdownShown = null;
      const prevPlay = lastRoundTimerSecondsLeft;
      maybePlayRoundTimerUrgencyCues(playLeft, prevPlay);
      lastRoundTimerSecondsLeft = playLeft;
      if (totalLeft > 0) {
        maybeStartRoundBackgroundMusic(playLeft, roundSec);
      }
    }

    // When time is up: same as pressing Submit (don’t require timerInterval — first sync
    // tick() runs before setInterval assigns, and left can already be 0).
    if (totalLeft <= 0) {
      stopRoundBackgroundMusic();
      stopRoundTimer();
      if (state.phase === "round") {
        tryEmitRoundSubmitAnswers();
      }
      return;
    }
  }
  tick();
  // Don’t keep ticking after time ran out on the first tick (e.g. clock skew / resume).
  if (state.phase === "round" && Math.ceil((endsAt - Date.now()) / 1000) > 0) {
    timerInterval = setInterval(tick, 1000);
  }
}

document.getElementById("btn-start").addEventListener("click", () => {
  socket.emit("start_game");
});

function blurRoundCategoryInputIfFocused() {
  const ae = document.activeElement;
  if (ae && typeof ae.matches === "function" && ae.matches("#round-categories input")) {
    ae.blur();
  }
}

/** Defer blur to after the browser finishes the activation event so layout/keyboard don’t steal the tap. */
function scheduleBlurRoundCategoryInput() {
  requestAnimationFrame(() => {
    blurRoundCategoryInputIfFocused();
  });
}

/**
 * One code path for “send my round answers”. Only sets autoSubmittedThisRound when emit actually runs
 * (avoids stuck state if categories weren’t ready yet). Returns true if we emitted.
 */
function tryEmitRoundSubmitAnswers() {
  if (state.phase !== "round") return false;
  if (
    iHaveSubmitted ||
    autoSubmittedThisRound ||
    (state.submittedPlayerIds || []).includes(myId)
  ) {
    return false;
  }
  const n = (state.categories && state.categories.length) || 0;
  if (n === 0) return false;
  autoSubmittedThisRound = true;
  submitCurrentRoundAnswers();
  return true;
}

const btnSubmitRoundEl = document.getElementById("btn-submit-round");
if (btnSubmitRoundEl) {
  const onRoundSubmitPointerActivate = (e) => {
    if (e.type === "touchend") {
      e.preventDefault();
    }
    if (tryEmitRoundSubmitAnswers()) {
      scheduleBlurRoundCategoryInput();
    }
  };
  // Touch: handle touchend + preventDefault so the first tap isn’t lost to blur/keyboard reflow (iOS).
  btnSubmitRoundEl.addEventListener("touchend", onRoundSubmitPointerActivate, { passive: false });
  btnSubmitRoundEl.addEventListener("click", () => {
    if (tryEmitRoundSubmitAnswers()) {
      scheduleBlurRoundCategoryInput();
    }
  });
}

// Lobby settings: host can change round duration and question count via buttons
const lobbyDurationGroup = document.getElementById("lobby-round-duration");
const lobbyQuestionsGroup = document.getElementById("lobby-question-count");

function emitUpdatedSettingsFromButtons() {
  if (!isHost) return;
  const durationBtn = lobbyDurationGroup && lobbyDurationGroup.querySelector(".lobby-chip.is-active");
  const questionsBtn = lobbyQuestionsGroup && lobbyQuestionsGroup.querySelector(".lobby-chip.is-active");
  const roundSeconds = durationBtn ? parseInt(durationBtn.getAttribute("data-value"), 10) : 120;
  const questionsPerRound = questionsBtn ? parseInt(questionsBtn.getAttribute("data-value"), 10) : 12;
  socket.emit("update_settings", { roundSeconds, questionsPerRound });
}

if (lobbyDurationGroup) {
  lobbyDurationGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!isHost) return;
      lobbyDurationGroup.querySelectorAll(".lobby-chip").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      emitUpdatedSettingsFromButtons();
    });
  });
}
if (lobbyQuestionsGroup) {
  lobbyQuestionsGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!isHost) return;
      lobbyQuestionsGroup.querySelectorAll(".lobby-chip").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      emitUpdatedSettingsFromButtons();
    });
  });
}

/** Read typed answers before round DOM is torn down; `n` = category count. */
function collectPendingAnswersForSubmit(n) {
  const len = Math.max(0, n | 0);
  if (len === 0) return [];
  if (roundInputs.length === len) {
    return roundInputs.map((input) => (input && input.value) ? input.value.trim() : "");
  }
  if (mySubmittedAnswers && mySubmittedAnswers.length === len) {
    return mySubmittedAnswers.map((x) => (x != null ? String(x).trim() : ""));
  }
  return new Array(len).fill("");
}

function submitCurrentRoundAnswers() {
  // Server accepts late submits in correction so clock skew / server-first round end still saves answers.
  if (state.phase !== "round" && state.phase !== "correction") return;
  const n = (state.categories && state.categories.length) || 0;
  if (n === 0) return;
  const answers = collectPendingAnswersForSubmit(n);
  mySubmittedAnswers = answers;
  socket.emit("submit_answers", answers);
}

socket.on("answers_received", () => {
  iHaveSubmitted = true;
  // Optimistic update so submitted counter shows us immediately (don't wait for room_state)
  const waiting = new Set(state.waitingPlayerIds || []);
  if (!waiting.has(myId)) {
    const ids = state.submittedPlayerIds || [];
    if (!ids.includes(myId)) state.submittedPlayerIds = [...ids, myId];
    if (typeof state.roundAnswersSubmitted === "number" && typeof state.roundAnswersRequired === "number") {
      state.roundAnswersSubmitted = Math.min(
        state.roundAnswersRequired,
        state.roundAnswersSubmitted + 1
      );
    }
  }
  renderRound();
});

const nextRoundDisconnectBackdrop = document.getElementById("next-round-disconnect-dialog-backdrop");
const nextRoundDisconnectText = document.getElementById("next-round-disconnect-text");
const btnNextRoundWait = document.getElementById("btn-next-round-wait");
const btnNextRoundRemove = document.getElementById("btn-next-round-remove");

function openNextRoundDisconnectDialog(disconnectedNames) {
  if (!nextRoundDisconnectBackdrop) return;
  const names = Array.isArray(disconnectedNames) ? disconnectedNames : [];
  if (nextRoundDisconnectText) {
    nextRoundDisconnectText.textContent = names.length
      ? `Disconnected players: ${names.join(", ")}.`
      : "Some players are disconnected.";
  }
  nextRoundDisconnectBackdrop.classList.remove("hidden");
  nextRoundDisconnectBackdrop.setAttribute("aria-hidden", "false");
}

function closeNextRoundDisconnectDialog() {
  if (!nextRoundDisconnectBackdrop) return;
  nextRoundDisconnectBackdrop.classList.add("hidden");
  nextRoundDisconnectBackdrop.setAttribute("aria-hidden", "true");
}

document.getElementById("btn-next-round").addEventListener("click", () => {
  const disconnectedActive = (state.players || []).filter((p) => !p.waitingForNextRound && p.disconnected);
  if (disconnectedActive.length > 0) {
    openNextRoundDisconnectDialog(disconnectedActive.map((p) => p.name));
    return;
  }
  socket.emit("next_round", {}, (res) => {
    if (res && res.error === "disconnected_present") {
      openNextRoundDisconnectDialog(res.disconnectedNames || []);
    }
  });
});

if (btnNextRoundWait) {
  btnNextRoundWait.addEventListener("click", () => {
    closeNextRoundDisconnectDialog();
    showToast("Waiting for disconnected players.");
  });
}
if (btnNextRoundRemove) {
  btnNextRoundRemove.addEventListener("click", () => {
    socket.emit("next_round", { removeDisconnected: true }, (res) => {
      if (res && res.error) {
        showToast(res.error);
      }
      closeNextRoundDisconnectDialog();
    });
  });
}
if (nextRoundDisconnectBackdrop) {
  nextRoundDisconnectBackdrop.addEventListener("click", (e) => {
    if (e.target === nextRoundDisconnectBackdrop) closeNextRoundDisconnectDialog();
  });
}

// Scoring settings (modify next rounds)
const scoringSettingsBackdrop = document.getElementById("scoring-settings-dialog-backdrop");
const scoringSettingsOpenBtn = document.getElementById("btn-open-scoring-settings");
const scoringSettingsCloseBtn = document.getElementById("btn-scoring-settings-close");
const scoringDurationGroup = document.getElementById("scoring-round-duration");
const scoringQuestionsGroup = document.getElementById("scoring-question-count");

function openScoringSettings() {
  if (!scoringSettingsBackdrop || !isHost) return;
  scoringSettingsBackdrop.classList.remove("hidden");
  scoringSettingsBackdrop.setAttribute("aria-hidden", "false");
  // Sync chips to current settings
  const durVal = String(state.roundSeconds || 120);
  const qVal = String(state.questionsPerRound || 12);
  if (scoringDurationGroup) {
    scoringDurationGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
      const isActive = btn.getAttribute("data-value") === durVal;
      btn.classList.toggle("is-active", isActive);
    });
  }
  if (scoringQuestionsGroup) {
    scoringQuestionsGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
      const isActive = btn.getAttribute("data-value") === qVal;
      btn.classList.toggle("is-active", isActive);
    });
  }
}

function closeScoringSettings() {
  if (!scoringSettingsBackdrop) return;
  scoringSettingsBackdrop.classList.add("hidden");
  scoringSettingsBackdrop.setAttribute("aria-hidden", "true");
}

function emitUpdatedSettingsFromScoring() {
  if (!isHost) return;
  const durBtn = scoringDurationGroup && scoringDurationGroup.querySelector(".lobby-chip.is-active");
  const qBtn = scoringQuestionsGroup && scoringQuestionsGroup.querySelector(".lobby-chip.is-active");
  const roundSeconds = durBtn ? parseInt(durBtn.getAttribute("data-value"), 10) : (state.roundSeconds || 120);
  const questionsPerRound = qBtn ? parseInt(qBtn.getAttribute("data-value"), 10) : (state.questionsPerRound || 12);
  socket.emit("update_settings", { roundSeconds, questionsPerRound });
}

if (scoringSettingsOpenBtn) {
  scoringSettingsOpenBtn.addEventListener("click", (e) => {
    e.preventDefault();
    openScoringSettings();
  });
}
if (scoringSettingsCloseBtn) {
  scoringSettingsCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    closeScoringSettings();
  });
}
if (scoringSettingsBackdrop) {
  scoringSettingsBackdrop.addEventListener("click", (e) => {
    if (e.target === scoringSettingsBackdrop) closeScoringSettings();
  });
}
if (scoringDurationGroup) {
  scoringDurationGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!isHost) return;
      scoringDurationGroup.querySelectorAll(".lobby-chip").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      emitUpdatedSettingsFromScoring();
    });
  });
}
if (scoringQuestionsGroup) {
  scoringQuestionsGroup.querySelectorAll(".lobby-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!isHost) return;
      scoringQuestionsGroup.querySelectorAll(".lobby-chip").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      emitUpdatedSettingsFromScoring();
    });
  });
}

// ----- Correction phase -----
function mergeCorrectionSlotsMine(mine) {
  if (!mine || typeof mine !== "object" || !correctionData || !correctionData.length) return;
  Object.keys(mine).forEach((k) => {
    const ix = parseInt(k, 10);
    if (!Number.isFinite(ix) || ix < 0 || ix >= correctionData.length) return;
    const s = mine[k];
    if (!s || typeof s !== "object") return;
    if (!correctionData[ix]) correctionData[ix] = { mark: null, notAnswered: false, common: false };
    if (s.mark === "correct" || s.mark === "wrong") correctionData[ix].mark = s.mark;
    else correctionData[ix].mark = null;
    correctionData[ix].notAnswered = !!s.notAnswered;
    correctionData[ix].common = !!s.common;
  });
}

function emitCorrectionSlotSync(index) {
  if (state.phase !== "correction") return;
  if (Array.isArray(state.myCorrections) && state.myCorrections.length > 0) return;
  const d = correctionData && correctionData[index];
  if (!d) return;
  socket.emit("sync_correction_slot", {
    index,
    mark: d.mark,
    notAnswered: !!d.notAnswered,
    common: !!d.common
  });
}

function emitAllCorrectionSlotsSync() {
  if (state.phase !== "correction") return;
  if (Array.isArray(state.myCorrections) && state.myCorrections.length > 0) return;
  const len = correctionData?.length ?? 0;
  for (let k = 0; k < len; k++) emitCorrectionSlotSync(k);
}

/** When "Not answered" is turned on for a blue question, force every slot to wrong; only that blue keeps notAnswered. */
function applyNotAnsweredBlueCascade(toggledBlueIndex, target) {
  const answers = target.answers;
  if (!answers || !answers.length) return;
  const n = answers.length;
  for (let k = 0; k < n; k++) {
    if (!correctionData[k]) correctionData[k] = { mark: null, notAnswered: false, common: false };
    correctionData[k].mark = "wrong";
    correctionData[k].common = false;
    const t = answers[k].type || "white";
    if (t === "blue") correctionData[k].notAnswered = k === toggledBlueIndex;
    else correctionData[k].notAnswered = false;
  }
}

/** When "Not answered" is turned off, undo the cascade: every slot back to unmarked (no forced wrong). */
function revertNotAnsweredBlueCascade(target) {
  const answers = target.answers;
  if (!answers || !answers.length) return;
  const n = answers.length;
  for (let k = 0; k < n; k++) {
    if (!correctionData[k]) correctionData[k] = { mark: null, notAnswered: false, common: false };
    correctionData[k].mark = null;
    correctionData[k].notAnswered = false;
  }
  emitAllCorrectionSlotsSync();
}

function renderCorrection() {
  const target = state.correctionTarget;
  const progressEl = document.getElementById("correction-card-progress");
  const questionWrap = document.getElementById("correction-question-wrap");
  const questionLabelEl = document.getElementById("correction-question-label");
  const btnPrev = document.getElementById("btn-correction-prev");
  const btnNext = document.getElementById("btn-correction-next");
  document.getElementById("correction-round-num").textContent = state.round || 1;

  const submitBtn = document.getElementById("btn-submit-corrections");
  const hideCardChrome = () => {
    if (progressEl) progressEl.classList.add("hidden");
    if (questionWrap) questionWrap.classList.add("hidden");
    if (questionLabelEl) questionLabelEl.textContent = "";
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
    if (submitBtn) submitBtn.classList.add("hidden");
  };

  const previewEl = document.getElementById("correction-score-preview");

  const statusElEarly = document.getElementById("correction-status");

  if (!target || !target.answers) {
    hideCardChrome();
    document.getElementById("correction-list").innerHTML = "";
    if (submitBtn) submitBtn.disabled = true;
    if (statusElEarly) {
      statusElEarly.classList.remove("hidden");
      statusElEarly.textContent = "Waiting for others to finish correcting…";
    }
    if (previewEl) previewEl.textContent = "0 pts";
    return;
  }

  const n = target.answers.length;
  if (n === 0) {
    hideCardChrome();
    document.getElementById("correction-list").innerHTML = "";
    if (submitBtn) submitBtn.disabled = true;
    if (statusElEarly) {
      statusElEarly.classList.remove("hidden");
      statusElEarly.textContent = "No questions to correct this round.";
    }
    if (previewEl) previewEl.textContent = "0 pts";
    return;
  }

  let idx = typeof state.correctionCategoryIndex === "number" ? state.correctionCategoryIndex : 0;
  idx = Math.max(0, Math.min(idx, n - 1));
  if (state.correctionCategoryIndex !== idx) state.correctionCategoryIndex = idx;

  const ready = state.correctionCurrentCardReady ?? 0;
  const total = state.correctionCurrentCardTotal ?? 0;
  const cardComplete = total === 0 || ready >= total;
  if (questionWrap) questionWrap.classList.remove("hidden");
  if (questionLabelEl) questionLabelEl.textContent = `Question ${idx + 1} of ${n}`;
  if (progressEl) {
    if (total > 0) {
      progressEl.textContent = `Marked this card: ${ready}/${total}`;
      progressEl.classList.remove("hidden");
    } else {
      progressEl.textContent = "";
      progressEl.classList.add("hidden");
    }
  }
  if (btnPrev) btnPrev.disabled = idx <= 0;
  if (btnNext) btnNext.disabled = idx >= n - 1 || !cardComplete;

  const listEl = document.getElementById("correction-list");
  const targetNameRaw = target.targetPlayerName || "Someone";
  const targetName = escapeHtml(targetNameRaw);
  const targetNameAria = String(targetNameRaw).replace(/"/g, "'");
  const submitted = !!state.myCorrections;
  const anyNotAnswered = target.answers.some((item, j) => (item.type === "blue") && correctionData[j] && correctionData[j].notAnswered);
  const item = target.answers[idx];
  const i = idx;
  const data = correctionData[i] || { mark: null, notAnswered: false, common: false };
  const type = item.type || "white";
  const effectiveMark = (type === "red" && data.common) ? "wrong" : data.mark;
  const typeClass = `category-type-${type}`;
  const typeBadge =
    type === "blue"
      ? "Blue : +1 · 0 for all questions"
      : type === "red"
        ? "Red : +3 · 0 · -3"
        : type === "green"
          ? "Green : +3 · 0"
          : "Standard : +1 · 0";
  const markDisabled = submitted || anyNotAnswered;
  const markDisabledAttr = markDisabled ? " disabled" : "";
  const notAnsweredChecked = data.notAnswered ? " checked" : "";
  const commonChecked = data.common ? " checked" : "";
  const toggleDisabled = submitted ? " disabled" : "";
  const correctSelected = effectiveMark === "correct" ? " is-selected" : "";
  const wrongSelected = effectiveMark === "wrong" ? " is-selected" : "";

  const gb = state.goldenBuzzers && state.goldenBuzzers[String(i)];
  const buzzerTaken = !!gb;
  let goldenBuzzerHeaderRight = "";
  if (buzzerTaken) {
    const usedTitle = `Amazing answer — ${gb.targetName || "Someone"}`;
    goldenBuzzerHeaderRight = `<span class="golden-buzzer-used-badge" role="status" title="${escapeAttr(usedTitle)}"><span class="golden-buzzer-used-badge-icon" aria-hidden="true">🏆</span></span>`;
  } else {
    const buzzerDisabled = submitted;
    const tip = buzzerDisabled
      ? "Golden buzzer is only available before you submit corrections."
      : "Golden buzzer: optional, once per question for the room — confetti for everyone.";
    goldenBuzzerHeaderRight = `<button type="button" class="golden-buzzer-icon-btn"${buzzerDisabled ? " disabled" : ""} data-category-index="${i}" title="${escapeAttr(tip)}" aria-label="Golden buzzer: amazing answer for ${targetNameAria}"><svg class="golden-buzzer-icon-svg" viewBox="0 0 24 24" aria-hidden="true"><polygon fill="currentColor" points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9"/></svg></button>`;
  }

  let togglesBlock = "";
  if (type === "blue") {
    togglesBlock = `<div class="correction-toggle-panel">
      <label class="correction-toggle-cell correction-toggle-panel-inner">
        <span class="ag-style-toggle"><input type="checkbox" class="correction-toggle not-answered-toggle" data-index="${i}"${notAnsweredChecked}${toggleDisabled} /><span class="ag-style-toggle-slider"></span></span>
        <span class="correction-toggle-label"><strong>Not answered</strong><span class="correction-toggle-hint">If on, they score 0 for the whole round.</span></span>
      </label>
    </div>`;
  } else if (type === "red") {
    togglesBlock = `<div class="correction-toggle-panel">
      <label class="correction-toggle-cell correction-toggle-panel-inner">
        <span class="ag-style-toggle"><input type="checkbox" class="correction-toggle common-toggle" data-index="${i}"${commonChecked}${toggleDisabled} /><span class="ag-style-toggle-slider"></span></span>
        <span class="correction-toggle-label"><strong>Common answer (−3)</strong><span class="correction-toggle-hint">Many players had the same answer.</span></span>
      </label>
    </div>`;
  }

  listEl.innerHTML = `<li class="correction-row correction-row-card correction-row-${type}" data-index="${i}">
      <header class="correction-q-head correction-q-head-with-buzzer">
        <div class="correction-q-head-text">
          <span class="correction-q-badge ${typeClass}" aria-hidden="true">${escapeHtml(typeBadge)}</span>
          <h3 class="correction-q-title ${typeClass}">${escapeHtml(item.category)}</h3>
        </div>
        ${goldenBuzzerHeaderRight}
      </header>
      <div class="correction-q-answer">
        <span class="correction-q-answer-label"><span class="correction-q-answer-player">${targetName}</span> Says:</span>
        <p class="correction-q-answer-value">${escapeHtml(item.answer || "—")}</p>
      </div>
      <div class="correction-q-options">
        ${togglesBlock}
        <div class="correction-mark-pair" role="group" aria-label="Mark this answer">
          <button type="button" class="correction-option correction-option-correct${correctSelected}" data-index="${i}" data-mark="correct" aria-pressed="${effectiveMark === "correct" ? "true" : "false"}"${markDisabledAttr}>
            <span class="correction-option-icon" aria-hidden="true">✓</span>
            <span class="correction-option-text">Correct</span>
          </button>
          <button type="button" class="correction-option correction-option-wrong${wrongSelected}" data-index="${i}" data-mark="wrong" aria-pressed="${effectiveMark === "wrong" ? "true" : "false"}"${markDisabledAttr}>
            <span class="correction-option-icon" aria-hidden="true">✗</span>
            <span class="correction-option-text">Wrong</span>
          </button>
        </div>
      </div>
    </li>`;
  if (!submitted) {
    listEl.querySelectorAll(".correction-option[data-mark]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const j = parseInt(btn.getAttribute("data-index"), 10);
        const mark = btn.getAttribute("data-mark");
        if (!correctionData[j]) correctionData[j] = { mark: null, notAnswered: false, common: false };
        correctionData[j].mark = mark === "wrong" ? "wrong" : "correct";
        emitCorrectionSlotSync(j);
        renderCorrection();
      });
    });
    listEl.querySelectorAll(".not-answered-toggle").forEach((el) => {
      el.addEventListener("change", () => {
        const j = parseInt(el.getAttribute("data-index"), 10);
        if (el.checked) {
          applyNotAnsweredBlueCascade(j, target);
          emitAllCorrectionSlotsSync();
        } else {
          revertNotAnsweredBlueCascade(target);
        }
        renderCorrection();
      });
    });
    listEl.querySelectorAll(".common-toggle").forEach((el) => {
      el.addEventListener("change", () => {
        const j = parseInt(el.getAttribute("data-index"), 10);
        if (!correctionData[j]) correctionData[j] = { mark: correctionData[j]?.mark || null, notAnswered: false, common: false };
        correctionData[j].common = el.checked;
        emitCorrectionSlotSync(j);
        renderCorrection();
      });
    });
    const buzzBtn = listEl.querySelector(".golden-buzzer-icon-btn");
    if (buzzBtn && !buzzBtn.disabled) {
      buzzBtn.addEventListener("click", () => {
        const cat = parseInt(buzzBtn.getAttribute("data-category-index"), 10);
        if (!Number.isFinite(cat)) return;
        socket.emit("golden_buzzer", { categoryIndex: cat });
      });
    }
  }
  const allMarked = target.answers.length > 0 && (
    anyNotAnswered ||
    target.answers.every((item, i) => {
      const d = correctionData[i];
      if (item.type === "blue" && d && d.notAnswered) return true;
      // For red, toggling "common(-3)" should be enough to enable submission.
      if (item.type === "red" && d && d.common) return true;
      return d && (d.mark === "correct" || d.mark === "wrong");
    })
  );
  if (submitBtn) {
    const onLast = idx === n - 1;
    submitBtn.classList.toggle("hidden", !onLast || submitted);
    submitBtn.disabled = submitted || !allMarked;
  }

  // Live score preview for the target player under current correction choices.
  let previewScore = 0;
  if (anyNotAnswered) {
    previewScore = 0;
  } else {
    previewScore = target.answers.reduce((sum, item, i) => {
      const d = correctionData[i] || { mark: null, notAnswered: false, common: false };
      const mark = d.mark;
      const type = item.type || "white";
      if (type === "red") return sum + (d.common ? -3 : (mark === "correct" ? 3 : 0));
      if (type === "green") return sum + (mark === "correct" ? 3 : 0);
      if (type === "blue") return sum + (mark === "correct" ? 1 : 0);
      return sum + (mark === "correct" ? 1 : 0);
    }, 0);
  }
  if (previewEl) previewEl.textContent = `${previewScore} pts`;

  const statusEl = document.getElementById("correction-status");
  if (submitted) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = `Submitted. Waiting for others (${state.correctionsSubmittedCount ?? 0}/${state.correctionsTotalRequired ?? 0}).`;
  } else if (anyNotAnswered) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "";
  } else if (idx < n - 1) {
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
  } else if (!allMarked) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "";
  } else {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "";
  }
}

document.getElementById("btn-correction-prev")?.addEventListener("click", () => {
  if (!isHost || state.phase !== "correction") return;
  socket.emit("prev_correction_card");
});
document.getElementById("btn-correction-next")?.addEventListener("click", () => {
  if (!isHost || state.phase !== "correction") return;
  socket.emit("next_correction_card");
});

document.getElementById("btn-submit-corrections").addEventListener("click", () => {
  if (!state.correctionTarget || !state.correctionTarget.answers) return;
  const n = state.correctionTarget.answers.length;
  const payload = correctionData.slice(0, n).map((d, i) => {
    const item = state.correctionTarget.answers[i];
    const mark = (d && (d.mark === "correct" || d.mark === "wrong")) ? d.mark : "wrong";
    return {
      mark,
      notAnswered: item.type === "blue" && d && d.notAnswered,
      common: item.type === "red" && d && d.common
    };
  });
  if (payload.length !== n) return;
  socket.emit("submit_corrections", payload);
});

// ----- Toast notifications -----
let toastTimeout = null;
function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "toast";
  div.textContent = message;
  container.appendChild(div);
  // Force reflow so transition applies
  void div.offsetWidth;
  div.classList.add("show");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    div.classList.remove("show");
  }, 2500);
}
// ----- Socket events -----
socket.on("connect", () => {
  myId = socket.id;
  const restored = loadClientState();
  if (restored && restored.roomCode && restored.myName && !roomCode) {
    myName = restored.myName;
    roomCode = restored.roomCode;
    isHost = !!restored.isHost;
    updateHeaderGameInfo();
  }
  // Rejoin after refresh (no roomCode) or after socket reconnect (e.g. screen lock) so we reattach to our slot
  const code = roomCode || (restored && restored.roomCode) || null;
  const name = myName != null ? myName : (restored && restored.myName) || null;
  if (code && name) {
    socket.emit("rejoin_room", code, name, (res) => {
      if (res && res.error) {
        showError(res.error);
        roomCode = null;
        myName = null;
        isHost = false;
        saveClientState();
        return;
      }
      myName = name;
      roomCode = res.roomCode;
      isHost = res.isHost;
      updateHeaderGameInfo();
    });
  }
});

socket.on("player_toast", (payload) => {
  if (!payload || !payload.name || !payload.type) return;
  const name = payload.name;
  if (payload.type === "join") {
    showToast(`${name} joined the room`);
  } else if (payload.type === "leave") {
    showToast(`${name} left the room`);
  } else if (payload.type === "reconnected") {
    showToast(`${name} reconnected`);
  } else if (payload.type === "kicked") {
    showToast(`${name} was removed by the host`);
  } else if (payload.type === "host_transferred") {
    showToast(`${name} is now the host`);
  } else if (payload.type === "host_changed_vote") {
    showToast(`${name} is the new host (majority vote).`);
  }
});

socket.on("kicked_from_room", () => {
  showToast("You were removed from the room by the host.");
  leaveGameAndGoHome({ skipLeaveEmit: true });
});

socket.on("room_state", (room) => {
  const prevPhase = state.phase;
  const waitingIdsEarly = room.waitingPlayerIds || [];
  const iAmWaitingEarly = myId && waitingIdsEarly.includes(myId);
  const enteringCorrectionFromRound = room.phase === "correction" && prevPhase === "round";
  const alreadySubmitted =
    iHaveSubmitted || (room.submittedPlayerIds && myId && room.submittedPlayerIds.includes(myId));
  // Server ended the round before our local timer fired — flush inputs or we never emit submit_answers.
  if (enteringCorrectionFromRound && !iAmWaitingEarly && !alreadySubmitted && !autoSubmittedThisRound) {
    autoSubmittedThisRound = true;
    const len =
      (room.categories && room.categories.length) ||
      (state.categories && state.categories.length) ||
      0;
    if (len > 0) {
      const answers = collectPendingAnswersForSubmit(len);
      mySubmittedAnswers = answers;
      socket.emit("submit_answers", answers);
    }
  }

  state = {
    roomCode: room.roomCode,
    phase: room.phase,
    players: room.players || [],
    hostId: room.hostId ?? state.hostId,
    hostSeatId: room.hostSeatId != null ? room.hostSeatId : (state.hostSeatId ?? null),
    hostChangeVoteCount:
      typeof room.hostChangeVoteCount === "number" ? room.hostChangeVoteCount : 0,
    hostChangeVoteNeeded:
      typeof room.hostChangeVoteNeeded === "number" ? room.hostChangeVoteNeeded : 1,
    hostChangeVoteSeats: Array.isArray(room.hostChangeVoteSeats) ? room.hostChangeVoteSeats : [],
    round: room.round,
    letter: room.letter,
    categories: room.categories || [],
    roundEndsAt: room.roundEndsAt,
    roundScores: room.roundScores || state.roundScores,
    scoringCategoryIndex: room.scoringCategoryIndex ?? 0,
    roundSeconds: room.roundSeconds || 120,
    questionsPerRound: room.questionsPerRound || 12,
    answers: room.answers,
    submittedPlayerIds: sanitizeSubmittedPlayerIds(
      room.players || [],
      room.submittedPlayerIds || [],
      room.waitingPlayerIds || []
    ),
    waitingPlayerIds: room.waitingPlayerIds || [],
    roundAnswersSubmitted:
      typeof room.roundAnswersSubmitted === "number" ? room.roundAnswersSubmitted : 0,
    roundAnswersRequired:
      typeof room.roundAnswersRequired === "number" ? room.roundAnswersRequired : 0,
    correctionTarget: room.correctionTarget ?? null,
    myCorrections: room.myCorrections ?? null,
    correctionsSubmittedCount: room.correctionsSubmittedCount ?? 0,
    correctionsTotalRequired: room.correctionsTotalRequired ?? 0,
    correctionCategoryIndex:
      room.phase === "correction"
        ? (typeof room.correctionCategoryIndex === "number" ? room.correctionCategoryIndex : 0)
        : (state.correctionCategoryIndex ?? 0),
    correctionCurrentCardReady: room.phase === "correction" ? (room.correctionCurrentCardReady ?? 0) : 0,
    correctionCurrentCardTotal: room.phase === "correction" ? (room.correctionCurrentCardTotal ?? 0) : 0,
    correctionCanAdvanceNext: room.phase === "correction" ? !!room.correctionCanAdvanceNext : false,
    goldenBuzzers:
      room.phase === "correction" && room.goldenBuzzers && typeof room.goldenBuzzers === "object"
        ? { ...room.goldenBuzzers }
        : {}
  };
  // Kill round timer on any server push so it can't fire after we've left the round (e.g. overlap with correction).
  stopRoundTimer();
  if (state.phase !== "round") {
    stopRoundBackgroundMusic();
  }
  // Keep isHost in sync with server (e.g. after reconnect or if state was lost)
  if (state.hostId && myId) isHost = state.hostId === myId;

  if (playersDialogBackdrop && !playersDialogBackdrop.classList.contains("hidden")) {
    renderPlayersPanel();
  }

  const iAmWaiting = state.waitingPlayerIds && state.waitingPlayerIds.includes(myId);
  if (iAmWaiting) {
    showScreen("waiting");
    document.getElementById("waiting-code").textContent = state.roomCode || roomCode || "";
    const hostId = state.hostId;
    document.getElementById("waiting-players").innerHTML = state.players
      .map((p) => {
        const isYou = p.id === myId;
        const isHost = p.id === hostId;
        const classes = isYou ? "player-you" : "";
        const hostLabel = isHost ? ' <span class="host-label">(host)</span>' : "";
        const waitingLabel = p.waitingForNextRound ? ' <span class="waiting-badge">(joining next round)</span>' : "";
        const disconnectedLabel = p.disconnected ? ' <span class="disconnected-badge">(disconnected)</span>' : "";
        return `<li class="${classes}">${escapeHtml(p.name)}${hostLabel}${waitingLabel}${disconnectedLabel}</li>`;
      })
      .join("");
    // Hide header info bar in waiting screen; room code is already displayed in the card
    const headerInfo = document.getElementById("header-game-info");
    if (headerInfo) headerInfo.classList.add("hidden");
    updateHostUI();
    return;
  }

  updateHeaderGameInfo();
  if (state.phase === "lobby") {
    showScreen("lobby");
    renderLobby();
    updateHostUI();
  } else if (state.phase === "round") {
    showScreen("round");
    renderRound();
    updateHostUI();
  } else if (state.phase === "correction") {
    showScreen("correction");
    if (state.correctionTarget) {
      const answers = state.correctionTarget.answers || [];
      const newTargetId = state.correctionTarget.targetPlayerId ?? null;
      if (
        lastCorrectionTargetPlayerId != null &&
        newTargetId != null &&
        newTargetId !== lastCorrectionTargetPlayerId
      ) {
        correctionData = null;
      }
      lastCorrectionTargetPlayerId = newTargetId;
      // If the correction round changed, wipe local state and reinitialize
      // (otherwise old toggles/marks can persist when the category count matches).
      if (state.round !== lastCorrectionRound) {
        correctionData = null;
        lastCorrectionRound = state.round;
      }
      if (state.myCorrections && state.myCorrections.length === answers.length) {
        // After we've submitted (or on reconnect), prefer server-sent corrections
        correctionData = state.myCorrections.map((c) => ({ mark: c.mark || "wrong", notAnswered: !!c.notAnswered, common: !!c.common }));
      } else {
        if (!correctionData || correctionData.length !== answers.length) {
          correctionData = answers.map(() => ({ mark: null, notAnswered: false, common: false }));
        }
        if (room.correctionSlotsMine && typeof room.correctionSlotsMine === "object") {
          mergeCorrectionSlotsMine(room.correctionSlotsMine);
        }
      }
    } else {
      correctionData = [];
    }
    renderCorrection();
    updateHostUI();
  } else if (state.phase === "scoring") {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    resultCategoryIndex = state.scoringCategoryIndex ?? 0;
    showScreen("scoring");
    renderScoring();
    updateHostUI();
  } else if (state.phase === "finished") {
    showScreen("finished");
    renderFinished();
  }
});

socket.on("golden_buzzer", (data) => {
  if (!data || typeof data.targetName !== "string") return;
  showGoldenBuzzerCelebration(data.targetName);
});

socket.on("round_start", (data) => {
  stopRoundBackgroundMusic();
  state.phase = "round";
  state.round = data.round;
  state.letter = data.letter;
  state.categories = data.categories || [];
  state.roundEndsAt = data.endsAt;
  if (typeof data.roundSeconds === "number" && data.roundSeconds > 0) {
    state.roundSeconds = data.roundSeconds;
  }
  state.answers = {};
  state.roundScores = null;
  state.submittedPlayerIds = [];
  state.roundAnswersSubmitted = 0;
  state.roundAnswersRequired = (state.players || []).filter((p) => !p.waitingForNextRound).length;
  state.justStartedNewRound = true; // so renderRound clears fields instead of reusing previous round's inputs
  iHaveSubmitted = false;
  autoSubmittedThisRound = false;
  mySubmittedAnswers = null;
  lastCorrectionRound = null;
  lastCorrectionTargetPlayerId = null;
  state.correctionCategoryIndex = 0;
  showScreen("round");
  renderRound();
  updateHostUI();
});

socket.on("correction_start", (data) => {
  const wasRound = state.phase === "round";
  const iAmWaitCs = myId && (state.waitingPlayerIds || []).includes(myId);
  const alreadySubmittedCs =
    iHaveSubmitted || (state.submittedPlayerIds && myId && state.submittedPlayerIds.includes(myId));
  // If this event arrives before room_state, we still need to flush answers (server ended round first).
  if (wasRound && !iAmWaitCs && !alreadySubmittedCs && !autoSubmittedThisRound) {
    autoSubmittedThisRound = true;
    const len =
      (data.categories && data.categories.length) ||
      (state.categories && state.categories.length) ||
      0;
    if (len > 0) {
      const answers = collectPendingAnswersForSubmit(len);
      mySubmittedAnswers = answers;
      socket.emit("submit_answers", answers);
    }
  }
  stopRoundTimer();
  stopRoundBackgroundMusic();
  state.phase = "correction";
  state.round = data.round ?? state.round;
  state.categories = data.categories ?? state.categories ?? [];
  if (typeof data.correctionCategoryIndex === "number") {
    state.correctionCategoryIndex = data.correctionCategoryIndex;
  }
  showScreen("correction");
  if (state.round !== lastCorrectionRound) {
    correctionData = null;
    lastCorrectionRound = state.round;
  }
  if (state.correctionTarget && state.correctionTarget.answers) {
    const answers = state.correctionTarget.answers;
    if (state.myCorrections && state.myCorrections.length === answers.length) {
      correctionData = state.myCorrections.map((c) => ({ mark: c.mark || "wrong", notAnswered: !!c.notAnswered, common: !!c.common }));
    } else if (!correctionData || correctionData.length !== answers.length) {
      // First time we enter correction on this client; don't wipe in-progress choices when others submit
      correctionData = answers.map(() => ({ mark: null, notAnswered: false, common: false }));
    }
    renderCorrection();
  }
  updateHostUI();
});

socket.on("round_scoring", (data) => {
  stopRoundBackgroundMusic();
  state.phase = "scoring";
  state.roundScores = data.roundScores;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  const newIndex = typeof data.scoringCategoryIndex === "number" ? data.scoringCategoryIndex : (state.scoringCategoryIndex ?? 0);
  state.scoringCategoryIndex = newIndex;
  resultCategoryIndex = newIndex;
  showScreen("scoring");
  renderScoring(data.totals);
  updateHostUI();
});

socket.on("game_finished", (data) => {
  stopRoundBackgroundMusic();
  state.phase = "finished";
  state.players = (data.players || []).map((p) => ({ id: p.id, name: p.name, score: p.score }));
  showScreen("finished");
  renderFinished(data.players);
});

function renderScoring(totals) {
  const players =
    totals ||
    state.players.map((p) => ({
      id: p.id,
      seatId: p.seatId,
      name: p.name,
      score: p.score
    }));
  document.getElementById("scoring-round-num").textContent = state.round || 1;

  // This round: sum each player's points from roundScores (playerId on server is stable seatId)
  const roundPointsByPlayer = {};
  (state.roundScores || []).forEach((cat) => {
    (cat.answers || []).forEach((a) => {
      if (a.playerId) {
        roundPointsByPlayer[a.playerId] = (roundPointsByPlayer[a.playerId] || 0) + (a.points || 0);
      }
    });
  });
  const roundLeaderboard = [...players]
    .map((p) => {
      const stableKey = p.seatId || p.id;
      return { id: p.id, name: p.name, score: roundPointsByPlayer[stableKey] || 0 };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const roundEl = document.getElementById("scoring-round-leaderboard");
  roundEl.innerHTML = roundLeaderboard
    .map(
      (p, i) =>
        `<li class="scoring-leaderboard-row">
          <span class="scoring-leaderboard-rank">#${i + 1}</span>
          <span class="scoring-leaderboard-name">${escapeHtml(p.name)}</span>
          <span class="scoring-leaderboard-score">${p.score ?? 0} pts</span>
        </li>`
    )
    .join("");

  // Overall: total cumulative scores
  const sortedOverall = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const overallEl = document.getElementById("scoring-overall-leaderboard");
  overallEl.innerHTML = sortedOverall
    .map(
      (p, i) =>
        `<li class="scoring-leaderboard-row">
          <span class="scoring-leaderboard-rank">#${i + 1}</span>
          <span class="scoring-leaderboard-name">${escapeHtml(p.name)}</span>
          <span class="scoring-leaderboard-score">${p.score ?? 0} pts</span>
        </li>`
    )
    .join("");
}

function renderFinished(players) {
  const list = players || state.players;
  const sorted = [...list].sort((a, b) => (b.score || 0) - (a.score || 0));
  const top3 = sorted.slice(0, 3);
  const rest = sorted.slice(3);
  const podiumEl = document.getElementById("final-podium");
  const ul = document.getElementById("final-scores");
  if (podiumEl) {
    podiumEl.innerHTML = top3.length
      ? `<div class="podium">
          ${top3
            .map(
              (p, i) =>
                `<div class="podium-place place-${i + 1}">
                  <span class="podium-rank">#${i + 1}</span>
                  <span class="podium-name">${escapeHtml(p.name)}</span>
                  <span class="podium-score">${p.score ?? 0} pts</span>
                </div>`
            )
            .join("")}
        </div>`
      : "";
  }
  ul.innerHTML = rest
    .map(
      (p, i) =>
        `<li><span class="rank">#${i + 4}</span><span>${escapeHtml(p.name)}</span><span class="score">${p.score ?? 0} pts</span></li>`
    )
    .join("");
}
