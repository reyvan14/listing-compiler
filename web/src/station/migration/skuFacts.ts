// Client-side port of api/skufacts.py — stable SKU fact IDs + deterministic
// fact-reference extraction. Used for the local-sample path and for media-node
// asset dependencies; the backend remains the source of truth when reachable.

const UNIT = '(?:°\\s*[cf]|℃|℉|ml|cl|l|oz|lbs?|cm|mm|kg|mah|hz|inch(?:es)?|ft|%)';
const NUM_TOKEN_RE = new RegExp(`-?\\d+(?:\\.\\d+)?\\s*${UNIT}?`, 'gi');
const ASCII_WORD_RE = /[a-z]{4,}/g;
const CJK_RUN_RE = /[一-鿿]{2,}/g;
const FACT_ID_RE = /^fact-(\d+)$/;

const STOPWORDS = new Set([
  'with', 'that', 'this', 'from', 'your', 'have', 'will', 'into', 'than',
  'them', 'then', 'they', 'and', 'the', 'for', 'not',
]);

export function parseSkuFacts(productName: string, points: string): Record<string, string> {
  const facts: Record<string, string> = {};
  const name = (productName || '').trim();
  if (name) facts.name = name;
  let idx = 0;
  for (const raw of (points || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    idx += 1;
    facts[`fact-${idx}`] = line;
  }
  return facts;
}

export function factSortKey(id: string): [number, number, string] {
  if (id === 'name') return [0, 0, ''];
  const m = FACT_ID_RE.exec(id);
  if (m) return [1, Number(m[1]), ''];
  return [2, 0, id];
}

export function salientTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const lowered = text.toLowerCase();
  const compact = lowered.replace(/\s+/g, '');

  for (const m of lowered.matchAll(NUM_TOKEN_RE)) {
    const tok = m[0].replace(/\s+/g, '');
    if (!/^-?\d/.test(tok)) continue;
    tokens.add(tok);
    const num = /^-?\d+(?:\.\d+)?/.exec(tok);
    if (num) {
      const digits = num[0].replace('-', '').split('.')[0];
      if (digits.length >= 2) tokens.add(num[0].replace('-', ''));
    }
  }
  for (const m of lowered.matchAll(ASCII_WORD_RE)) {
    if (!STOPWORDS.has(m[0])) tokens.add(m[0]);
  }
  for (const m of text.matchAll(CJK_RUN_RE)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  if (compact.includes('bpa')) tokens.add('bpa');

  return new Set([...tokens].filter(t => t.length >= 2));
}

function isCjk(token: string): boolean {
  return !!token && token.charCodeAt(0) >= 0x4e00 && token.charCodeAt(0) <= 0x9fff;
}

export function computeFactRefs(text: string, facts: Record<string, string>): string[] {
  if (!text) return [];
  const compact = text.toLowerCase().replace(/\s+/g, '');
  const refs = new Set<string>();
  for (const [factId, value] of Object.entries(facts)) {
    for (const token of salientTokens(value)) {
      const hit = isCjk(token) ? text.includes(token) : compact.includes(token);
      if (hit) {
        refs.add(factId);
        break;
      }
    }
  }
  return [...refs].sort((a, b) => {
    const ka = factSortKey(a);
    const kb = factSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });
}

export function diffFacts(
  before: Record<string, string>,
  after: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added = Object.keys(after).filter(k => !(k in before));
  const removed = Object.keys(before).filter(k => !(k in after));
  const changed = Object.keys(after).filter(
    k => k in before && before[k].trim() !== after[k].trim(),
  );
  const sort = (xs: string[]) =>
    xs.sort((a, b) => {
      const ka = factSortKey(a);
      const kb = factSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
    });
  return { added: sort(added), removed: sort(removed), changed: sort(changed) };
}
