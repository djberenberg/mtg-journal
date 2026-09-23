// The rules of the journal: zones, tapping, turns, life, and the log. Pure
// functions over a plain-JSON state, so the page only has to draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCard } from '../scryfall.js';
import {
  newGame, addCard, play, toggleTap, moveTo, remove, nextTurn, adjustLife,
  isPermanent, cardsIn, load,
} from '../game.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const BOLT = parseCard(fixture('bolt'));
const ELVES = parseCard(fixture('elves'));
const DELVER = parseCard(fixture('delver'));

const last = (s) => s.log[s.log.length - 1];
const only = (s, owner, zone) => { const c = cardsIn(s, owner, zone); assert.equal(c.length, 1); return c[0]; };

test('a new game: turn 1, my turn, 20 life each, no cards, one log line', () => {
  const g = newGame();
  assert.equal(g.turn, 1);
  assert.equal(g.active, 'me');
  assert.deepEqual(g.life, { me: 20, opp: 20 });
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

  g = addCard(g, ELVES, 'opp');
  const theirs = only(g, 'opp', 'battlefield');
  assert.equal(theirs.owner, 'opp');
  assert.notEqual(theirs.uid, mine.uid, 'two copies of one card are two instances');
  assert.equal(cardsIn(g, 'opp', 'hand').length, 0);
});

test('an opponent\'s instant goes to their graveyard, not the battlefield', () => {
  const g = addCard(newGame(), BOLT, 'opp');
  assert.equal(cardsIn(g, 'opp', 'battlefield').length, 0);
  only(g, 'opp', 'graveyard');
});

test('a zone can be chosen explicitly', () => {
  const g = addCard(newGame(), ELVES, 'opp', 'hand');
  only(g, 'opp', 'hand');
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
  let g = addCard(newGame(), ELVES, 'opp');
  const uid = only(g, 'opp', 'battlefield').uid;
  assert.equal(play(g, uid), g);
});

test('toggleTap taps and untaps a permanent on the battlefield, and logs each', () => {
  let g = addCard(newGame(), ELVES, 'opp');
  const uid = only(g, 'opp', 'battlefield').uid;
  g = toggleTap(g, uid);
  assert.equal(only(g, 'opp', 'battlefield').tapped, true);
  assert.match(last(g).text, /taps Llanowar Elves/);
  g = toggleTap(g, uid);
  assert.equal(only(g, 'opp', 'battlefield').tapped, false);
  assert.match(last(g).text, /untaps Llanowar Elves/);
});

test('toggleTap ignores cards that are not on the battlefield, and unknown uids', () => {
  const g = addCard(newGame(), ELVES, 'me');
  const uid = only(g, 'me', 'hand').uid;
  assert.equal(toggleTap(g, uid), g);
  assert.equal(toggleTap(g, 'nope'), g);
});

test('moveTo moves a card between any zones; arriving on the battlefield it is untapped', () => {
  let g = addCard(newGame(), ELVES, 'opp');
  const uid = only(g, 'opp', 'battlefield').uid;
  g = toggleTap(g, uid);
  g = moveTo(g, uid, 'exile');
  only(g, 'opp', 'exile');
  assert.match(last(g).text, /Llanowar Elves to exile/);
  g = moveTo(g, uid, 'battlefield');
  assert.equal(only(g, 'opp', 'battlefield').tapped, false);
  g = moveTo(g, uid, 'hand');
  only(g, 'opp', 'hand');
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
  let g = addCard(addCard(newGame(), ELVES, 'me', 'battlefield'), ELVES, 'opp');
  const mine = only(g, 'me', 'battlefield').uid;
  const theirs = only(g, 'opp', 'battlefield').uid;
  g = toggleTap(toggleTap(g, mine), theirs);
  g = nextTurn(g);
  assert.equal(g.turn, 2);
  assert.equal(g.active, 'opp');
  assert.equal(only(g, 'opp', 'battlefield').tapped, false, 'the opponent untaps at the start of their turn');
  assert.equal(only(g, 'me', 'battlefield').tapped, true, 'mine stay tapped');
  assert.equal(last(g).turn, 2);
  g = nextTurn(g);
  assert.equal(g.turn, 3);
  assert.equal(g.active, 'me');
  assert.equal(only(g, 'me', 'battlefield').tapped, false);
});

test('adjustLife changes a total and logs the result', () => {
  let g = adjustLife(newGame(), 'opp', -3);
  assert.equal(g.life.opp, 17);
  assert.equal(g.life.me, 20);
  assert.match(last(g).text, /opponent.*17/);
  g = adjustLife(g, 'me', 2);
  assert.equal(g.life.me, 22);
  assert.equal(adjustLife(g, 'me', 0), g);
});

test('every log line carries the turn it happened on', () => {
  let g = nextTurn(addCard(newGame(), ELVES, 'me'));
  g = play(g, only(g, 'me', 'hand').uid);
  assert.deepEqual(g.log.map((l) => l.turn), [1, 1, 2, 2]);
});

test('no function mutates the state it was given', () => {
  const g0 = addCard(newGame(), ELVES, 'opp');
  const frozen = JSON.stringify(g0);
  const uid = only(g0, 'opp', 'battlefield').uid;
  toggleTap(g0, uid); moveTo(g0, uid, 'exile'); remove(g0, uid); nextTurn(g0); adjustLife(g0, 'me', -1); addCard(g0, BOLT, 'me');
  assert.equal(JSON.stringify(g0), frozen);
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
