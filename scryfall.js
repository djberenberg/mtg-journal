// The Scryfall client. Two requests, and one function that turns a Scryfall
// card object into the smaller shape the game keeps. Everything that hits
// the network takes `fetch` as an option, so tests can hand in a fake.
//
// Scryfall asks clients to identify themselves, to send Accept, and to keep
// under about ten requests a second. The page debounces its autocomplete
// for that reason; nothing here retries.
const API = 'https://api.scryfall.com';
const HEADERS = { Accept: 'application/json' };

export class NotFound extends Error {}

const firstFace = (json) => json.card_faces?.[0] ?? json;

// A card as the game keeps it: plain JSON, only what the table shows.
// Double-faced cards keep their images and text on card_faces; the front
// face stands in for the card, and the back is kept for a flip later.
export function parseCard(json) {
  const face = firstFace(json);
  const faces = json.card_faces ?? [];
  const back = faces[1];
  return {
    scryfallId: json.id,
    name: json.name,
    manaCost: json.mana_cost ?? face.mana_cost ?? '',
    cmc: json.cmc ?? 0,
    typeLine: json.type_line ?? face.type_line ?? '',
    oracleText: json.oracle_text ?? faces.map((f) => `${f.name}: ${f.oracle_text ?? ''}`).join('\n\n'),
    power: face.power ?? null,
    toughness: face.toughness ?? null,
    loyalty: face.loyalty ?? null,
    colors: json.colors ?? face.colors ?? [],
    image: json.image_uris?.normal ?? face.image_uris?.normal ?? null,
    imageSmall: json.image_uris?.small ?? face.image_uris?.small ?? null,
    imageBack: back?.image_uris?.normal ?? null,
    set: json.set ?? '',
    collectorNumber: json.collector_number ?? '',
    uri: json.scryfall_uri ?? '',
  };
}

async function get(path, { fetch = globalThis.fetch, signal } = {}) {
  const res = await fetch(`${API}${path}`, { headers: HEADERS, signal });
  const body = await res.json();
  if (body.object === 'error') {
    throw new (body.status === 404 ? NotFound : Error)(body.details || `Scryfall ${body.status}`);
  }
  return body;
}

// Up to 20 card names that start with, or contain, the query. Scryfall wants
// at least two characters; below that, answer nothing rather than ask.
export async function autocomplete(query, opts) {
  const q = query.trim();
  if (q.length < 2) return [];
  const body = await get(`/cards/autocomplete?q=${encodeURIComponent(q)}`, opts);
  return body.data ?? [];
}

// One card by name. Fuzzy, so "bolt" finds Lightning Bolt and a typo or two
// is forgiven; an ambiguous name is a NotFound, with Scryfall saying so.
export async function lookup(name, opts) {
  const body = await get(`/cards/named?fuzzy=${encodeURIComponent(name.trim())}`, opts);
  return parseCard(body);
}
