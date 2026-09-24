// The rules of the journal: zones, tapping, turns, life, and the log. Pure
// functions over a plain-JSON state, so the page only has to draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCard } from '../scryfall.js';
import {
  newGame, addCard, play, toggleTap, moveTo, remove, nextTurn, adjustLife, setLife,
  isPermanent, cardsIn, load, players, label, setOpponents, MAX_OPPONENTS, resetGame,
  parseCounterKind, addCounter, adjustCounter, moveCounter, isLand, copyCard,
} from '../game.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const BOLT = parseCard(fixture('bolt'));
const ELVES = parseCard(fixture('elves'));
const DELVER = parseCard(fixture('delver'));
const FOREST = parseCard(fixture('forest'));

const last = (s) => s.log[s.log.length - 1];
const only = (s, owner, zone) => { const c = cardsIn(s, owner, zone); assert.equal(c.length, 1); return c[0]; };

test('a new game: turn 1, my turn, one opponent, 20 life each, no cards, one log line', () => {
  const g = newGame();
  assert.equal(g.turn, 1);
  assert.equal(g.active, 'me');
  assert.equal(g.opponents, 1);
  assert.deepEqual(players(g), ['me', 'opp1']);
  assert.deepEqual(g.life, { me: 20, opp1: 20 });
  assert.deepEqual(g.cards, []);
  assert.equal(g.log.length, 1);
  assert.equal(last(g).turn, 1);
});

test('isPermanent: creatures, lands, artifacts, enchantments, planeswalkers, battles; not instants or sorceries', () => {
  for (const t of ['Creature — Elf Druid', 'Basic Land — Forest', 'Artifact — Equipment', 'Enchantment — Aura', 'Legendary Planeswalker — Jace', 'Battle — Siege', 'Legendary Artifact Creature — Golem', 'Kindred Instant — Elf'.replace('Instant', 'Sorcery').replace('Sorcery', 'Enchantment')]) {
    assert.equal(isPermanent({ typeLine: t }), true, t);
  }
  for (const t of ['Instant', 'Sorcery', 'Kindred Instant — Elf', 'Instant — Adventure']) {
    assert.equal(isPermanent({ typeLine: t }), false, t);
  }
  assert.equal(isPermanent(DELVER), true); // "Creature — Human Wizard // Creature — Human Insect"
});

test('adding a card for me puts it in my hand; for the opponent, straight onto their battlefield', () => {
  let g = addCard(newGame(), ELVES, 'me');
  const mine = only(g, 'me', 'hand');
  assert.equal(mine.name, 'Llanowar Elves');
  assert.equal(mine.owner, 'me');
  assert.equal(mine.tapped, false);
  assert.match(last(g).text, /Llanowar Elves/);

  g = addCard(g, ELVES, 'opp1');
  const theirs = only(g, 'opp1', 'battlefield');
  assert.equal(theirs.owner, 'opp1');
  assert.notEqual(theirs.uid, mine.uid, 'two copies of one card are two instances');
  assert.equal(cardsIn(g, 'opp1', 'hand').length, 0);
});

test('an opponent\'s instant goes to their graveyard, not the battlefield', () => {
  const g = addCard(newGame(), BOLT, 'opp1');
  assert.equal(cardsIn(g, 'opp1', 'battlefield').length, 0);
  only(g, 'opp1', 'graveyard');
});

test('a zone can be chosen explicitly', () => {
  const g = addCard(newGame(), ELVES, 'opp1', 'hand');
  only(g, 'opp1', 'hand');
});

test('play moves a permanent from my hand to the battlefield, untapped', () => {
  let g = addCard(newGame(), ELVES, 'me');
  g = play(g, only(g, 'me', 'hand').uid);
  assert.equal(cardsIn(g, 'me', 'hand').length, 0);
  const c = only(g, 'me', 'battlefield');
  assert.equal(c.tapped, false);
  assert.match(last(g).text, /I play Llanowar Elves/);
});

test('play sends an instant or sorcery to the graveyard once cast', () => {
  let g = addCard(newGame(), BOLT, 'me');
  g = play(g, only(g, 'me', 'hand').uid);
  only(g, 'me', 'graveyard');
  assert.match(last(g).text, /I cast Lightning Bolt/);
});

test('play only applies to cards in hand', () => {
  let g = addCard(newGame(), ELVES, 'opp1');
  const uid = only(g, 'opp1', 'battlefield').uid;
  assert.equal(play(g, uid), g);
});

test('toggleTap taps and untaps a permanent on the battlefield, and logs each', () => {
  let g = addCard(newGame(), ELVES, 'opp1');
  const uid = only(g, 'opp1', 'battlefield').uid;
  g = toggleTap(g, uid);
  assert.equal(only(g, 'opp1', 'battlefield').tapped, true);
  assert.match(last(g).text, /taps Llanowar Elves/);
  g = toggleTap(g, uid);
  assert.equal(only(g, 'opp1', 'battlefield').tapped, false);
  assert.match(last(g).text, /untaps Llanowar Elves/);
});

test('toggleTap ignores cards that are not on the battlefield, and unknown uids', () => {
  const g = addCard(newGame(), ELVES, 'me');
  const uid = only(g, 'me', 'hand').uid;
  assert.equal(toggleTap(g, uid), g);
  assert.equal(toggleTap(g, 'nope'), g);
});

test('moveTo moves a card between any zones; arriving on the battlefield it is untapped', () => {
  let g = addCard(newGame(), ELVES, 'opp1');
  const uid = only(g, 'opp1', 'battlefield').uid;
  g = toggleTap(g, uid);
  g = moveTo(g, uid, 'exile');
  only(g, 'opp1', 'exile');
  assert.match(last(g).text, /Llanowar Elves to exile/);
  g = moveTo(g, uid, 'battlefield');
  assert.equal(only(g, 'opp1', 'battlefield').tapped, false);
  g = moveTo(g, uid, 'hand');
  only(g, 'opp1', 'hand');
  assert.equal(moveTo(g, uid, 'hand'), g, 'already there: no change, no log line');
  assert.equal(moveTo(g, uid, 'library'), g, 'not a zone we track');
});

test('remove deletes an instance outright, for fixing a mistake', () => {
  let g = addCard(addCard(newGame(), ELVES, 'me'), BOLT, 'me');
  const uid = cardsIn(g, 'me', 'hand')[0].uid;
  g = remove(g, uid);
  assert.equal(g.cards.length, 1);
  assert.match(last(g).text, /I remove Llanowar Elves/);
  assert.equal(remove(g, 'nope'), g);
});

test('nextTurn advances the turn, passes it over, and untaps only the new active player\'s permanents', () => {
  let g = addCard(addCard(newGame(), ELVES, 'me', 'battlefield'), ELVES, 'opp1');
  const mine = only(g, 'me', 'battlefield').uid;
  const theirs = only(g, 'opp1', 'battlefield').uid;
  g = toggleTap(toggleTap(g, mine), theirs);
  g = nextTurn(g);
  assert.equal(g.turn, 2);
  assert.equal(g.active, 'opp1');
  assert.equal(only(g, 'opp1', 'battlefield').tapped, false, 'the opponent untaps at the start of their turn');
  assert.equal(only(g, 'me', 'battlefield').tapped, true, 'mine stay tapped');
  assert.equal(last(g).turn, 2);
  g = nextTurn(g);
  assert.equal(g.turn, 3);
  assert.equal(g.active, 'me');
  assert.equal(only(g, 'me', 'battlefield').tapped, false);
});

test('adjustLife changes a total and logs the result', () => {
  let g = adjustLife(newGame(), 'opp1', -3);
  assert.equal(g.life.opp1, 17);
  assert.equal(g.life.me, 20);
  assert.match(last(g).text, /opponent.*17/);
  g = adjustLife(g, 'me', 2);
  assert.equal(g.life.me, 22);
  assert.equal(adjustLife(g, 'me', 0), g);
});

test('setLife sets a total outright and logs it', () => {
  const g = setLife(newGame(), 'me', 34);
  assert.equal(g.life.me, 34);
  assert.match(last(g).text, /my life is now 34/);
});

test('setLife sets a named opponent\'s life, with the possessive label', () => {
  const g = setLife(newGame({ opponents: 2 }), 'opp2', 12);
  assert.equal(g.life.opp2, 12);
  assert.match(last(g).text, /opponent 2's life is now 12/);
});

test('setLife accepts zero and negative totals: the journal does not enforce the rules', () => {
  let g = setLife(newGame(), 'me', 0);
  assert.equal(g.life.me, 0);
  g = setLife(g, 'me', -5);
  assert.equal(g.life.me, -5);
  assert.match(last(g).text, /my life is now -5/);
});

test('setLife rounds a fractional total', () => {
  const g = setLife(newGame(), 'me', 33.6);
  assert.equal(g.life.me, 34);
});

test('setLife refuses an unknown player, a non-numeric value, or no change', () => {
  const g = newGame();
  assert.equal(setLife(g, 'opp2', 10), g, 'not at the table');
  assert.equal(setLife(g, 'me', 'x'), g, 'not a number');
  assert.equal(setLife(g, 'me', 20), g, 'already there');
});

test('every log line carries the turn it happened on', () => {
  let g = nextTurn(addCard(newGame(), ELVES, 'me'));
  g = play(g, only(g, 'me', 'hand').uid);
  assert.deepEqual(g.log.map((l) => l.turn), [1, 1, 2, 2]);
});

test('no function mutates the state it was given', () => {
  const g0 = addCard(newGame(), ELVES, 'opp1');
  const frozen = JSON.stringify(g0);
  const uid = only(g0, 'opp1', 'battlefield').uid;
  toggleTap(g0, uid); moveTo(g0, uid, 'exile'); remove(g0, uid); nextTurn(g0); adjustLife(g0, 'me', -1); addCard(g0, BOLT, 'me');
  assert.equal(JSON.stringify(g0), frozen);
});

test('load migrates a save from before there were several opponents', () => {
  const old = { turn: 3, active: 'opp', life: { me: 18, opp: 12 }, cards: [{ ...ELVES, uid: '1', owner: 'opp', zone: 'battlefield', tapped: true }], log: [{ turn: 1, text: 'new game' }], nextUid: 2 };
  const g = load(JSON.stringify(old));
  assert.equal(g.opponents, 1);
  assert.equal(g.active, 'opp1');
  assert.deepEqual(g.life, { me: 18, opp1: 12 });
  assert.equal(g.startingLife, 20);
  assert.equal(only(g, 'opp1', 'battlefield').tapped, true);
});

test('state is plain JSON, and load accepts a saved game but not junk', () => {
  const g = nextTurn(addCard(newGame(), DELVER, 'me'));
  const back = load(JSON.stringify(g));
  assert.deepEqual(back, g);
  assert.equal(load('null'), null);
  assert.equal(load('{"turn":"x"}'), null);
  assert.equal(load('not json'), null);
  assert.equal(load(JSON.stringify({ ...g, cards: 'nope' })), null);
});

// --- several opponents ---------------------------------------------------

test('a game can start with up to three opponents and a chosen life total', () => {
  const g = newGame({ opponents: 3, life: 40 });
  assert.equal(MAX_OPPONENTS, 3);
  assert.deepEqual(players(g), ['me', 'opp1', 'opp2', 'opp3']);
  assert.deepEqual(g.life, { me: 40, opp1: 40, opp2: 40, opp3: 40 });
  assert.equal(g.startingLife, 40);
  assert.equal(newGame({ opponents: 7 }).opponents, 3, 'clamped');
  assert.equal(newGame({ opponents: 0 }).opponents, 1, 'clamped');
});

test('newGame clamps a bad or out-of-range life to a sane total', () => {
  let g = newGame({ life: 40 });
  assert.deepEqual(g.life, { me: 40, opp1: 40 });
  assert.match(last(g).text, /40 life/);
  assert.equal(newGame({ life: 'x' }).startingLife, 20, 'not a number: falls back to 20');
  assert.equal(newGame({ life: 5000 }).startingLife, 999, 'clamped to the top');
  assert.equal(newGame({ life: 0 }).startingLife, 1, 'clamped to the bottom, not the 20 fallback');
});

test('labels: "opponent" alone with one opponent, numbered with more', () => {
  const one = newGame();
  assert.equal(label(one, 'me'), 'I');
  assert.equal(label(one, 'me', 'possessive'), 'my');
  assert.equal(label(one, 'opp1'), 'opponent');
  assert.equal(label(one, 'opp1', 'possessive'), "opponent's");
  const three = newGame({ opponents: 3 });
  assert.equal(label(three, 'opp2'), 'opponent 2');
  assert.equal(label(three, 'opp3', 'possessive'), "opponent 3's");
});

test('the turn goes round the table: me, then each opponent in order, then me', () => {
  let g = newGame({ opponents: 3 });
  const order = [g.active];
  for (let i = 0; i < 4; i++) { g = nextTurn(g); order.push(g.active); }
  assert.deepEqual(order, ['me', 'opp1', 'opp2', 'opp3', 'me']);
  assert.equal(g.turn, 5);
  assert.match(g.log[g.log.length - 2].text, /turn 4: opponent 3's turn/);
});

test('with several opponents, next turn untaps only the one whose turn begins', () => {
  let g = newGame({ opponents: 2 });
  g = addCard(addCard(g, ELVES, 'opp1'), ELVES, 'opp2');
  const a = only(g, 'opp1', 'battlefield').uid;
  const b = only(g, 'opp2', 'battlefield').uid;
  g = toggleTap(toggleTap(g, a), b);
  g = nextTurn(g); // opp1's turn
  assert.equal(only(g, 'opp1', 'battlefield').tapped, false);
  assert.equal(only(g, 'opp2', 'battlefield').tapped, true);
  g = nextTurn(g); // opp2's turn
  assert.equal(only(g, 'opp2', 'battlefield').tapped, false);
});

test('each opponent has their own life and log wording', () => {
  let g = adjustLife(newGame({ opponents: 3, life: 40 }), 'opp2', -7);
  assert.equal(g.life.opp2, 33);
  assert.equal(g.life.opp1, 40);
  assert.match(last(g).text, /opponent 2 loses 7 life \(33\)/);
  assert.equal(adjustLife(g, 'opp4', -1), g, 'not at the table');
  g = addCard(g, ELVES, 'opp3');
  assert.match(last(g).text, /opponent 3 plays Llanowar Elves/);
});

test('setOpponents seats or removes opponents mid-game', () => {
  let g = setOpponents(newGame({ life: 40 }), 3);
  assert.equal(g.opponents, 3);
  assert.equal(g.life.opp3, 40, 'a new opponent starts at the starting life');
  assert.match(last(g).text, /3 opponents/);
  g = addCard(g, ELVES, 'opp3');
  assert.equal(setOpponents(g, 2), g, 'refused: opponent 3 has cards on the table');
  g = remove(g, only(g, 'opp3', 'battlefield').uid);
  g = setOpponents(g, 2);
  assert.equal(g.opponents, 2);
  assert.deepEqual(Object.keys(g.life), ['me', 'opp1', 'opp2']);
  assert.equal(setOpponents(g, 2), g);
  assert.equal(setOpponents(g, 9), g);
});

test('removing the opponent whose turn it is hands the turn back to me', () => {
  let g = nextTurn(nextTurn(newGame({ opponents: 2 }))); // opp2's turn
  g = setOpponents(g, 1);
  assert.equal(g.active, 'me');
});

// --- the command zone ----------------------------------------------------

test('a card can be put in the command zone, and is marked as a commander from then on', () => {
  let g = addCard(newGame(), ELVES, 'me');
  const uid = only(g, 'me', 'hand').uid;
  assert.equal(only(g, 'me', 'hand').commander, undefined);
  g = moveTo(g, uid, 'command');
  const c = only(g, 'me', 'command');
  assert.equal(c.commander, true);
  assert.match(last(g).text, /my Llanowar Elves to command zone/);
  g = moveTo(g, uid, 'battlefield');
  assert.equal(only(g, 'me', 'battlefield').commander, true, 'still the commander on the battlefield');
  g = moveTo(g, uid, 'graveyard');
  g = moveTo(g, uid, 'command');
  assert.equal(only(g, 'me', 'command').zone, 'command');
});

test('a card can be added straight to the command zone', () => {
  const g = addCard(newGame({ opponents: 2 }), DELVER, 'opp2', 'command');
  const c = only(g, 'opp2', 'command');
  assert.equal(c.commander, true);
  assert.match(last(g).text, /opponent 2 puts Delver of Secrets \/\/ Insectile Aberration in command zone/);
});

test('a commander in the command zone is not tappable', () => {
  const g = addCard(newGame(), ELVES, 'me', 'command');
  assert.equal(toggleTap(g, only(g, 'me', 'command').uid), g);
});

test('resetGame starts over with the same seats and starting life', () => {
  let g = newGame({ opponents: 3, life: 40 });
  g = addCard(nextTurn(adjustLife(g, 'opp2', -9)), ELVES, 'opp1');
  const r = resetGame(g);
  assert.equal(r.turn, 1);
  assert.equal(r.active, 'me');
  assert.equal(r.opponents, 3);
  assert.deepEqual(r.life, { me: 40, opp1: 40, opp2: 40, opp3: 40 });
  assert.deepEqual(r.cards, []);
  assert.equal(r.log.length, 1);
  assert.match(last(r).text, /game reset: 3 opponents, 40 life/);
  assert.equal(r.nextUid, 1);
});

// --- counters ------------------------------------------------------------

const onField = () => { const g = addCard(newGame(), ELVES, 'opp1'); return [g, only(g, 'opp1', 'battlefield').uid]; };
const ctrs = (g, uid) => g.cards.find((c) => c.uid === uid).counters;

test('parseCounterKind: N/M with signs made explicit; anything else is a custom word', () => {
  assert.equal(parseCounterKind('+1/+1'), '+1/+1');
  assert.equal(parseCounterKind('1/1'), '+1/+1');
  assert.equal(parseCounterKind('-1/-1'), '-1/-1');
  assert.equal(parseCounterKind(' +2 / +0 '), '+2/+0');
  assert.equal(parseCounterKind('Lore'), 'lore');
  assert.equal(parseCounterKind('time'), 'time');
  assert.equal(parseCounterKind(''), null);
  assert.equal(parseCounterKind('   '), null);
  assert.equal(parseCounterKind('a'.repeat(17)), null, 'too long for a square');
  assert.equal(parseCounterKind(undefined), null);
});

test('addCounter puts one counter of a kind on a card, at a place on it', () => {
  const [g0, uid] = onField();
  const g = addCounter(g0, uid, '+1/+1', { x: 0.2, y: 0.3 });
  const [k] = ctrs(g, uid);
  assert.equal(k.kind, '+1/+1');
  assert.equal(k.count, 1);
  assert.deepEqual([k.x, k.y], [0.2, 0.3]);
  assert.equal(typeof k.id, 'string');
  assert.match(last(g).text, /opponent puts a \+1\/\+1 counter on Llanowar Elves \(1\)/);
});

test('another of the same kind stacks onto the same square; a different kind is its own square', () => {
  const [g0, uid] = onField();
  let g = addCounter(addCounter(g0, uid, '+1/+1'), uid, '1/1');
  assert.equal(ctrs(g, uid).length, 1);
  assert.equal(ctrs(g, uid)[0].count, 2);
  assert.match(last(g).text, /\(2\)/);
  g = addCounter(g, uid, 'lore');
  assert.equal(ctrs(g, uid).length, 2);
  assert.notEqual(ctrs(g, uid)[0].id, ctrs(g, uid)[1].id);
  assert.match(last(g).text, /puts a lore counter on/);
});

test('addCounter ignores a bad kind, an unknown card, and a card in hand keeps none by default', () => {
  const [g, uid] = onField();
  assert.equal(addCounter(g, uid, ''), g);
  assert.equal(addCounter(g, 'nope', '+1/+1'), g);
  assert.equal(only(addCard(newGame(), ELVES, 'me'), 'me', 'hand').counters, undefined);
});

test('adjustCounter adds or removes one; at zero the square goes', () => {
  const [g0, uid] = onField();
  let g = addCounter(g0, uid, 'lore');
  const id = ctrs(g, uid)[0].id;
  g = adjustCounter(g, uid, id, 1);
  assert.equal(ctrs(g, uid)[0].count, 2);
  assert.match(last(g).text, /puts a lore counter on Llanowar Elves \(2\)/);
  g = adjustCounter(g, uid, id, -1);
  assert.match(last(g).text, /removes a lore counter from Llanowar Elves \(1\)/);
  g = adjustCounter(g, uid, id, -1);
  assert.deepEqual(ctrs(g, uid), []);
  assert.match(last(g).text, /\(0\)/);
  assert.equal(adjustCounter(g, uid, id, 1), g, 'gone: nothing to adjust');
  assert.equal(adjustCounter(g, uid, 'x', 0), g);
});

test('moveCounter keeps the square on the card, and is not worth a log line', () => {
  const [g0, uid] = onField();
  let g = addCounter(g0, uid, '+1/+1');
  const id = ctrs(g, uid)[0].id;
  const n = g.log.length;
  g = moveCounter(g, uid, id, 0.7, 0.9);
  assert.deepEqual([ctrs(g, uid)[0].x, ctrs(g, uid)[0].y], [0.7, 0.9]);
  g = moveCounter(g, uid, id, -3, 4);
  assert.deepEqual([ctrs(g, uid)[0].x, ctrs(g, uid)[0].y], [0, 1]);
  assert.equal(g.log.length, n);
  assert.equal(moveCounter(g, uid, 'x', 0.5, 0.5), g);
});

test('counters come off when the card leaves its zone', () => {
  const [g0, uid] = onField();
  let g = addCounter(g0, uid, '+1/+1');
  g = moveTo(g, uid, 'graveyard');
  assert.deepEqual(ctrs(g, uid), []);
  g = moveTo(g, uid, 'battlefield');
  g = addCounter(g, uid, 'time');
  assert.equal(nextTurn(g).cards[0].counters.length, 1, 'but a turn passing leaves them');
});

test('a game with counters survives a save and load', () => {
  const [g0, uid] = onField();
  const g = addCounter(g0, uid, 'lore', { x: 0.1, y: 0.2 });
  assert.deepEqual(load(JSON.stringify(g)), g);
});

// --- lands ---------------------------------------------------------------

test('isLand: anything with Land in its front-face type line', () => {
  assert.equal(isLand(FOREST), true);
  for (const t of ['Basic Land — Forest', 'Land', 'Land Creature — Forest Dryad', 'Artifact Land', 'Legendary Land']) {
    assert.equal(isLand({ typeLine: t }), true, t);
  }
  for (const t of ['Creature — Elf Druid', 'Instant', 'Enchantment — Aura', 'Creature — Landwalker', 'Sorcery // Land']) {
    assert.equal(isLand({ typeLine: t }), false, t);
  }
  assert.equal(isLand(ELVES), false);
  assert.equal(isLand(DELVER), false);
});

test('a land is a permanent, and plays to the battlefield like one', () => {
  assert.equal(isPermanent(FOREST), true);
  let g = addCard(newGame(), FOREST, 'me');
  g = play(g, only(g, 'me', 'hand').uid);
  only(g, 'me', 'battlefield');
});

// --- copies --------------------------------------------------------------

test('copyCard puts another of the same card beside the original: same owner and zone, fresh', () => {
  let g = addCard(addCard(newGame(), ELVES, 'opp1'), FOREST, 'opp1');
  const orig = cardsIn(g, 'opp1', 'battlefield')[0];
  g = toggleTap(addCounter(g, orig.uid, '+1/+1'), orig.uid);
  g = copyCard(g, orig.uid);
  const field = cardsIn(g, 'opp1', 'battlefield');
  assert.deepEqual(field.map((c) => c.name), ['Llanowar Elves', 'Llanowar Elves', 'Forest'], 'the copy sits right after the original');
  const copy = field[1];
  assert.notEqual(copy.uid, orig.uid);
  assert.equal(copy.scryfallId, orig.scryfallId);
  assert.equal(copy.owner, 'opp1');
  assert.equal(copy.zone, 'battlefield');
  assert.equal(copy.tapped, false);
  assert.deepEqual(copy.counters, []);
  assert.equal(field[0].tapped, true, 'the original is as it was');
  assert.equal(field[0].counters.length, 1);
  assert.match(last(g).text, /opponent copies Llanowar Elves/);
  assert.equal(g.nextUid, 5);
});

test('a copy of the commander is not the commander', () => {
  let g = addCard(newGame(), ELVES, 'me', 'command');
  g = copyCard(g, only(g, 'me', 'command').uid);
  const [orig, copy] = cardsIn(g, 'me', 'command');
  assert.equal(orig.commander, true);
  assert.equal(copy.commander, undefined);
});

test('copyCard works in any zone, and ignores an unknown uid', () => {
  let g = addCard(newGame(), BOLT, 'me');
  g = copyCard(g, only(g, 'me', 'hand').uid);
  assert.equal(cardsIn(g, 'me', 'hand').length, 2);
  assert.equal(copyCard(g, 'nope'), g);
});
