/**
 * Optional AI validation: ask OpenAI if an answer fits the category.
 * Only used when OPENAI_API_KEY is set. Returns true if the answer fits, false otherwise.
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function validateAnswerFitsCategory(category, answer, letter) {
  if (!OPENAI_API_KEY || !answer || !category) return true;
  let OpenAI;
  try {
    OpenAI = require("openai").default;
  } catch (e) {
    console.warn("openai package not installed; run npm install openai to use AI validation");
    return true;
  }
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const prompt = `You are judging a word game. Category: "${category}". The answer must start with the letter "${letter}" and must fit the category.
Answer given: "${answer}"
Does this answer fit the category and make sense? Reply with exactly one word: YES or NO.`;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 10,
      temperature: 0
    });
    const text = (completion.choices[0]?.message?.content || "").trim().toUpperCase();
    return text.startsWith("YES");
  } catch (err) {
    console.warn("OpenAI validation error:", err.message);
    return true; // on error, don't strip the point
  }
}

async function validateRoundScores(room, roundScores) {
  if (!OPENAI_API_KEY) return roundScores;
  const letter = room.letter;
  const updated = JSON.parse(JSON.stringify(roundScores));
  for (let catIndex = 0; catIndex < updated.length; catIndex++) {
    const cat = updated[catIndex];
    for (const a of cat.answers) {
      if (a.points !== 1 || !a.answer) continue;
      const fits = await validateAnswerFitsCategory(cat.category, a.answer, letter);
      if (!fits) {
        a.points = 0;
        a.validCategory = false;
        const pl = room.players.find((p) => p.seatId === a.playerId || p.id === a.playerId);
        if (pl) pl.score = Math.max(0, (pl.score || 0) - 1);
      } else {
        a.validCategory = true;
      }
    }
  }
  return updated;
}

module.exports = { validateAnswerFitsCategory, validateRoundScores };
