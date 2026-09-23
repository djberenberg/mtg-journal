// The rules of the journal, and nothing else: no DOM, no fetch, no storage.
// Every function takes a state and returns a new one; the state is plain
// JSON so it can be saved as it is.
//
// state = {
//   turn,                  1, 2, 3...: one per player turn
//   active: 'me' | 'opp',  whose turn it is
//   life: { me, opp },
//   cards: [instance],     every card on the table, in the order added
//   log: [{ turn, text }],
//   nextUid,
// }
//
// instance = { uid, owner: 'me' | 'opp', zone, tapped, ...card }
// where card is what scryfall.js's parseCard returns.

export const PLAYERS = ['me', 'opp'];
export const ZONES = ['hand', 'battlefield', 'graveyard', 'exile'];
const LABEL = { me: 'I', opp: 'opponent' };
const VERB = { me: '', opp: 's' }; // "I play", "opponent plays"

const PERMANENT_TYPES = ['Creature', 'Land', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'];

// Instants and sorceries are the only card types that never stay on the
// battlefield. Everything else, including a card whose front face is a
// creature and back face an anything, is a permanent.
export function isPermanent(card) {
  const front = (card.typeLine || '').split('//')[0];
  if (/\b(Instant|Sorcery)\b/.test(front)) return false;
  return PERMANENT_TYPES.some((t) => new RegExp(`\\b${t}\\b`).test(front));
}

export const cardsIn = (state, owner, zone) => state.cards.filter((c) => c.owner === owner && c.zone === zone);
const find = (state, uid) => state.cards.find((c) => c.uid === uid);

const say = (state, text) => ({ ...state, log: [...state.log, { turn: state.turn, text }] });
const who = (owner, verb) => `${LABEL[owner]} ${verb}${VERB[owner]}`;
const patch = (state, uid, changes) => ({
  ...state,
  cards: state.cards.map((c) => (c.uid === uid ? { ...c, ...changes } : c)),
});

export function newGame() {
  return say({ turn: 1, active: 'me', life: { me: 20, opp: 20 }, cards: [], log: [], nextUid: 1 }, 'new game');
}

// A card comes to the table. Mine go to my hand, to be played from there;
// the opponent's are seen only as they are played, so theirs go straight
// to the battlefield, or the graveyard if they cannot stay.
export function addCard(state, card, owner, zone) {
  const dest = zone ?? (owner === 'me' ? 'hand' : isPermanent(card) ? 'battlefield' : 'graveyard');
  const instance = { ...card, uid: String(state.nextUid), owner, zone: dest, tapped: false };
  const text = dest === 'hand' ? `${who(owner, 'draw')} ${card.name}`
    : dest === 'battlefield' ? `${who(owner, 'play')} ${card.name}`
    : dest === 'graveyard' && !isPermanent(card) ? `${who(owner, 'cast')} ${card.name}`
    : `${who(owner, 'put')} ${card.name} in ${dest}`;
  return say({ ...state, cards: [...state.cards, instance], nextUid: state.nextUid + 1 }, text);
}

// From hand: a permanent lands on the battlefield, a spell resolves to the
// graveyard.
export function play(state, uid) {
  const c = find(state, uid);
  if (!c || c.zone !== 'hand') return state;
  return isPermanent(c)
    ? say(patch(state, uid, { zone: 'battlefield', tapped: false }), `${who(c.owner, 'play')} ${c.name}`)
    : say(patch(state, uid, { zone: 'graveyard' }), `${who(c.owner, 'cast')} ${c.name}`);
}

export function toggleTap(state, uid) {
  const c = find(state, uid);
  if (!c || c.zone !== 'battlefield' || !isPermanent(c)) return state;
  return say(patch(state, uid, { tapped: !c.tapped }), `${who(c.owner, c.tapped ? 'untap' : 'tap')} ${c.name}`);
}

export function moveTo(state, uid, zone) {
  const c = find(state, uid);
  if (!c || !ZONES.includes(zone) || c.zone === zone) return state;
  return say(patch(state, uid, { zone, tapped: false }), `${LABEL[c.owner] === 'I' ? 'my' : "opponent's"} ${c.name} to ${zone}`);
}

// For a mistake: the card was never there.
export function remove(state, uid) {
  const c = find(state, uid);
  if (!c) return state;
  return say({ ...state, cards: state.cards.filter((x) => x.uid !== uid) }, `${who(c.owner, 'remove')} ${c.name}`);
}

// The turn passes. The player whose turn begins untaps; the other's
// permanents stay as they are.
export function nextTurn(state) {
  const active = state.active === 'me' ? 'opp' : 'me';
  const next = {
    ...state,
    turn: state.turn + 1,
    active,
    cards: state.cards.map((c) => (c.owner === active && c.zone === 'battlefield' ? { ...c, tapped: false } : c)),
  };
  return say(next, `turn ${next.turn}: ${active === 'me' ? 'my' : "opponent's"} turn`);
}

export function adjustLife(state, player, delta) {
  if (!PLAYERS.includes(player) || !delta) return state;
  const life = { ...state.life, [player]: state.life[player] + delta };
  const verb = delta > 0 ? `gain${VERB[player]}` : `lose${VERB[player]}`;
  return say({ ...state, life }, `${LABEL[player]} ${verb} ${Math.abs(delta)} life (${life[player]})`);
}

// A saved game back from JSON, or null if it is not one.
export function load(json) {
  let s;
  try { s = JSON.parse(json); } catch { return null; }
  if (!s || typeof s !== 'object') return null;
  if (!Number.isInteger(s.turn) || !PLAYERS.includes(s.active)) return null;
  if (!s.life || typeof s.life.me !== 'number' || typeof s.life.opp !== 'number') return null;
  if (!Array.isArray(s.cards) || !Array.isArray(s.log) || !Number.isInteger(s.nextUid)) return null;
  return s;
}
