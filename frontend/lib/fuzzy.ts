export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }

    for (let j = 0; j <= b.length; j++) {
      prev[j] = curr[j];
    }
  }

  return prev[b.length];
}

function similarityFloor(token: string): number {
  if (token.length <= 3) return 0;
  if (token.length <= 5) return 1;
  return 2;
}

export function scoreText(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q) return 1;
  if (!c) return 0;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 900 - (c.length - q.length);
  if (c.includes(q)) return 800 - (c.length - q.length);

  const qTokens = tokens(q);
  const cTokens = tokens(c);
  let score = 0;

  for (const token of qTokens) {
    const exact = cTokens.find((value) => value === token);
    if (exact) {
      score += 40;
      continue;
    }

    const prefix = cTokens.find((value) => value.startsWith(token));
    if (prefix) {
      score += 24;
      continue;
    }

    const fuzzy = cTokens.find((value) => value.includes(token));
    if (fuzzy) {
      score += 10;
      continue;
    }

    const threshold = similarityFloor(token);
    if (threshold > 0) {
      const closest = cTokens.reduce<number | null>((best, value) => {
        const distance = levenshtein(token, value);
        return best === null || distance < best ? distance : best;
      }, null);

      if (closest !== null && closest <= threshold) {
        score += threshold === 1 ? 12 : 8;
      }
    }
  }

  if (cTokens.length && qTokens.length) {
    const overlap = qTokens.filter((token) => cTokens.some((candidate) => candidate.startsWith(token))).length;
    score += overlap * 5;
  }

  return score;
}

export function rankList<T>(
  items: T[],
  query: string,
  selectText: (item: T) => string,
  limit: number
): T[] {
  const normalized = normalize(query);
  if (!normalized) return items.slice(0, limit);

  const scored = items
    .map((item) => ({ item, score: scoreText(normalized, selectText(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || selectText(a.item).localeCompare(selectText(b.item)));

  // If any result is a strong match (exact, prefix, or substring → score >= 700),
  // drop the long fuzzy-token tail so users aren't scrolling past noise to find the
  // obvious match. Without this, "ivy tech" surfaces hundreds of schools containing
  // just "tech" as a token ahead of the actual Ivy Tech row.
  const topScore = scored[0]?.score ?? 0;
  const filtered = topScore >= 700 ? scored.filter((entry) => entry.score >= 100) : scored;

  return filtered.slice(0, limit).map((entry) => entry.item);
}
