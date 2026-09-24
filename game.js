// The rules of the journal, and nothing else: no DOM, no fetch, no storage.
// Every function takes a state and returns a new one; the state is plain
// JSON so it can be saved as it is.
//
// state = {
//   turn,                  1, 2, 3...: one per player turn
//   active,                whose turn it is: 'me', 'opp1', 'opp2', 'opp3'
//   opponents,             how many are seated, 1 to MAX_OPPONENTS
//   startingLife,          what a newly seated opponent starts at
//   life: { me, opp1, ... },
//   cmdDamage: { recipient: { commanderUid: n } },  absent means none
//   cards: [instance],     every card on the table, in the order added
//   log: [{ turn, text }],
//   nextUid,
// }
//
// instance = { uid, owner, zone, tapped, commander?, counters?, attachedTo?, ...card }
// where card is what scryfall.js's parseCard returns,
// counters = [{ id, kind, count, x, y }]: one square per kind, at a place
// on the card given as fractions of its box, and attachedTo is the uid of
// the creature an equipment is on, absent when it is on nothing.

export const MAX_OPPONENTS = 3;
export const ZONES = ['hand', 'battlefield', 'graveyard', 'exile', 'command'];

// Seats, in turn order: me first, then the opponents as numbered.
export const players = (state) => ['me', ...Array.from({ length: state.opponents }, (_, i) => `opp${i + 1}`)];

// "I play", "opponent 2 plays"; "my", "opponent 2's". With a single
// opponent the number is left off.
export function label(state, owner, form = 'subject') {
  if (owner === 'me') return form === 'possessive' ? 'my' : 'I';
  const name = state.opponents > 1 ? `opponent ${owner.slice(3)}` : 'opponent';
  return form === 'possessive' ? `${name}'s` : name;
}
const zoneName = (zone) => (zone === 'command' ? 'command zone' : zone);

const PERMANENT_TYPES = ['Creature', 'Land', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'];

// What a card is, is what its front face says: a modal card with a land on
// the back is still not a land, and none of these ever read past the //.
const front = (card) => (card.typeLine || '').split('//')[0];

// Instants and sorceries are the only card types that never stay on the
// battlefield. Everything else, including a card whose front face is a
// creature and back face an anything, is a permanent.
export function isPermanent(card) {
  const face = front(card);
  if (/\b(Instant|Sorcery)\b/.test(face)) return false;
  return PERMANENT_TYPES.some((t) => new RegExp(`\\b${t}\\b`).test(face));
}

// Lands sit in their own row on the battlefield.
export const isLand = (card) => /\bLand\b/.test(front(card));
// What can be attached to a creature, and what can be equipped.
export const isEquipment = (card) => /\bEquipment\b/.test(front(card));
export const isCreature = (card) => /\bCreature\b/.test(front(card));

export const cardsIn = (state, owner, zone) => state.cards.filter((c) => c.owner === owner && c.zone === zone);
const find = (state, uid) => state.cards.find((c) => c.uid === uid);

const say = (state, text) => ({ ...state, log: [...state.log, { turn: state.turn, text }] });
const who = (state, owner, verb) => `${label(state, owner)} ${verb}${owner === 'me' ? '' : 's'}`;
const patch = (state, uid, changes) => ({
  ...state,
  cards: state.cards.map((c) => (c.uid === uid ? { ...c, ...changes } : c)),
});

// Attached to nothing, and the key gone with it, so a save never carries an
// attachment to nowhere.
const detach = (c) => { const { attachedTo, ...rest } = c; return rest; };

// An attachment does not outlive either card's stay on the battlefield: the
// equipment that leaves comes off whatever it was on, and the creature that
// leaves — or is taken off the table — takes every equipment on it off. A
// uid pointing at a card that is no longer beside it would draw an
// equipment tucked in behind nothing. Whatever moved says so in the log
// itself, so neither of these is worth a line of its own.
const attachmentEnds = (c, uid) => (c.uid === uid ? Boolean(c.attachedTo) : c.attachedTo === uid);
const detachAround = (state, uid) => (state.cards.some((c) => attachmentEnds(c, uid))
  ? { ...state, cards: state.cards.map((c) => (attachmentEnds(c, uid) ? detach(c) : c)) }
  : state);

const clampOpponents = (n) => Math.max(1, Math.min(MAX_OPPONENTS, Math.round(Number(n)) || 1));
// A life total is whatever the table agreed on, not always 20 — but it has
// to be a real number to seat anyone at.
const clampLife = (life) => {
  const n = Number(life);
  return Math.max(1, Math.min(999, Math.round(Number.isFinite(n) ? n : 20)));
};

export function newGame({ opponents = 1, life = 20 } = {}) {
  const n = clampOpponents(opponents);
  const total = clampLife(life);
  const seats = players({ opponents: n });
  return say({
    turn: 1,
    active: 'me',
    opponents: n,
    startingLife: total,
    life: Object.fromEntries(seats.map((p) => [p, total])),
    cmdDamage: {},
    cards: [],
    log: [],
    nextUid: 1,
  }, `new game: ${n} opponent${n === 1 ? '' : 's'}, ${total} life`);
}

// Start over at the same table: the same seats, the same starting life.
export function resetGame(state) {
  const fresh = newGame({ opponents: state.opponents, life: state.startingLife });
  return { ...fresh, log: [{ turn: 1, text: fresh.log[0].text.replace('new game', 'game reset') }] };
}

// Seat or unseat opponents mid-game. An opponent with cards on the table
// cannot be unseated; clear their cards first. New seats start at the
// game's starting life; if the unseated opponent's turn was in progress,
// the turn comes back to me.
export function setOpponents(state, n) {
  const count = clampOpponents(n);
  if (count === state.opponents || count !== Math.round(Number(n))) return state;
  if (count < state.opponents && state.cards.some((c) => c.owner !== 'me' && Number(c.owner.slice(3)) > count)) return state;
  const next = { ...state, opponents: count };
  const seats = players(next);
  next.life = Object.fromEntries(seats.map((p) => [p, state.life[p] ?? state.startingLife]));
  // An empty seat keeps nothing: were it filled again it would be a new
  // player, not the one who took that commander damage.
  next.cmdDamage = Object.fromEntries(seats.filter((p) => state.cmdDamage?.[p]).map((p) => [p, state.cmdDamage[p]]));
  if (!seats.includes(state.active)) next.active = 'me';
  return say(next, `${count} opponent${count === 1 ? '' : 's'} at the table`);
}

// A card comes to the table. Mine go to my hand, to be played from there;
// the opponent's are seen only as they are played, so theirs go straight
// to the battlefield, or the graveyard if they cannot stay.
export function addCard(state, card, owner, zone) {
  const dest = zone ?? (owner === 'me' ? 'hand' : isPermanent(card) ? 'battlefield' : 'graveyard');
  const instance = { ...card, uid: String(state.nextUid), owner, zone: dest, tapped: false };
  if (dest === 'command') instance.commander = true;
  const text = dest === 'hand' ? `${who(state, owner, 'draw')} ${card.name}`
    : dest === 'battlefield' ? `${who(state, owner, 'play')} ${card.name}`
    : dest === 'graveyard' && !isPermanent(card) ? `${who(state, owner, 'cast')} ${card.name}`
    : `${who(state, owner, 'put')} ${card.name} in ${zoneName(dest)}`;
  return say({ ...state, cards: [...state.cards, instance], nextUid: state.nextUid + 1 }, text);
}

// From hand: a permanent lands on the battlefield, a spell resolves to the
// graveyard.
export function play(state, uid) {
  const c = find(state, uid);
  if (!c || c.zone !== 'hand') return state;
  // The way onto the table is shut as well as the ways off it: whatever a
  // save was made to say, a card played from hand arrives on nothing and
  // wearing nothing.
  const from = detachAround(state, uid);
  return isPermanent(c)
    ? say(patch(from, uid, { zone: 'battlefield', tapped: false, counters: [] }), `${who(state, c.owner, 'play')} ${c.name}`)
    : say(patch(from, uid, { zone: 'graveyard', counters: [] }), `${who(state, c.owner, 'cast')} ${c.name}`);
}

export function toggleTap(state, uid) {
  const c = find(state, uid);
  if (!c || c.zone !== 'battlefield' || !isPermanent(c)) return state;
  return say(patch(state, uid, { tapped: !c.tapped }), `${who(state, c.owner, c.tapped ? 'untap' : 'tap')} ${c.name}`);
}

export function moveTo(state, uid, zone) {
  const c = find(state, uid);
  if (!c || !ZONES.includes(zone) || c.zone === zone) return state;
  // Once a card has been in the command zone it is the commander wherever
  // it goes, so it can be told apart on the battlefield.
  // Counters come off a card that changes zone, as they do in the game, and
  // so does whatever it was equipping or equipped with.
  const changes = { zone, tapped: false, counters: [] };
  if (zone === 'command') changes.commander = true;
  return say(patch(detachAround(state, uid), uid, changes), `${label(state, c.owner, 'possessive')} ${c.name} to ${zoneName(zone)}`);
}

// For a mistake: the card was never there.
export function remove(state, uid) {
  const c = find(state, uid);
  if (!c) return state;
  const gone = detachAround(state, uid);
  const next = { ...gone, cards: gone.cards.filter((x) => x.uid !== uid) };
  // The card was never there, so neither was the damage it dealt: a tally
  // must not outlive the commander it is counted from.
  if (c.commander) {
    next.cmdDamage = Object.fromEntries(Object.entries(state.cmdDamage ?? {})
      .map(([p, tallies]) => [p, Object.fromEntries(Object.entries(tallies).filter(([id]) => id !== uid))]));
  }
  return say(next, `${who(state, c.owner, 'remove')} ${c.name}`);
}

// Another of the same card, right beside the original: a token copy, a
// clone, a second Forest. Same owner and zone; untapped, no counters,
// attached to nothing, and not the commander even if the original is.
export function copyCard(state, uid) {
  const i = state.cards.findIndex((c) => c.uid === uid);
  if (i < 0) return state;
  const orig = state.cards[i];
  const { commander, attachedTo, ...rest } = orig;
  const copy = { ...rest, uid: String(state.nextUid), tapped: false, counters: [] };
  const cards = [...state.cards.slice(0, i + 1), copy, ...state.cards.slice(i + 1)];
  const verb = orig.owner === 'me' ? 'I copy' : `${label(state, orig.owner)} copies`;
  return say({ ...state, cards, nextUid: state.nextUid + 1 }, `${verb} ${orig.name}`);
}

// An equipment goes on a creature its owner controls, and is drawn tucked
// in behind it from then on. Only its owner's creatures: each player's
// board is drawn as their own, so a card tucked behind one across the table
// would be tucked in behind nothing there is room for. Moving it to another
// creature is the same attaching again; putting it back on the one it is
// already on is nothing happening.
export function equip(state, uid, hostUid) {
  const eq = find(state, uid);
  const host = find(state, hostUid);
  if (!eq || !host || uid === hostUid) return state;
  if (!isEquipment(eq) || !isCreature(host)) return state;
  if (eq.zone !== 'battlefield' || host.zone !== 'battlefield') return state;
  if (eq.owner !== host.owner || eq.attachedTo === hostUid) return state;
  return say(patch(state, uid, { attachedTo: hostUid }), `${who(state, eq.owner, 'equip')} ${host.name} with ${eq.name}`);
}

// Off again, and back to a place of its own in the row.
export function unequip(state, uid) {
  const eq = find(state, uid);
  const host = eq?.attachedTo ? find(state, eq.attachedTo) : null;
  if (!host) return state; // on nothing; nothing on the table points at a card that has gone
  return say({ ...state, cards: state.cards.map((c) => (c.uid === uid ? detach(c) : c)) },
    `${label(state, eq.owner, 'possessive')} ${eq.name} comes off ${host.name}`);
}

// Where a card sits among its neighbours on the battlefield. state.cards is
// the order everything is drawn in, so putting a card in a new place is a
// move within that array; beforeUid is the card to drop in front of, or null
// for the end of the run.
//
// A run is one owner's half of one battlefield row, and a card never leaves
// it: the rows are told apart by isLand, so a card dragged across them would
// contradict what it is. Like where a counter square sits, this is
// presentation and not a move in the game, so it says nothing in the log.
export function reorderCard(state, uid, beforeUid) {
  const i = state.cards.findIndex((c) => c.uid === uid);
  if (i < 0 || uid === beforeUid) return state;
  const c = state.cards[i];
  if (c.zone !== 'battlefield') return state;
  // An attached equipment is drawn behind its host wherever the host goes,
  // so it has no place of its own in the row to be moved along.
  if (c.attachedTo) return state;
  const beside = (x) => x.owner === c.owner && x.zone === c.zone && isLand(x) === isLand(c);
  const rest = [...state.cards.slice(0, i), ...state.cards.slice(i + 1)];
  let at;
  if (beforeUid == null) {
    // After the last of its own run, rather than the end of the whole array:
    // that would look the same on the table and churn the save for nothing.
    const last = rest.reduce((k, x, j) => (beside(x) ? j : k), -1);
    if (last < 0) return state; // nothing to sit behind: the run is the card itself
    at = last + 1;
  } else {
    at = rest.findIndex((x) => x.uid === beforeUid);
    if (at < 0 || !beside(rest[at])) return state;
  }
  // What the table shows is the order of the run, so an order the run
  // already had is no reorder at all — even when the card has stepped over
  // something it is never drawn beside, another player's card or the other
  // row's, which lies between the two in the array and nowhere else.
  const cards = [...rest.slice(0, at), c, ...rest.slice(at)];
  const order = (list) => list.filter(beside).map((x) => x.uid).join();
  if (order(cards) === order(state.cards)) return state;
  return { ...state, cards };
}

// The turn passes round the table. The player whose turn begins untaps;
// everyone else's permanents stay as they are.
export function nextTurn(state) {
  const seats = players(state);
  const active = seats[(seats.indexOf(state.active) + 1) % seats.length];
  const next = {
    ...state,
    turn: state.turn + 1,
    active,
    cards: state.cards.map((c) => (c.owner === active && c.zone === 'battlefield' ? { ...c, tapped: false } : c)),
  };
  return say(next, `turn ${next.turn}: ${label(next, active, 'possessive')} turn`);
}

export function adjustLife(state, player, delta) {
  if (!players(state).includes(player) || !delta) return state;
  const life = { ...state.life, [player]: state.life[player] + delta };
  return say({ ...state, life }, `${who(state, player, delta > 0 ? 'gain' : 'lose')} ${Math.abs(delta)} life (${life[player]})`);
}

// Set a total outright, for correcting a life total the dialog can type in.
// Unlike adjustLife this may go negative or to zero: the journal records
// what happened, it does not enforce the rules.
export function setLife(state, player, value) {
  const n = Number(value);
  if (!players(state).includes(player) || !Number.isFinite(n)) return state;
  const rounded = Math.round(n);
  if (rounded === state.life[player]) return state;
  const life = { ...state.life, [player]: rounded };
  return say({ ...state, life }, `${label(state, player, 'possessive')} life is now ${rounded}`);
}

// --- commander damage -------------------------------------------------

// Every card that has been in a command zone, in the order they arrived.
export const commanders = (state) => state.cards.filter((c) => c.commander);

// Twenty-one from one commander is lethal, so the tally is kept per card
// and not per player: partners each hit for their own.
//
// The damage takes the life with it, in the one action: that is what
// happens at the table, and a journal that made you enter the hit twice
// would be worse than the paper it replaces. A correction gives back only
// what was applied, so pulling a tally of 3 down by 5 returns 3 life.
export function adjustCommanderDamage(state, recipient, commanderUid, delta) {
  const n = Math.round(Number(delta));
  const c = find(state, commanderUid);
  if (!players(state).includes(recipient) || !Number.isFinite(n) || n === 0) return state;
  // A commander deals no commander damage to the player it belongs to.
  if (!c?.commander || c.owner === recipient) return state;

  const tallies = state.cmdDamage?.[recipient] ?? {};
  const was = tallies[commanderUid] ?? 0;
  const now = Math.max(0, was + n);
  if (now === was) return state;
  // Zero is written as nothing at all, so a save does not grow an entry
  // for every pair at the table.
  const next = { ...tallies };
  if (now === 0) delete next[commanderUid];
  else next[commanderUid] = now;

  const applied = now - was;
  const life = { ...state.life, [recipient]: state.life[recipient] - applied };
  const amount = applied > 0 ? `${applied}` : `−${-applied}`;
  let out = say(
    { ...state, cmdDamage: { ...state.cmdDamage, [recipient]: next }, life },
    `${label(state, recipient, 'possessive')} ${amount} from ${c.name} (${now}), ${life[recipient]} life`,
  );
  // Only on the crossing: 21 to 22 is not news.
  if (now >= 21 && was < 21) {
    // "dead to commander damage from X", never "X's commander damage":
    // half the commanders in the game have a name ending in s or in an
    // apostrophe, and a possessive on top of one reads badly.
    out = say(out, `${label(state, recipient)} ${recipient === 'me' ? 'am' : 'is'} dead to commander damage from ${c.name} (21)`);
  }
  return out;
}

// --- counters ---------------------------------------------------------

export const COUNTER_LABEL_MAX = 16;
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// "+1/+1", "-1/-1", "+2/+0": a power/toughness change, signs made explicit
// so "1/1" and "+1/+1" are the same kind. Anything else is a named counter,
// "lore", "time", "loyalty", kept lowercase for the same reason.
export function parseCounterKind(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > COUNTER_LABEL_MAX) return null;
  const m = t.match(/^([+-]?)(\d+)\s*\/\s*([+-]?)(\d+)$/);
  return m ? `${m[1] || '+'}${m[2]}/${m[3] || '+'}${m[4]}` : t.toLowerCase();
}

const counterText = (state, c, kind, delta, count) => {
  const n = Math.abs(delta);
  const what = `${n === 1 ? 'a' : n} ${kind} counter${n === 1 ? '' : 's'}`;
  return delta > 0
    ? `${who(state, c.owner, 'put')} ${what} on ${c.name} (${count})`
    : `${who(state, c.owner, 'remove')} ${what} from ${c.name} (${count})`;
};

// One more counter of a kind. A kind already on the card stacks onto its
// square; a new kind gets a square of its own, at the place given.
export function addCounter(state, uid, kindText, at = { x: 0.5, y: 0.5 }) {
  const c = find(state, uid);
  const kind = parseCounterKind(kindText);
  if (!c || !kind) return state;
  const counters = c.counters ?? [];
  const existing = counters.find((k) => k.kind === kind);
  if (existing) return adjustCounter(state, uid, existing.id, 1);
  const square = { id: String(state.nextUid), kind, count: 1, x: clamp01(at.x), y: clamp01(at.y) };
  const next = { ...patch(state, uid, { counters: [...counters, square] }), nextUid: state.nextUid + 1 };
  return say(next, counterText(state, c, kind, 1, 1));
}

// More or fewer of a square's counters. At zero the square goes.
export function adjustCounter(state, uid, id, delta) {
  const c = find(state, uid);
  const k = c?.counters?.find((x) => x.id === id);
  if (!k || !delta) return state;
  const count = Math.max(0, k.count + delta);
  const counters = count === 0 ? c.counters.filter((x) => x.id !== id) : c.counters.map((x) => (x.id === id ? { ...x, count } : x));
  return say(patch(state, uid, { counters }), counterText(state, c, k.kind, count - k.count || delta, count));
}

// Where the square sits on the card: fractions of its box, kept on it.
// Only the look changes, so there is no log line.
export function moveCounter(state, uid, id, x, y) {
  const c = find(state, uid);
  if (!c?.counters?.some((k) => k.id === id)) return state;
  return patch(state, uid, { counters: c.counters.map((k) => (k.id === id ? { ...k, x: clamp01(x), y: clamp01(y) } : k)) });
}

// A saved game back from JSON, or null if it is not one. A save from
// before there were several opponents had a single 'opp'; it becomes opp1.
export function load(json) {
  let s;
  try { s = JSON.parse(json); } catch { return null; }
  if (!s || typeof s !== 'object') return null;
  if (!Array.isArray(s.cards) || !Array.isArray(s.log) || !Number.isInteger(s.nextUid)) return null;
  if (s.opponents === undefined && s.life && 'opp' in s.life) {
    const { opp, ...life } = s.life;
    s = {
      ...s,
      opponents: 1,
      startingLife: 20,
      active: s.active === 'opp' ? 'opp1' : s.active,
      life: { ...life, opp1: opp },
      cards: s.cards.map((c) => (c.owner === 'opp' ? { ...c, owner: 'opp1' } : c)),
    };
  }
  if (!Number.isInteger(s.turn) || !Number.isInteger(s.opponents)) return null;
  const seats = players(s);
  if (!seats.includes(s.active) || !s.life || seats.some((p) => typeof s.life[p] !== 'number')) return null;
  if (typeof s.startingLife !== 'number') s = { ...s, startingLife: 20 };
  // A save from before commander damage was kept simply has none of it.
  if (!s.cmdDamage || typeof s.cmdDamage !== 'object' || Array.isArray(s.cmdDamage)) s = { ...s, cmdDamage: {} };
  // An attachment is only ever held by an equipment on the battlefield and
  // only ever points at a creature on one, so anything else is dropped
  // rather than left to strand a card: drawn tucked in behind nothing, in
  // no run to be reordered along, and offered no way off. Mended, not
  // rejected: a bad pointer is no reason to throw a whole game away.
  return {
    ...s,
    cards: s.cards.map((c) => {
      if (c.attachedTo == null) return c;
      const host = find(s, c.attachedTo);
      const ok = isEquipment(c) && c.zone === 'battlefield' && host?.zone === 'battlefield' && isCreature(host);
      return ok ? c : detach(c);
    }),
  };
}
