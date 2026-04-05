/**
 * Serialize mutations per room code so concurrent socket/timer callbacks
 * cannot interleave reads/writes on the same in-memory room document.
 */
function createLock() {
  let chain = Promise.resolve();
  return function run(fn) {
    const p = chain.then(() => Promise.resolve().then(() => fn()));
    chain = p.catch(() => {});
    return p;
  };
}

const locks = new Map();

function getLock(code) {
  if (!locks.has(code)) locks.set(code, createLock());
  return locks.get(code);
}

function withRoomLock(code, fn) {
  if (code == null || code === "") return Promise.resolve();
  return getLock(code)(fn);
}

module.exports = { withRoomLock };
