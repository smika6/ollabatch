// Which model a job runs. A job lists the models it accepts, best first
// ("26b, but 12b is fine if that gets more cards working").

// policy "one": a single model for the whole job, so its output is consistent.
// First model at least `minCards` cards can serve; if none can, the one with
// the most total slots; null when no card has any.
export function chooseModel(models, cards, minCards = 1) {
  let fallback = null, fallbackSlots = 0;
  for (const m of models) {
    const having = cards.filter((c) => c.models.includes(m));
    if (having.length >= minCards && having.length) return m;
    const slots = having.reduce((s, c) => s + (c.slots || 1), 0);
    if (slots > fallbackSlots) { fallback = m; fallbackSlots = slots; }
  }
  return fallback;
}

// policy "any": each request runs on the best listed model that card has.
export function modelForCard(models, cardModels) {
  return models.find((m) => cardModels.includes(m)) ?? null;
}

export function rewriteModel(body, model) {
  let obj;
  try { obj = JSON.parse(body); } catch { return body; }
  if (!obj || typeof obj !== 'object' || !('model' in obj)) return body;
  obj.model = model;
  return JSON.stringify(obj);
}
