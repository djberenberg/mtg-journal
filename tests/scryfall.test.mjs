// The Scryfall client: turning API responses into the card shape the game
// uses, and the two requests it makes. Fixtures are real responses, saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCard, autocomplete, lookup, NotFound } from '../scryfall.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

// A fetch that answers from fixtures and records what it was asked.
const fakeFetch = (routes) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, body] of routes) {
      if (String(url).includes(match)) {
        return { ok: body.object !== 'error', status: body.status || 200, json: async () => body };
      }
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetch, calls };
};

test('parseCard keeps what the table needs from a normal card', () => {
  const c = parseCard(fixture('bolt'));
  assert.equal(c.name, 'Lightning Bolt');
  assert.equal(c.manaCost, '{R}');
  assert.equal(c.cmc, 1);
  assert.equal(c.typeLine, 'Instant');
  assert.match(c.oracleText, /3 damage/);
  assert.equal(c.power, null);
  assert.equal(c.toughness, null);
  assert.deepEqual(c.colors, ['R']);
  assert.match(c.image, /^https:\/\/cards\.scryfall\.io\/normal\//);
  assert.match(c.imageSmall, /^https:\/\/cards\.scryfall\.io\/small\//);
  assert.equal(c.imageBack, null);
  assert.match(c.uri, /^https:\/\/scryfall\.com\//);
  assert.equal(typeof c.scryfallId, 'string');
});

test('parseCard reads power and toughness as strings, as printed', () => {
  const c = parseCard(fixture('elves'));
  assert.equal(c.power, '1');
  assert.equal(c.toughness, '1');
  assert.equal(c.typeLine, 'Creature — Elf Druid');
});

test('parseCard takes a double-faced card\'s images and text from its faces', () => {
  const c = parseCard(fixture('delver'));
  assert.equal(c.name, 'Delver of Secrets // Insectile Aberration');
  assert.match(c.image, /^https:\/\/cards\.scryfall\.io\/normal\/front\//);
  assert.match(c.imageBack, /^https:\/\/cards\.scryfall\.io\/normal\/back\//);
  assert.equal(c.manaCost, '{U}');
  assert.match(c.oracleText, /Insectile Aberration/); // both faces' text, joined
  assert.equal(c.power, '1'); // the front face
});

test('parseCard output survives a JSON round trip unchanged', () => {
  const c = parseCard(fixture('delver'));
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
});

test('autocomplete returns the names, asks for JSON, and encodes the query', async () => {
  const { fetch, calls } = fakeFetch([['/cards/autocomplete', fixture('autocomplete')]]);
  const names = await autocomplete('lightn', { fetch });
  assert.equal(names.length, 20);
  assert.ok(names.includes('Lightning Bolt'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.scryfall\.com\/cards\/autocomplete\?q=lightn$/);
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  await autocomplete('a b/c', { fetch });
  assert.match(calls[1].url, /q=a%20b%2Fc$/);
});

test('autocomplete of a blank or one-letter query makes no request', async () => {
  const { fetch, calls } = fakeFetch([]);
  assert.deepEqual(await autocomplete('', { fetch }), []);
  assert.deepEqual(await autocomplete(' l ', { fetch }), []);
  assert.equal(calls.length, 0);
});

test('lookup fetches by fuzzy name and parses the card', async () => {
  const { fetch, calls } = fakeFetch([['/cards/named', fixture('bolt')]]);
  const c = await lookup('lightning bolt', { fetch });
  assert.equal(c.name, 'Lightning Bolt');
  assert.match(calls[0].url, /\/cards\/named\?fuzzy=lightning%20bolt$/);
});

test('lookup of an unknown name throws NotFound with Scryfall\'s own message', async () => {
  const { fetch } = fakeFetch([['/cards/named', fixture('notfound')]]);
  await assert.rejects(lookup('xyzzyplugh', { fetch }), (e) => e instanceof NotFound && /No cards found/.test(e.message));
});

test('lookup passes an abort signal through', async () => {
  const { fetch, calls } = fakeFetch([['/cards/named', fixture('bolt')]]);
  const ac = new AbortController();
  await lookup('bolt', { fetch, signal: ac.signal });
  assert.equal(calls[0].init.signal, ac.signal);
});
