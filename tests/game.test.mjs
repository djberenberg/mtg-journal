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
  commanders, adjustCommanderDamage, reorderCard, isEquipment, isCreature, equip, unequip,
} from '../game.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const BOLT = parseCard(fixture('bolt'));
const ELVES = parseCard(fixture('elves'));
const DELVER = parseCard(fixture('delver'));
const FOREST = parseCard(fixture('forest'));
const BONES = parseCard(fixture('bonesplitter'));

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

// --- the order on the table ----------------------------------------------

// Three of my creatures and two of my lands on the battlefield, and one of
// the opponent's creatures, so every row a reorder must leave alone is
// there to be left alone. The uids are '1' to '6' in that order.
const board = () => {
  let g = newGame();
  for (const c of [ELVES, DELVER, ELVES, FOREST, FOREST]) g = addCard(g, c, 'me', 'battlefield');
  return addCard(g, ELVES, 'opp1', 'battlefield');
};
const run = (g, owner, lands) => cardsIn(g, owner, 'battlefield').filter((c) => isLand(c) === lands).map((c) => c.uid).join('');

test('reorderCard moves a card in front of a named neighbour in its own row', () => {
  const g = reorderCard(board(), '3', '1');
  assert.equal(run(g, 'me', false), '312');
  assert.equal(run(g, 'me', true), '45', 'my lands are where they were');
  assert.equal(run(g, 'opp1', false), '6');
  assert.deepEqual(g.cards.map((c) => c.uid), ['3', '1', '2', '4', '5', '6']);
});

test('with no card to go in front of, it goes last in its own row and no further', () => {
  const g = reorderCard(board(), '1', null);
  assert.equal(run(g, 'me', false), '231');
  assert.equal(run(g, 'me', true), '45');
  assert.equal(run(g, 'opp1', false), '6');
  // Not the end of the whole array: that would look the same and churn the save.
  assert.deepEqual(g.cards.map((c) => c.uid), ['2', '3', '1', '4', '5', '6']);
  assert.equal(run(reorderCard(board(), '4', null), 'me', true), '54', 'the lands row reorders on its own');
});

test('a reorder that would cross a row, a player, a zone, or change nothing is no reorder at all', () => {
  const g = board();
  assert.equal(reorderCard(g, 'nope', '1'), g, 'an unknown card');
  assert.equal(reorderCard(g, '1', 'nope'), g, 'an unknown neighbour');
  assert.equal(reorderCard(g, '1', '1'), g, 'in front of itself');
  assert.equal(reorderCard(g, '4', '1'), g, 'a land into the spells row');
  assert.equal(reorderCard(g, '1', '4'), g, 'a spell into the lands row');
  assert.equal(reorderCard(g, '1', '6'), g, 'into another player\'s row');
  assert.equal(reorderCard(g, '1', '2'), g, 'already in front of it');
  assert.equal(reorderCard(g, '3', null), g, 'already last in its row');
  assert.equal(reorderCard(g, '6', null), g, 'the only card in its row');
  const h = addCard(addCard(g, BOLT, 'me'), BOLT, 'me');
  assert.equal(reorderCard(h, '7', '8'), h, 'a hand is not the battlefield');
  assert.equal(reorderCard(h, '7', null), h);
  assert.equal(reorderCard(h, '7', '1'), h, 'nor is one in hand a neighbour of one on the table');
});

test('a move past cards it is never drawn beside is no move at all', () => {
  // Two of my creatures with the opponent's card sitting between them in
  // the array: the run they are drawn in is the same after as before, so
  // there is nothing to save and nothing to undo.
  let g = addCard(newGame(), ELVES, 'me', 'battlefield');
  g = addCard(g, ELVES, 'opp1', 'battlefield');
  g = addCard(g, DELVER, 'me', 'battlefield');
  assert.equal(reorderCard(g, '1', '3'), g, 'already in front of it, whatever lies between');
  assert.equal(reorderCard(g, '3', null), g, 'already last in its run');
  assert.notEqual(reorderCard(g, '3', '1'), g, 'and a real move is still a move');
});

test('a reorder is presentation, like a counter square: no log line', () => {
  const g = board();
  const h = reorderCard(g, '3', '1');
  assert.notEqual(h, g);
  assert.equal(h.log.length, g.log.length);
  assert.deepEqual(g.cards.map((c) => c.uid), ['1', '2', '3', '4', '5', '6'], 'and the state it came from is untouched');
  assert.deepEqual(load(JSON.stringify(h)), h, 'a reordered game saves and loads');
});

// --- commander damage ----------------------------------------------------

// My Llanowar Elves in the command zone, and the uid it is tracked by.
const withCommander = (opponents = 1) => {
  const g = addCard(newGame({ opponents }), ELVES, 'me', 'command');
  return [g, only(g, 'me', 'command').uid];
};

test('commanders: only the cards that have been in a command zone', () => {
  let g = addCard(newGame(), BOLT, 'me');
  assert.deepEqual(commanders(g), []);
  g = addCard(g, ELVES, 'me', 'command');
  g = addCard(g, FOREST, 'opp1', 'command');
  assert.deepEqual(commanders(g).map((c) => c.name), ['Llanowar Elves', 'Forest']);
  g = moveTo(g, only(g, 'me', 'command').uid, 'battlefield');
  assert.equal(commanders(g).length, 2, 'cast, it is still the commander');
});

test('commander damage ticks up and takes the life with it', () => {
  const [g0, uid] = withCommander();
  let g = adjustCommanderDamage(g0, 'opp1', uid, 4);
  assert.deepEqual(g.cmdDamage.opp1, { [uid]: 4 });
  assert.equal(g.life.opp1, 16);
  assert.equal(last(g).text, "opponent's 4 from Llanowar Elves (4), 16 life");

  g = adjustCommanderDamage(g, 'opp1', uid, 3);
  assert.equal(g.cmdDamage.opp1[uid], 7);
  assert.equal(g.life.opp1, 13);
  assert.equal(last(g).text, "opponent's 3 from Llanowar Elves (7), 13 life");
  assert.equal(g.life.me, 20, 'nobody else is touched');
});

test('a correction gives back only what was applied, and zero is no entry at all', () => {
  const [g0, uid] = withCommander();
  let g = adjustCommanderDamage(g0, 'opp1', uid, 7);
  g = adjustCommanderDamage(g, 'opp1', uid, -1);
  assert.equal(g.cmdDamage.opp1[uid], 6);
  assert.equal(g.life.opp1, 14);
  assert.equal(last(g).text, "opponent's \u22121 from Llanowar Elves (6), 14 life");

  g = adjustCommanderDamage(g, 'opp1', uid, -10);
  assert.deepEqual(g.cmdDamage.opp1, {}, 'a tally of zero is deleted, not written');
  assert.equal(g.life.opp1, 20, 'six back, not ten');
  assert.equal(last(g).text, "opponent's \u22126 from Llanowar Elves (0), 20 life");
  assert.equal(adjustCommanderDamage(g, 'opp1', uid, -1), g, 'nothing left to take back');
});

test('twenty-one is lethal, and said once: on the crossing', () => {
  const [g0, uid] = withCommander();
  let g = adjustCommanderDamage(g0, 'opp1', uid, 20);
  assert.equal(g.log.filter((l) => /dead to/.test(l.text)).length, 0);
  g = adjustCommanderDamage(g, 'opp1', uid, 1);
  assert.equal(last(g).text, 'opponent is dead to commander damage from Llanowar Elves (21)');
  assert.equal(g.log.at(-2).text, "opponent's 1 from Llanowar Elves (21), -1 life");
  g = adjustCommanderDamage(g, 'opp1', uid, 1);
  assert.equal(g.log.filter((l) => /dead to/.test(l.text)).length, 1, '21 to 22 is not news');
});

test('the lethal line is in the first person when it is me', () => {
  let g = addCard(newGame(), ELVES, 'opp1', 'command');
  const uid = only(g, 'opp1', 'command').uid;
  g = adjustCommanderDamage(g, 'me', uid, 21);
  assert.equal(g.log.at(-2).text, 'my 21 from Llanowar Elves (21), -1 life');
  assert.equal(last(g).text, 'I am dead to commander damage from Llanowar Elves (21)');
});

test('with several opponents the line names the one who took it', () => {
  const [g0, uid] = withCommander(2);
  const g = adjustCommanderDamage(g0, 'opp2', uid, 4);
  assert.equal(last(g).text, "opponent 2's 4 from Llanowar Elves (4), 16 life");
  assert.deepEqual(Object.keys(g.cmdDamage), ['opp2']);
});

test('partners keep a tally each: neither counts toward the other\'s twenty-one', () => {
  let g = addCard(addCard(newGame(), ELVES, 'me', 'command'), FOREST, 'me', 'command');
  const [one, two] = cardsIn(g, 'me', 'command').map((c) => c.uid);
  g = adjustCommanderDamage(g, 'opp1', one, 20);
  g = adjustCommanderDamage(g, 'opp1', two, 20);
  assert.deepEqual(g.cmdDamage.opp1, { [one]: 20, [two]: 20 });
  assert.equal(g.life.opp1, -20, 'forty life gone between them');
  assert.equal(g.log.filter((l) => /dead to/.test(l.text)).length, 0, 'forty is not twenty-one from one of them');
  g = adjustCommanderDamage(g, 'opp1', two, 1);
  assert.equal(g.cmdDamage.opp1[one], 20, 'the other tally is left alone');
  assert.equal(last(g).text, 'opponent is dead to commander damage from Forest (21)');
});

test('a commander deals no commander damage to its own controller, and nothing else does any', () => {
  const [g, uid] = withCommander();
  const plain = addCard(g, BOLT, 'me');
  assert.equal(adjustCommanderDamage(g, 'me', uid, 3), g, 'not to the player it belongs to');
  assert.equal(adjustCommanderDamage(g, 'opp2', uid, 3), g, 'nobody is in that seat');
  assert.equal(adjustCommanderDamage(g, 'opp1', 'nope', 3), g, 'no such card');
  assert.equal(adjustCommanderDamage(plain, 'opp1', only(plain, 'me', 'hand').uid, 3), plain, 'not a commander');
  for (const delta of [0, NaN, Infinity, 'x', null, undefined, 0.4]) {
    assert.equal(adjustCommanderDamage(g, 'opp1', uid, delta), g, String(delta));
  }
});

test('removing a commander clears its tallies everywhere', () => {
  const [g0, uid] = withCommander(2);
  let g = adjustCommanderDamage(adjustCommanderDamage(g0, 'opp1', uid, 4), 'opp2', uid, 6);
  g = remove(g, uid);
  assert.deepEqual(g.cmdDamage, { opp1: {}, opp2: {} });
  assert.equal(g.life.opp1, 16, 'the life it took stands: it was taken');
});

test('unseating an opponent takes their tallies with them', () => {
  const [g0, uid] = withCommander(2);
  let g = adjustCommanderDamage(g0, 'opp2', uid, 4);
  g = setOpponents(g, 1);
  assert.deepEqual(g.cmdDamage, {});
});

test('a new game and a reset start at no commander damage', () => {
  const [g0, uid] = withCommander();
  const g = adjustCommanderDamage(g0, 'opp1', uid, 4);
  assert.deepEqual(newGame().cmdDamage, {});
  assert.deepEqual(resetGame(g).cmdDamage, {});
});

test('a save from before commander damage opens without it, not rejected', () => {
  const [g0, uid] = withCommander();
  const g = adjustCommanderDamage(g0, 'opp1', uid, 4);
  assert.deepEqual(load(JSON.stringify(g)), g, 'and one with it comes back as it was');
  const { cmdDamage, ...old } = g;
  assert.deepEqual(load(JSON.stringify(old)), { ...old, cmdDamage: {} });
  for (const junk of [[], 'x', 3, null]) {
    assert.deepEqual(load(JSON.stringify({ ...old, cmdDamage: junk })), { ...old, cmdDamage: {} }, JSON.stringify(junk));
  }
});

// --- equipment -----------------------------------------------------------

// My Bonesplitter and two of my creatures, all three on my battlefield:
// the uids are '1' for the equipment, '2' and '3' for the creatures.
const armed = () => {
  let g = addCard(newGame(), BONES, 'me', 'battlefield');
  g = addCard(g, ELVES, 'me', 'battlefield');
  return addCard(g, DELVER, 'me', 'battlefield');
};
const card = (g, uid) => g.cards.find((c) => c.uid === uid);

test('isEquipment and isCreature: the front face decides, as it does for a land', () => {
  assert.equal(isEquipment(BONES), true);
  assert.equal(isCreature(BONES), false);
  assert.equal(isCreature(ELVES), true);
  assert.equal(isEquipment(ELVES), false);
  assert.equal(isCreature(DELVER), true, 'both faces are creatures');
  assert.equal(isCreature(FOREST), false);
  assert.equal(isCreature({ typeLine: 'Enchantment — Aura // Creature — Spirit' }), false, 'the back face is not the card');
  assert.equal(isEquipment({ typeLine: 'Legendary Artifact — Equipment' }), true);
  assert.equal(isEquipment({ typeLine: 'Instant // Artifact — Equipment' }), false);
  assert.equal(isCreature({}), false);
});

test('equip attaches an equipment to a creature and says so', () => {
  const g = equip(armed(), '1', '2');
  assert.equal(card(g, '1').attachedTo, '2');
  assert.equal(last(g).text, 'I equip Llanowar Elves with Bonesplitter');
  assert.equal(card(g, '2').attachedTo, undefined, 'the creature carries nothing: the attachment is the equipment\'s');
});

test('equipping a second creature moves it, with a line of its own', () => {
  const g0 = equip(armed(), '1', '2');
  const g = equip(g0, '1', '3');
  assert.equal(card(g, '1').attachedTo, '3');
  assert.equal(g.log.length, g0.log.length + 1);
  assert.match(last(g).text, /I equip Delver of Secrets .* with Bonesplitter/);
});

test('the opponent equips their own, in their own words', () => {
  let g = addCard(newGame(), BONES, 'opp1', 'battlefield');
  g = addCard(g, ELVES, 'opp1', 'battlefield');
  g = equip(g, '1', '2');
  assert.equal(card(g, '1').attachedTo, '2');
  assert.equal(last(g).text, 'opponent equips Llanowar Elves with Bonesplitter');
});

test('equip refuses anything that is not an equipment on a creature of its owner\'s, on the battlefield', () => {
  const g = armed();
  assert.equal(equip(g, '2', '3'), g, 'a creature is not an equipment');
  assert.equal(equip(g, '1', '1'), g, 'nothing is equipped with itself');
  assert.equal(equip(g, '1', 'nope'), g, 'an unknown host');
  assert.equal(equip(g, 'nope', '2'), g, 'an unknown equipment');
  const land = addCard(g, FOREST, 'me', 'battlefield');
  assert.equal(equip(land, '1', '4'), land, 'a land is not a creature');
  const inHand = moveTo(g, '1', 'hand');
  assert.equal(equip(inHand, '1', '2'), inHand, 'the equipment is not on the battlefield');
  const away = moveTo(g, '2', 'graveyard');
  assert.equal(equip(away, '1', '2'), away, 'the creature is not on the battlefield');
  const theirs = addCard(g, ELVES, 'opp1', 'battlefield');
  assert.equal(equip(theirs, '1', '4'), theirs, 'a creature across the table');
  const on = equip(g, '1', '2');
  assert.equal(equip(on, '1', '2'), on, 'the creature it is already on');
});

test('unequip takes it off and says so; on a card wearing nothing it is nothing', () => {
  const g0 = equip(armed(), '1', '2');
  const g = unequip(g0, '1');
  assert.equal('attachedTo' in card(g, '1'), false, 'the key goes, so a save carries no attachment to nowhere');
  assert.equal(last(g).text, 'my Bonesplitter comes off Llanowar Elves');
  assert.equal(unequip(g, '1'), g, 'nothing to take off');
  assert.equal(unequip(g, '2'), g, 'a creature is wearing nothing either');
  assert.equal(unequip(g, 'nope'), g);
});

test('the creature leaving the battlefield, or being removed, takes the equipment off', () => {
  const g0 = equip(armed(), '1', '2');
  for (const g of [moveTo(g0, '2', 'graveyard'), remove(g0, '2'), moveTo(g0, '2', 'command')]) {
    assert.equal('attachedTo' in card(g, '1'), false);
    assert.equal(g.log.length, g0.log.length + 1, 'the move says it; the detaching adds no line');
  }
  assert.equal(card(play(addCard(g0, BONES, 'me'), '4'), '1').attachedTo, '2', 'and another card played leaves it on');
});

test('the equipment leaving the battlefield comes off by itself', () => {
  const g0 = equip(armed(), '1', '2');
  for (const g of [moveTo(g0, '1', 'graveyard'), moveTo(g0, '1', 'hand'), remove(g0, '2')]) {
    assert.equal(card(g, '1')?.attachedTo, undefined);
  }
  // Back in hand and played again, it comes out onto the table on nothing.
  const again = play(moveTo(g0, '1', 'hand'), '1');
  assert.equal('attachedTo' in card(again, '1'), false);
});

test('a copy of an attached equipment arrives on nothing, as it arrives untapped', () => {
  const g = copyCard(equip(armed(), '1', '2'), '1');
  assert.equal(card(g, '1').attachedTo, '2', 'the original is as it was');
  assert.equal('attachedTo' in card(g, '4'), false);
});

test('an attached equipment has no place of its own in the row, so it does not reorder', () => {
  const g = equip(armed(), '1', '2');
  assert.equal(reorderCard(g, '1', '3'), g, 'it goes where its host goes');
  assert.equal(reorderCard(g, '1', null), g);
  assert.notEqual(reorderCard(g, '3', '2'), g, 'the creatures either side of it still move');
});

test('a game with an equipment on a creature saves and loads', () => {
  const g = equip(armed(), '1', '2');
  assert.deepEqual(load(JSON.stringify(g)), g);
});

test('load drops an attachment that points at no creature on the battlefield, and keeps the game', () => {
  const g = equip(armed(), '1', '2');
  const strand = (cards) => load(JSON.stringify({ ...g, cards }));
  const gone = strand(g.cards.filter((c) => c.uid !== '2'));
  assert.equal('attachedTo' in gone.cards[0], false, 'a host that is not on the table at all');
  assert.equal(gone.cards.length, 2, 'and the rest of the game opens as it was');
  const buried = strand(g.cards.map((c) => (c.uid === '2' ? { ...c, zone: 'graveyard' } : c)));
  assert.equal('attachedTo' in buried.cards[0], false, 'a host that is off the battlefield');
  const notACreature = strand(g.cards.map((c) => (c.uid === '2' ? { ...c, typeLine: 'Enchantment' } : c)));
  assert.equal('attachedTo' in notACreature.cards[0], false, 'a host that is not a creature');
  const itself = strand(g.cards.map((c) => (c.uid === '1' ? { ...c, attachedTo: '1' } : c)));
  assert.equal(itself.cards[0].attachedTo, undefined, 'and one pointing at itself is no creature either');
});

test('load drops an attachment held by anything but an equipment on the battlefield', () => {
  const g = equip(armed(), '1', '2');
  const held = (cards) => load(JSON.stringify({ ...g, cards })).cards[0];
  assert.equal('attachedTo' in held(g.cards.map((c) => (c.uid === '1' ? { ...c, zone: 'hand' } : c))), false, 'a card in hand is on nothing');
  assert.equal('attachedTo' in held(g.cards.map((c) => (c.uid === '1' ? { ...c, typeLine: 'Artifact' } : c))), false, 'and so is a card that is no equipment');
  // A creature wearing an attachment is the same mistake the other way up:
  // it would draw tucked in behind another card and have no way off.
  const onACreature = load(JSON.stringify({ ...g, cards: g.cards.map((c) => (c.uid === '3' ? { ...c, attachedTo: '2' } : c)) }));
  assert.equal('attachedTo' in onACreature.cards[2], false);
  assert.equal(onACreature.cards[0].attachedTo, '2', 'the real attachment is left alone');
});
