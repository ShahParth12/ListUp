const MAX_ANSWER_LEN = 200;

/**
 * @param {unknown} answers
 * @param {number} categoryCount
 * @returns {string[]}
 */
function clampAnswersPayload(answers, categoryCount) {
  if (!Array.isArray(answers)) return [];
  const n = Math.max(0, Math.min(categoryCount | 0, 64));
  return answers.slice(0, n).map((a) => {
    const s = a == null ? "" : String(a);
    return s.length > MAX_ANSWER_LEN ? s.slice(0, MAX_ANSWER_LEN) : s;
  });
}

module.exports = { clampAnswersPayload, MAX_ANSWER_LEN };
