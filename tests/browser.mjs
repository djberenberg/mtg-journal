// Drives the page in headless Chrome with Scryfall replaced by the saved
// fixtures, so it runs offline and the same way every time. Not a node:test
// file: run it directly with `node tests/browser.mjs`. Needs Google Chrome.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCard } from '../scryfall.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, '.scratch');
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8766;
const BASE = `http://127.0.0.1:${PORT}`;

// Fixtures answer the two requests the page makes. autocomplete answers the
// one saved query for "lightn" and nothing for anything else.
const fixtures = Object.fromEntries(readdirSync(join(root, 'tests/fixtures')).map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join(root, 'tests/fixtures', f)))]));
const parseFixture = (n) => parseCard(fixtures[n]);
const byName = { 'lightning bolt': 'bolt', bolt: 'bolt', 'llanowar elves': 'elves', elves: 'elves', 'delver of secrets': 'delver', delver: 'delver', forest: 'forest', bonesplitter: 'bonesplitter' };
const stub = `
  window.__requests = [];
  window.fetch = async (url, init) => {
    window.__requests.push(String(url));
    const u = new URL(url);
    const body = (() => {
      if (u.pathname === '/cards/autocomplete') return u.searchParams.get('q').toLowerCase().startsWith('lightn') ? ${JSON.stringify(fixtures.autocomplete)} : { object: 'catalog', data: [] };
      if (u.pathname === '/cards/named') { const k = ${JSON.stringify(byName)}[u.searchParams.get('fuzzy').toLowerCase()]; return k ? ${JSON.stringify({ bolt: fixtures.bolt, elves: fixtures.elves, delver: fixtures.delver, forest: fixtures.forest, bonesplitter: fixtures.bonesplitter })}[k] : ${JSON.stringify(fixtures.notfound)}; }
      return { object: 'error', status: 500, details: 'unexpected ' + url };
    })();
    await new Promise((r) => setTimeout(r, 30));
    return { ok: body.object !== 'error', status: body.status || 200, json: async () => body };
  };`;

const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', root], { stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${join(out, 'chrome')}`, '--no-first-run', '--window-size=1200,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { srv.kill(); chrome.kill(); process.exit(code); };

try {
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); break; } catch { await sleep(250); } }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pending.get(d.id)?.(d); else events.push(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
  const key = async (k, code, vk, mods = 0) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text: type === 'keyDown' ? (k === 'Enter' ? '\r' : k.length === 1 ? k : undefined) : undefined }); };
  const type = async (s) => { for (const ch of s) await send('Input.insertText', { text: ch }); };
  // The search stages the card it finds; where it goes is chosen after. So
  // every card that reaches the table here takes two presses, not one.
  const stage = async (name) => { await evalJs(`document.getElementById('q').focus()`); await type(name); await key('Enter', 'Enter', 13); await sleep(300); };
  const toHand = async (name) => { await stage(name); await key('Enter', 'Enter', 13); await sleep(150); };
  const oppPlays = async (name) => { await stage(name); await key('Enter', 'Enter', 13, 8); await sleep(150); };
  const stagedUi = () => evalJs(`({hidden: document.getElementById('staged').hidden, name: document.getElementById('staged-name').textContent, img: document.getElementById('staged-img').getAttribute('src'), label: document.getElementById('staged').getAttribute('aria-label')})`);
  const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';e.click();return 'ok'})()`);
  const shot = async (name) => writeFileSync(join(out, `${name}.png`), Buffer.from((await send('Page.captureScreenshot')).result.data, 'base64'));
  const results = []; const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };
  const state = () => evalJs(`JSON.parse(localStorage.getItem('mtg-journal.game')) ?? { cards: [] }`);
  const zone = (owner, z) => evalJs(`[...document.querySelectorAll('.zone[data-owner="${owner}"][data-zone="${z}"] .card')].map(c=>({name:c.querySelector('img').alt, tapped:c.classList.contains('tapped'), uid:c.dataset.uid, tier:c.closest('.tier')?.dataset.tier}))`);
  const ui = () => evalJs(`({turn: document.getElementById('turn').textContent, me: document.getElementById('life-me').textContent, opp: document.getElementById('life-opp').textContent, status: document.getElementById('status').textContent, error: document.getElementById('status').classList.contains('error'), log: [...document.querySelectorAll('#log li')].map(l=>l.textContent), undo: document.getElementById('undo').disabled, suggestions: [...document.querySelectorAll('#suggest li')].map(l=>l.textContent), suggestHidden: document.getElementById('suggest').hidden, q: document.getElementById('q').value})`);

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true }); // the profile outlives the run; a cached page would be the last one's
  await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(800);
  await evalJs(`localStorage.clear()`); await send('Page.navigate', { url: `${BASE}/` }); await sleep(800);
  const el = (sel, prop) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?${prop}:null})()`);
  const width = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().width`);
  // The menus: opened with a real press, so the page can tell a mouse from a
  // key, and chosen from by the item's label.
  const clickAt = async (sel) => { const p = JSON.parse(await evalJs(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`)); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y, 0); await sleep(80); };
  const menuUi = (opener = 'menu-game') => evalJs(`({hidden: document.getElementById('menu').hidden, expanded: document.getElementById(${JSON.stringify(opener)}).getAttribute('aria-expanded'), items: [...document.querySelectorAll('#menu [role="menuitem"]')].map(b=>({label:b.textContent, title:b.title})), focus: document.activeElement.id, roles: [...document.getElementById('menu').children].map(c=>c.getAttribute('role'))})`);
  const pickItem = async (label) => { const r = await evalJs(`(()=>{const b=[...document.querySelectorAll('#menu [role="menuitem"]')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)return 'missing';b.click();return 'ok'})()`); await sleep(120); return r; };
  const fromGameMenu = async (label) => { await clickAt('#menu-game'); return pickItem(label); };
  // A card's own menu: a real right-click on the card — scrolled into view
  // first, since these are viewport coordinates — then the item by its label.
  const rightClick = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: 2, clickCount: 1 }); await sleep(80); };
  const rightClickAt = async (sel) => {
    // Scrolled and settled before the rect is read: the scroll event that
    // follows would otherwise arrive after the click and close the menu.
    if (!(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.scrollIntoView({block:'center'});return true})()`))) return null;
    await sleep(150);
    const p = JSON.parse(await evalJs(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`));
    await rightClick(p.x, p.y);
    return p;
  };
  const menuPick = async (sel, label) => ((await rightClickAt(sel)) ? pickItem(label) : 'missing');
  // Hover is the browser's own, so the pointer has to really be moved onto
  // the card; and away again, to somewhere no card is.
  const hover = async (sel) => {
    if (!(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.scrollIntoView({block:'center'});return true})()`))) return null;
    await sleep(150);
    const p = JSON.parse(await evalJs(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`));
    await mouse('mouseMoved', p.x, p.y, 0);
    await sleep(250); // the card takes 0.12s to grow
    return p;
  };
  const unhover = async () => { await mouse('mouseMoved', 4, 4, 0); await sleep(250); };
  const centre = async (sel) => JSON.parse(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'null';const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),left:Math.round(r.left),right:Math.round(r.right)})})()`));
  // A card is carried with the pointer really pressed and moved, in steps,
  // so the row reorders under it on the way. It is dropped just inside the
  // near edge of another card ('before'), just inside its far edge ('after'),
  // or on the middle of whatever is named ('onto'). What comes back is the
  // card as it was mid-drag, read after the last move and before the drop.
  const dragOnto = async (sel, ontoSel, side) => {
    await evalJs(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
    await sleep(200);
    const from = await centre(sel);
    const to = await centre(ontoSel);
    const x = side === 'before' ? to.left + 4 : side === 'after' ? to.right - 4 : to.x;
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', Math.round(from.x + ((x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8));
    const during = JSON.parse(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});const s=getComputedStyle(e);return JSON.stringify({dragging:e.classList.contains('dragging'),opacity:Math.round(parseFloat(s.opacity)*100)/100,zoom:Math.round(new DOMMatrix(s.transform).a*1000)/1000,cursor:s.cursor,imgCursor:getComputedStyle(e.querySelector('img')).cursor,moved:e.style.transform!=='',at:[...e.parentElement.children].indexOf(e)})})()`));
    await mouse('mouseReleased', x, to.y, 0);
    await sleep(150);
    return during;
  };
  // A press that travels less than the threshold: still a click, and the
  // card it is on should still tap.
  const nudge = async (sel, by) => {
    const p = await centre(sel);
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseMoved', p.x + by, p.y);
    await mouse('mouseReleased', p.x + by, p.y, 0);
    await sleep(100);
  };
  const peekUi = (sel = '.card') => evalJs(`(()=>{const p=document.getElementById('peek');const r=p.getBoundingClientRect();const c=document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect()??{left:0,right:0};return {hidden:p.hidden,text:p.textContent,rows:[...p.children].map(e=>e.className),aria:p.getAttribute('aria-hidden'),fixed:getComputedStyle(p).position,gap:Math.round((r.left-c.right)*10)/10,width:Math.round(r.width),inView:r.left>=8&&r.top>=8&&r.right<=innerWidth-8&&r.bottom<=innerHeight-8}})()`);
  const ghosts = () => evalJs(`[...document.querySelectorAll('.ghost')].map(g=>({effect:g.dataset.effect, halves:g.querySelectorAll('.ghost-half').length, imgs:g.querySelectorAll('img').length, fixed:getComputedStyle(g).position, events:getComputedStyle(g).pointerEvents, hidden:g.getAttribute('aria-hidden'), running:g.getAnimations({subtree:true}).map(a=>a.animationName).sort()}))`);
  const zoomOf = (sel) => evalJs(`Math.round(new DOMMatrix(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).transform).a * 1000) / 1000`);
  const fieldBoxes = (owner) => evalJs(`(()=>{const z=document.querySelector('.zone[data-owner="${owner}"][data-zone="battlefield"]');return {zone:z.getBoundingClientRect().width,cards:[...z.querySelectorAll('.card')].map(c=>c.getBoundingClientRect().width)}})()`);
  const menuItems = () => evalJs(`[...document.getElementById('menu').children].map(c=>c.tagName==='HR'?'-':c.textContent).join('|')`);
  // The same, with a mark on each item that is offered but cannot be chosen.
  const menuOffered = () => evalJs(`[...document.querySelectorAll('#menu [role="menuitem"]')].map(b=>b.textContent+(b.disabled?' (off)':'')).join('|')`);
  const menuRect = () => evalJs(`document.getElementById('menu').getBoundingClientRect().toJSON()`);
  const cardRect = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().toJSON()`);
  const tickers = (side) => evalJs(`[...document.querySelectorAll('#cmd-dmg-${side} .ticker')].map(t=>({uid:t.dataset.uid, name:t.querySelector('.cmd-name').textContent, title:t.querySelector('.cmd-name').title, n:t.querySelector('.n').textContent, lethal:t.classList.contains('lethal'), labels:[...t.querySelectorAll('button')].map(b=>b.getAttribute('aria-label'))}))`);
  const oppUi = () => evalJs(`({name: document.getElementById('opp-name').textContent, life: document.getElementById('life-opp').textContent, tabsHidden: document.getElementById('opp-tabs').hidden, tabs: [...document.querySelectorAll('#opp-tabs button')].map(b=>({text:b.textContent, selected:b.getAttribute('aria-selected')==='true', active:b.classList.contains('active')}))})`);

  let u = await ui();
  let st = await stagedUi();
  check('a fresh page: turn 1, my turn, 20/20, one log line, undo disabled, search focused', u.turn === 'turn 1 · my turn' && u.me === '20' && u.opp === '20' && u.log.length === 1 && /1 opponent, 20 life/.test(u.log[0]) && u.undo && await evalJs(`document.activeElement.id`) === 'q', JSON.stringify(u));
  check('dark theme: the page background is dark and the text light', await evalJs(`(()=>{const b=getComputedStyle(document.body);const lum=(c)=>{const [r,g,bl]=c.match(/\\d+/g).map(Number);return (r+g+bl)/3};return lum(b.backgroundColor)<40&&lum(b.color)>200&&getComputedStyle(document.documentElement).colorScheme==='dark'})()`));
  let o = await oppUi();
  check('one opponent: no tabs and a plain "opponent"; the search form is down to its look up button', o.tabsHidden && o.name === 'opponent' && (await evalJs(`[...document.querySelectorAll('#search button')].map(b=>b.textContent+':'+b.type).join('|')`)) === 'look up:submit', JSON.stringify(o));
  st = await stagedUi();
  check('nothing is staged to begin with: the slot is away', st.hidden, JSON.stringify(st));
  check('the opponent\'s hand pile is hidden while empty', await evalJs(`document.querySelector('[data-pile="opp:hand"]').hidden`));
  check('both sides have a command zone', (await evalJs(`document.querySelectorAll('.zone[data-zone="command"]').length`)) === 2);
  check('with no commander on the table, both commander damage rows are empty and take no room', (await tickers('me')).length === 0 && (await tickers('opp')).length === 0 && (await el('#cmd-dmg-me', 'getComputedStyle(e).display')) === 'none' && (await el('#cmd-dmg-opp', 'getComputedStyle(e).display')) === 'none');

  // the log collapses and the table takes the room
  const tableBefore = await width('.table');
  check('the log is open to begin with', !(await el('#log-panel', 'getComputedStyle(e).display')).includes('none') && (await el('#log-toggle', "e.getAttribute('aria-expanded')")) === 'true');
  await click('#log-toggle'); await sleep(100);
  const tableAfter = await width('.table');
  check('collapsing the log hides it and the table grows into the space', (await el('#log-panel', 'getComputedStyle(e).display')) === 'none' && tableAfter > tableBefore + 200 && (await el('#log-toggle', "e.getAttribute('aria-expanded')")) === 'false', `${Math.round(tableBefore)} -> ${Math.round(tableAfter)}px`);
  await shot('0-collapsed');
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(600);
  check('the collapse is remembered across a reload', (await el('#log-panel', 'getComputedStyle(e).display')) === 'none');
  await click('#log-toggle'); await sleep(100);
  check('and it opens again', Math.abs((await width('.table')) - tableBefore) < 2 && (await el('#log-panel', 'getComputedStyle(e).display')) !== 'none');

  // suggestions
  await evalJs(`document.getElementById('q').focus()`);
  await type('lightn'); await sleep(450); u = await ui();
  check('typing brings up suggestions after a pause', !u.suggestHidden && u.suggestions.length === 20 && u.suggestions.includes('Lightning Bolt'), JSON.stringify(u.suggestions.slice(0, 3)));
  const reqs = await evalJs('window.__requests.length');
  check('one autocomplete request for six keystrokes (debounced)', reqs === 1, `${reqs} requests`);
  const idx = u.suggestions.indexOf('Lightning Bolt');
  for (let i = 0; i <= idx; i++) await key('ArrowDown', 'ArrowDown', 40);
  check('arrow keys move the selection', (await evalJs(`document.querySelector('#suggest li[aria-selected="true"]')?.textContent`)) === 'Lightning Bolt');
  await key('Enter', 'Enter', 13); await sleep(50); u = await ui();
  check('enter takes the suggestion into the box and closes the list, adding nothing yet', u.q === 'Lightning Bolt' && u.suggestHidden && (await state()).cards.length === 0, JSON.stringify({ q: u.q, hidden: u.suggestHidden }));
  await key('Enter', 'Enter', 13); await sleep(300); u = await ui();
  st = await stagedUi();
  check('enter again looks it up and stages it: the slot shows its name and picture, named for a screen reader as staged, and the box clears', !st.hidden && st.name === 'Lightning Bolt' && /^https:\/\/cards\.scryfall\.io\//.test(st.img) && st.label === 'Lightning Bolt, staged' && u.q === '' && /Lightning Bolt — right-click it to place it/.test(u.status) && !u.error, JSON.stringify({ st, status: u.status }));
  check('staging puts nothing on the table and nothing in the log', (await state()).cards.length === 0 && u.log.length === 1 && u.undo);
  await key('Enter', 'Enter', 13); await sleep(150); u = await ui(); st = await stagedUi();
  let hand = await zone('me', 'hand');
  check('a second enter sends it to my hand and empties the slot; the log says so', hand.length === 1 && hand[0].name === 'Lightning Bolt' && st.hidden && /I draw Lightning Bolt/.test(u.log[0]) && /I draw Lightning Bolt/.test(u.status) && !u.error, JSON.stringify({ hand, status: u.status, log: u.log[0] }));
  check('undo is enabled now', !u.undo);

  // a creature to my hand, played, tapped
  await toHand('llanowar elves');
  hand = await zone('me', 'hand');
  check('a second card joins my hand', hand.length === 2 && hand[1].name === 'Llanowar Elves', JSON.stringify(hand));
  const elvesSel = `.card[data-uid="${hand[1].uid}"]`;
  let at = await rightClickAt(elvesSel);
  let items = await menuItems();
  check('right-clicking a card in hand offers play, copy and every zone but hand, and no counters', items === 'play|copy|-|to the battlefield|to the graveyard|to exile|to the command zone|-|remove', items);
  let mr = await menuRect();
  check('the menu opens at the pointer, inside the viewport', Math.abs(mr.left - at.x) <= 1 && (Math.abs(mr.top - at.y) <= 1 || Math.abs(mr.bottom - at.y) <= 1) && mr.right <= (await evalJs('innerWidth')) - 8 && mr.bottom <= (await evalJs('innerHeight')) - 8, JSON.stringify({ at, mr }));
  check('the card it belongs to says its name and where it is', (await el(elvesSel, "e.getAttribute('aria-label')")) === 'Llanowar Elves, hand' && (await el(elvesSel, "e.getAttribute('role')")) === 'group' && (await el(elvesSel, 'e.tabIndex')) === 0);
  const said = await evalJs(`(()=>{const c=document.querySelector('${elvesSel}');const d=document.getElementById(c.getAttribute('aria-describedby'));const r=d.getBoundingClientRect();return {text:d.textContent, width:Math.round(r.width), height:Math.round(r.height), mine:d.closest('.card')===c}})()`);
  check('and points a screen reader at what it says: its cost, type, text and stats, read out but not seen', said.mine && said.text === '{G}. Creature — Elf Druid. {T}: Add {G}.. 1/1' && said.width <= 1 && said.height <= 1, JSON.stringify(said));
  await key('Escape', 'Escape', 27); await sleep(80);
  check('escape closes the card menu without doing anything, and the card has the focus', (await el('#menu', 'e.hidden')) && (await zone('me', 'hand')).length === 2 && (await evalJs(`document.activeElement.dataset.uid`)) === hand[1].uid);
  await rightClickAt(`.card[data-uid="${hand[0].uid}"]`);
  check('right-clicking another card moves the menu to it', !(await el('#menu', 'e.hidden')) && (await menuItems()).startsWith('play|copy'));
  const moved0 = await menuRect();
  const again = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('.card[data-uid="${hand[0].uid}"]').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2)+20,y:Math.round(r.top+r.height/2)+20})})()`));
  await rightClick(again.x, again.y);
  const moved1 = await menuRect();
  check('right-clicking the same card again moves its menu to the new pointer rather than closing it', !(await el('#menu', 'e.hidden')) && (Math.abs(moved1.left - again.x) <= 1 || Math.abs(moved1.right - again.x) <= 1) && (Math.abs(moved1.top - again.y) <= 1 || Math.abs(moved1.bottom - again.y) <= 1) && (moved1.left !== moved0.left || moved1.top !== moved0.top), JSON.stringify({ again, moved0, moved1 }));
  // Away again: it is over the cards below it, and a right-click on the
  // menu itself is the menu's, not theirs.
  await key('Escape', 'Escape', 27); await sleep(50);
  await menuPick(elvesSel, 'play'); await sleep(50);
  let field = await zone('me', 'battlefield');
  check('play moves the creature to my battlefield, untapped', field.length === 1 && field[0].name === 'Llanowar Elves' && !field[0].tapped && (await zone('me', 'hand')).length === 1, JSON.stringify(field));
  await click(`.card[data-uid="${hand[1].uid}"] img`); await sleep(100); field = await zone('me', 'battlefield');
  check('clicking the card taps it', field[0].tapped && /I tap Llanowar Elves/.test((await ui()).log[0]));
  await sleep(200); // the turn and the box take 0.15s, and now run to the end: render() no longer cuts them short
  const tappedBox = await evalJs(`(()=>{const c=document.querySelector('.card.tapped');const r=c.getBoundingClientRect();const i=c.querySelector('img').getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),imgW:Math.round(i.width),imgH:Math.round(i.height),rot:getComputedStyle(c.querySelector('img')).transform!=='none'}})()`);
  check('a tapped card lies on its side: the image is rotated and its box is wider than tall', tappedBox.rot && tappedBox.w > tappedBox.h && Math.abs(tappedBox.w - tappedBox.imgW) <= 1, JSON.stringify(tappedBox));
  await shot('1-tapped');
  await click(`.card[data-uid="${hand[1].uid}"] img`); await sleep(100); field = await zone('me', 'battlefield');
  check('clicking again untaps it', !field[0].tapped);
  await click(`.card[data-uid="${hand[0].uid}"] img`); await sleep(100);
  check('clicking a card in hand does not tap it', !(await zone('me', 'hand'))[0].tapped);

  // my instant, cast
  await menuPick(`.card[data-uid="${hand[0].uid}"]`, 'play'); await sleep(50);
  check('playing an instant from hand casts it to my graveyard', (await zone('me', 'graveyard')).length === 1 && (await zone('me', 'hand')).length === 0 && /I cast Lightning Bolt/.test((await ui()).log[0]));

  // the opponent
  await evalJs(`document.getElementById('q').focus()`);
  await type('delver of secrets'); await key('Enter', 'Enter', 13, 8); await sleep(300); // shift+enter
  st = await stagedUi();
  check('shift+enter with text in the box stages it, just as enter does', !st.hidden && st.name.startsWith('Delver of Secrets') && (await zone('opp', 'battlefield')).length === 0, JSON.stringify(st));
  await key('Enter', 'Enter', 13, 8); await sleep(150);
  let theirs = await zone('opp', 'battlefield');
  check('shift+enter on a staged card: the opponent plays it, straight onto their battlefield', theirs.length === 1 && theirs[0].name === 'Delver of Secrets // Insectile Aberration' && /opponent plays Delver/.test((await ui()).log[0]), JSON.stringify(theirs));
  check('a double-faced card shows its front face', await evalJs(`document.querySelector('.zone[data-owner="opp"][data-zone="battlefield"] img').src.includes('/front/')`));
  // hovering: the panel of card text, and the card itself a little bigger
  const delverOnField = '.zone[data-owner="opp"][data-zone="battlefield"] .card';
  await hover(delverOnField);
  let pk = await peekUi(delverOnField);
  check('hovering a card describes it: name, cost, type, text, and its stats, a row each', !pk.hidden && pk.rows.join('|') === 'peek-name|peek-type|peek-text|peek-stats' && pk.text.includes('Delver of Secrets') && pk.text.includes('{U}') && pk.text.includes('Creature — Human Wizard') && pk.text.includes('Insectile Aberration') && pk.text.endsWith('1/1'), JSON.stringify(pk));
  check('the panel sits beside the card, on screen, and out of a screen reader\'s way', pk.fixed === 'fixed' && Math.abs(pk.gap - 8) <= 1 && pk.inView && pk.width > 200 && pk.aria === 'true', JSON.stringify(pk));
  check('no card carries the browser\'s own tooltip any more, and each says it opens a menu', (await evalJs(`document.querySelectorAll('.card[title]').length`)) === 0 && (await el(delverOnField, "e.getAttribute('aria-haspopup')")) === 'menu');
  await shot('b-hover');
  await unhover();
  check('moving off the card puts the panel away', (await peekUi(delverOnField)).hidden);
  await oppPlays('lightning bolt');
  check('shift+enter sends their instant to their graveyard', (await zone('opp', 'graveyard')).length === 1 && (await zone('opp', 'battlefield')).length === 1 && (await evalJs(`document.querySelector('[data-count="opp:graveyard"]').textContent`)) === '1');
  await click(`.card[data-uid="${theirs[0].uid}"] img`); await sleep(100);
  check('the opponent\'s creature taps on click too', (await zone('opp', 'battlefield'))[0].tapped);

  // turns
  await click(`.card[data-uid="${hand[1].uid}"] img`); await sleep(100); // tap mine again
  await click('#next'); await sleep(100); u = await ui();
  check('next turn: turn 2, the opponent\'s; their permanents untap, mine stay tapped', u.turn === "turn 2 · opponent's turn" && !(await zone('opp', 'battlefield'))[0].tapped && (await zone('me', 'battlefield'))[0].tapped && /^2 turn 2/.test(u.log[0]), JSON.stringify({ turn: u.turn, log: u.log[0] }));
  await click('#next'); await sleep(100); u = await ui();
  check('and again: turn 3, mine, my permanents untap', u.turn === 'turn 3 · my turn' && !(await zone('me', 'battlefield'))[0].tapped);

  // life
  await click('[data-life="opp"][data-by="-5"]'); await click('[data-life="opp"][data-by="-1"]'); await click('[data-life="me"][data-by="1"]'); await sleep(50); u = await ui();
  check('life buttons: opponent 20 -> 14, me 21, logged with the result', u.opp === '14' && u.me === '21' && /I gain 1 life \(21\)/.test(u.log[0]) && /opponent loses 1 life \(14\)/.test(u.log[1]), JSON.stringify({ opp: u.opp, me: u.me, log: u.log.slice(0, 2) }));

  // life totals are typeable, at the table: click opens an input, keeps it
  // out of render()'s way, and Enter or Escape ends it
  check('the life outputs are reachable as buttons and still announce their own updates', (await el('#life-me', "e.getAttribute('role')")) === 'button' && (await el('#life-me', "e.getAttribute('aria-live')")) === 'polite' && (await el('#life-opp', "e.getAttribute('role')")) === 'button' && (await el('#life-opp', "e.getAttribute('aria-live')")) === 'polite', JSON.stringify({ me: await el('#life-me', "e.getAttribute('role')"), live: await el('#life-me', "e.getAttribute('aria-live')") }));

  await click('#life-me'); await sleep(50);
  check('clicking my life total swaps it for an input holding the current value', (await el('#life-me', 'e.hidden')) === true && (await el('#life-me + .life-edit', 'e.hidden')) === false && (await el('#life-me + .life-edit', 'e.value')) === '21', JSON.stringify(await el('#life-me + .life-edit', 'e.value')));
  await evalJs(`document.getElementById('life-me').nextElementSibling.value = ''`); await type('31');
  await key('Enter', 'Enter', 13); await sleep(50); u = await ui();
  check('enter commits the typed total and logs it, and the output comes back', u.me === '31' && /my life is now 31/.test(u.log[0]) && (await el('#life-me', 'e.hidden')) === false && (await el('#life-me + .life-edit', 'e.hidden')) === true, JSON.stringify({ me: u.me, log: u.log[0] }));

  await click('#life-me'); await sleep(50);
  await evalJs(`document.getElementById('life-me').nextElementSibling.value = ''`); await type('99');
  await key('Escape', 'Escape', 27); await sleep(50); u = await ui();
  check('escape cancels without changing the total', u.me === '31' && (await el('#life-me', 'e.hidden')) === false && (await el('#life-me + .life-edit', 'e.hidden')) === true, u.me);

  // render() must leave a half-typed input alone: open it, type without
  // committing, then force a render from an unrelated commit elsewhere.
  await click('#life-me'); await sleep(50);
  await evalJs(`document.getElementById('life-me').nextElementSibling.value = ''`); await type('77');
  await click('[data-life="opp"][data-by="1"]'); await sleep(50); u = await ui();
  check('a render triggered elsewhere leaves an open, half-typed life input alone', u.opp === '15' && (await el('#life-me', 'e.hidden')) === true && (await el('#life-me + .life-edit', 'e.hidden')) === false && (await el('#life-me + .life-edit', 'e.value')) === '77', JSON.stringify({ opp: u.opp, val: await el('#life-me + .life-edit', 'e.value') }));
  await key('Enter', 'Enter', 13); await sleep(50); u = await ui();
  check('and it still commits the right value afterwards', u.me === '77' && /my life is now 77/.test(u.log[0]), JSON.stringify({ me: u.me, log: u.log[0] }));

  await click('#life-opp'); await sleep(50);
  await evalJs(`document.getElementById('life-opp').nextElementSibling.value = ''`); await type('12');
  await key('Enter', 'Enter', 13); await sleep(50); u = await ui();
  check('the opponent\'s life total edits the opponent in view, not me', u.opp === '12' && u.me === '77' && /opponent's life is now 12/.test(u.log[0]), JSON.stringify({ opp: u.opp, me: u.me, log: u.log[0] }));

  await click('#undo'); await sleep(80); u = await ui();
  check('undo brings a typed life back', u.opp === '15' && u.me === '77', JSON.stringify(u));
  await click('#undo'); await click('#undo'); await click('#undo'); await sleep(80); u = await ui();
  check('further undos restore the earlier typed total and the plain life-button change', u.me === '21' && u.opp === '14', JSON.stringify(u));

  // moves and remove
  await rightClickAt(elvesSel);
  items = await menuItems();
  check('a card on the battlefield offers counters and every other zone, and no play', items === 'copy|add counter…|-|to hand|to the graveyard|to exile|to the command zone|-|remove', items);
  const menuTitles = await evalJs(`[...document.querySelectorAll('#menu [role="menuitem"]')].map(b=>b.title).join('|')`);
  check('remove and copy say what they do', menuTitles.includes('never there (a mistake)') && menuTitles.includes('another of this card, beside it'), menuTitles);
  await pickItem('to exile'); await sleep(50);
  check('a battlefield card can be exiled from its menu', (await zone('me', 'exile')).length === 1 && (await zone('me', 'battlefield')).length === 0);
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);
  check('and brought back to the battlefield from exile', (await zone('me', 'battlefield')).length === 1);
  await menuPick(`.card[data-uid="${hand[0].uid}"]`, 'remove'); await sleep(50);
  check('remove deletes a card outright', (await zone('me', 'graveyard')).length === 0 && /I remove Lightning Bolt/.test((await ui()).log[0]));
  const pileCard = await evalJs(`(()=>{const i=document.querySelector('.pile .card img');const r=i.getBoundingClientRect();const z=i.closest('.zone').getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),ratio:Math.round(r.width/r.height*1000)/1000,zoneH:Math.round(z.height)}})()`);
  check('a card in a pile is small and keeps its proportions; the pile is only as tall as it needs', pileCard.w < 70 && Math.abs(pileCard.ratio - 488 / 680) < 0.01 && pileCard.zoneH < pileCard.h + 20, JSON.stringify(pileCard));
  const fieldCard = await evalJs(`(()=>{const i=document.querySelector('.battlefield .card:not(.tapped) img');const r=i.getBoundingClientRect();return {w:Math.round(r.width),ratio:Math.round(r.width/r.height*1000)/1000}})()`);
  check('a card on the battlefield is full size with the same proportions', fieldCard.w > 100 && Math.abs(fieldCard.ratio - 488 / 680) < 0.01, JSON.stringify(fieldCard));

  // the command zone
  await menuPick(elvesSel, 'to the command zone'); await sleep(50);
  check('a card can be sent to my command zone, where it wears the commander mark', (await zone('me', 'command')).length === 1 && (await el(`.card[data-uid="${hand[1].uid}"]`, "e.classList.contains('commander')")) && /my Llanowar Elves to command zone/.test((await ui()).log[0]));
  let tk = await tickers('opp');
  check('my commander gives the opponent a ticker of its own, at nothing, and me none', tk.length === 1 && tk[0].uid === hand[1].uid && tk[0].name === 'Llanowar Elves' && tk[0].title === 'Llanowar Elves' && tk[0].n === '0' && !tk[0].lethal && (await tickers('me')).length === 0, JSON.stringify(tk));
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);
  check('cast from the command zone, it keeps the mark on the battlefield', (await zone('me', 'battlefield')).length === 1 && (await el(`.card[data-uid="${hand[1].uid}"]`, "e.classList.contains('commander')")));
  await menuPick(elvesSel, 'to the command zone'); await sleep(50);
  check('and can go back', (await zone('me', 'command')).length === 1);
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);
  await shot('2-table');

  // the staged card's own menu: right-clicked exactly like a card on the
  // table, since Task 12 moved it out of the navbar
  const onTable = (await state()).cards.length;
  await evalJs(`document.getElementById('q').focus()`);
  await type('bolt'); await click('#look-up'); await sleep(300);
  st = await stagedUi();
  check('clicking look up stages the typed card, as enter does: it waits in its slot with nothing added to the table', !st.hidden && st.name === 'Lightning Bolt' && (await zone('me', 'hand')).length === 0 && (await state()).cards.length === onTable, JSON.stringify(st));
  await shot('c-staged');
  at = await rightClickAt('#staged');
  items = await menuItems();
  check('right-clicking the staged card opens its menu at the pointer: my hand, the opponent playing it, and both command zones', items === "send to my hand|opponent plays|send to my command zone|send to opponent's command zone", items);
  mr = await menuRect();
  check('the menu opens at the pointer, inside the viewport', Math.abs(mr.left - at.x) <= 1 && (Math.abs(mr.top - at.y) <= 1 || Math.abs(mr.bottom - at.y) <= 1), JSON.stringify({ at, mr }));
  await key('Escape', 'Escape', 27); await sleep(50);
  check('escape closes the menu, leaving the card staged', (await el('#menu', 'e.hidden')) && !(await stagedUi()).hidden);
  await evalJs(`document.getElementById('staged').focus()`);
  await key('Enter', 'Enter', 13); await sleep(80);
  check('enter on the focused slot opens the same menu', !(await el('#menu', 'e.hidden')) && (await menuItems()) === "send to my hand|opponent plays|send to my command zone|send to opponent's command zone");
  await pickItem('send to my hand');
  const staysInHand = await zone('me', 'hand');
  check('send to my hand puts it in my hand and empties the slot', staysInHand.length === 1 && staysInHand[0].name === 'Lightning Bolt' && (await stagedUi()).hidden && /I draw Lightning Bolt/.test((await ui()).log[0]), JSON.stringify(staysInHand));
  await menuPick(`.card[data-uid="${staysInHand[0].uid}"]`, 'remove'); await sleep(50);
  await stage('llanowar elves');
  await menuPick('#staged', 'opponent plays'); await sleep(50);
  const theirField = await zone('opp', 'battlefield');
  const theirElves = theirField.find((c) => c.name === 'Llanowar Elves');
  check('opponent plays is the opponent playing it: their permanent lands on their battlefield', theirField.length === 2 && theirElves && (await stagedUi()).hidden && /opponent plays Llanowar Elves/.test((await ui()).log[0]), JSON.stringify(theirField));
  await menuPick(`.card[data-uid="${theirElves.uid}"]`, 'remove'); await sleep(50);
  await stage('bolt');
  await menuPick('#staged', 'send to my command zone'); await sleep(50);
  let cmd = await zone('me', 'command');
  st = await stagedUi();
  check('send to my command zone puts it there wearing the commander mark, and empties the slot', cmd.length === 1 && cmd[0].name === 'Lightning Bolt' && (await el(`.card[data-uid="${cmd[0].uid}"]`, "e.classList.contains('commander')")) && st.hidden && /I put Lightning Bolt in command zone/.test((await ui()).log[0]), JSON.stringify({ cmd, st }));
  await menuPick(`.card[data-uid="${cmd[0].uid}"]`, 'remove'); await sleep(50);
  // discarded rather than placed
  await stage('bolt');
  await click('#staged-clear'); await sleep(80); st = await stagedUi();
  check('the × discards the staged card without opening a menu: nothing reaches the table', st.hidden && (await el('#menu', 'e.hidden')) && (await zone('me', 'command')).length === 0 && (await state()).cards.length === onTable && /discarded Lightning Bolt/.test((await ui()).status), JSON.stringify(st));
  await stage('bolt');
  await key('Escape', 'Escape', 27); await sleep(80);
  st = await stagedUi();
  check('escape in the empty box discards it too', st.hidden && (await state()).cards.length === onTable, JSON.stringify(st));

  // copies
  await click(`.card[data-uid="${hand[1].uid}"] img`); await sleep(50); // tap the original first
  await menuPick(elvesSel, 'copy'); await sleep(50);
  field = await zone('me', 'battlefield');
  check('copy puts a second, untapped Llanowar Elves right after the tapped original', field.length === 2 && field.every((c) => c.name === 'Llanowar Elves') && field[0].uid === hand[1].uid && field[0].tapped && !field[1].tapped && /I copy Llanowar Elves/.test((await ui()).log[0]), JSON.stringify(field));
  const copyUid = field[1].uid;
  check('the copy has no commander mark, though the original does', (await el(`.card[data-uid="${copyUid}"]`, "e.classList.contains('commander')")) === false && (await el(`.card[data-uid="${hand[1].uid}"]`, "e.classList.contains('commander')")) === true);
  await click(`.card[data-uid="${copyUid}"] img`); await sleep(50);
  check('the copy taps on its own', (await zone('me', 'battlefield'))[1].tapped && (await zone('me', 'battlefield'))[0].tapped);
  await menuPick(`.card[data-uid="${theirs[0].uid}"]`, 'copy'); await sleep(50);
  check('the opponent\'s card copies too, logged as theirs', (await zone('opp', 'battlefield')).length === 2 && /opponent copies Delver/.test((await ui()).log[0]));
  await shot('9-copies');
  // the zoom: bigger under the pointer, and nothing around it moves
  await unhover();
  const restingBoxes = await fieldBoxes('opp');
  await hover(`.card[data-uid="${(await zone('opp', 'battlefield'))[0].uid}"]`);
  const zoomedBoxes = await fieldBoxes('opp');
  check('the card under the pointer is drawn bigger, while its neighbour and the zone stay as they were', zoomedBoxes.cards[0] > restingBoxes.cards[0] + 3 && Math.abs(zoomedBoxes.cards[1] - restingBoxes.cards[1]) < 0.5 && Math.abs(zoomedBoxes.zone - restingBoxes.zone) < 0.5, JSON.stringify({ resting: restingBoxes, zoomed: zoomedBoxes }));
  await unhover();
  await menuPick(`.card[data-uid="${copyUid}"]`, 'remove'); await sleep(50);
  await menuPick(`.card[data-uid="${(await zone('opp', 'battlefield'))[1].uid}"]`, 'remove'); await sleep(50);
  await click(`.card[data-uid="${hand[1].uid}"] img`); await sleep(50); // untap the original again
  check('(copies removed, original untapped, for the checks that follow)', (await zone('me', 'battlefield')).length === 1 && (await zone('opp', 'battlefield')).length === 1 && !(await zone('me', 'battlefield'))[0].tapped);

  // lands have a row of their own
  await toHand('forest');
  const forestUid = (await zone('me', 'hand'))[0].uid;
  await menuPick(`.card[data-uid="${forestUid}"]`, 'play'); await sleep(50);
  field = await zone('me', 'battlefield');
  check('a land played to my battlefield goes to the lands row; the creature is in the other', field.find((c) => c.name === 'Forest')?.tier === 'lands' && field.find((c) => c.name === 'Llanowar Elves')?.tier === 'spells', JSON.stringify(field));
  const rows = JSON.parse(await evalJs(`(()=>{const r=(sel)=>document.querySelector(sel).getBoundingClientRect();const me={lands:r('.zone[data-owner="me"] .tier[data-tier="lands"]'),spells:r('.zone[data-owner="me"] .tier[data-tier="spells"]')};const op={lands:r('.zone[data-owner="opp"] .tier[data-tier="lands"]'),spells:r('.zone[data-owner="opp"] .tier[data-tier="spells"]')};return JSON.stringify({meLandsBelow:me.lands.top>me.spells.bottom-1,oppLandsAbove:op.lands.bottom<=op.spells.top+1,emptyRowThin:op.lands.height<40,labels:[...document.querySelectorAll('.tier')].map(t=>getComputedStyle(t,'::before').content)})})()`));
  check('my lands row is below my other permanents; the opponent\'s is above theirs; an empty row is a thin labelled strip', rows.meLandsBelow && rows.oppLandsAbove && rows.emptyRowThin && rows.labels.every((l) => /lands|spells/.test(l)), JSON.stringify(rows));
  await oppPlays('forest');
  check('the opponent\'s land goes to their lands row', (await zone('opp', 'battlefield')).find((c) => c.name === 'Forest')?.tier === 'lands');
  const tierFit = JSON.parse(await evalJs(`(()=>{const out=[];for(const t of document.querySelectorAll('.tier')){const z=t.closest('.zone').getBoundingClientRect();const r=t.getBoundingClientRect();const cs=getComputedStyle(t,'::before');const lw=parseFloat(cs.width)||0;const label={left:r.right-parseFloat(cs.right)-lw,right:r.right-parseFloat(cs.right),top:r.top+parseFloat(cs.top),bottom:r.top+parseFloat(cs.top)+(parseFloat(cs.height)||12)};const covered=[...t.querySelectorAll('.card')].some(c=>{const b=c.getBoundingClientRect();return b.left<label.right&&b.right>label.left&&b.top<label.bottom&&b.bottom>label.top});out.push({tier:t.dataset.tier,spansZone:z.width-r.width<20,labelCovered:covered,cards:t.querySelectorAll('.card').length})}return JSON.stringify(out)})()`));
  check('each row spans the whole battlefield, and no card sits over its label', tierFit.every((t) => t.spansZone && !t.labelCovered), JSON.stringify(tierFit));
  await click(`.card[data-uid="${forestUid}"] img`); await sleep(100);
  check('a land taps like any permanent', (await zone('me', 'battlefield')).find((c) => c.name === 'Forest').tapped);
  await shot('8-lands');

  // dragging cards into order within a row
  await menuPick(elvesSel, 'copy'); await sleep(60);
  await menuPick(elvesSel, 'copy'); await sleep(60);
  await menuPick(`.card[data-uid="${forestUid}"]`, 'copy'); await sleep(60);
  const rowOf = async (tier) => (await zone('me', 'battlefield')).filter((c) => c.tier === tier).map((c) => c.uid);
  const savedRow = async (lands) => (await state()).cards.filter((c) => c.owner === 'me' && c.zone === 'battlefield' && /\bLand\b/.test(c.typeLine) === lands).map((c) => c.uid);
  let order = await rowOf('spells');
  const lands = await rowOf('lands');
  check('(three creatures in my spells row and two lands in the other, for the drags)', order.length === 3 && order[0] === hand[1].uid && lands.length === 2 && (await savedRow(false)).join('|') === order.join('|'), JSON.stringify({ order, lands }));
  let logWas = (await ui()).log.length;
  let carried = await dragOnto(`.card[data-uid="${order[1]}"]`, `.card[data-uid="${order[0]}"]`, 'before');
  let now = await rowOf('spells');
  check('dragging the second creature in front of the first reorders the row, and the saved game agrees', now.join('|') === [order[1], order[0], order[2]].join('|') && (await savedRow(false)).join('|') === now.join('|'), JSON.stringify({ order, now, saved: await savedRow(false) }));
  check('mid-drag the card is carried: raised, see-through, under the pointer, grabbing over card and image alike, not zoomed, and already first in the row', carried.dragging && carried.opacity === 0.85 && carried.zoom === 1 && carried.cursor === 'grabbing' && carried.imgCursor === 'grabbing' && carried.moved && carried.at === 0, JSON.stringify(carried));
  check('the drag leaves no log line: where a card sits is not a move in the game', (await ui()).log.length === logWas, JSON.stringify((await ui()).log.slice(0, 2)));
  check('and it did not tap the card it carried, nor leave it carrying anything', !(await zone('me', 'battlefield')).find((c) => c.uid === order[1]).tapped && (await evalJs(`document.querySelectorAll('.card.dragging').length`)) === 0 && (await el(`.card[data-uid="${order[1]}"]`, 'e.style.transform')) === '');
  check('the lands row was left alone', (await rowOf('lands')).join('|') === lands.join('|'));
  await shot('f-reordered');
  await clickAt(`.card[data-uid="${order[1]}"]`); await sleep(80);
  check('a press that does not travel is still a click, and still taps the card', (await zone('me', 'battlefield')).find((c) => c.uid === order[1]).tapped);
  await clickAt(`.card[data-uid="${order[1]}"]`); await sleep(80);
  check('(untapped again)', !(await zone('me', 'battlefield')).find((c) => c.uid === order[1]).tapped);
  await nudge(`.card[data-uid="${order[1]}"]`, 2);
  check('a press that travels less than the threshold is a tap too: the card taps and the row does not move', (await zone('me', 'battlefield')).find((c) => c.uid === order[1]).tapped && (await rowOf('spells')).join('|') === now.join('|'), JSON.stringify(await rowOf('spells')));
  await clickAt(`.card[data-uid="${order[1]}"]`); await sleep(80);
  check('(untapped again)', !(await zone('me', 'battlefield')).find((c) => c.uid === order[1]).tapped);

  // the same reorder without a pointer to drag with: the card's own menu,
  // which a finger and the keyboard both reach
  await rightClickAt(`.card[data-uid="${now[1]}"]`);
  check('a card with a neighbour on either side offers move left and move right', (await menuItems()) === 'copy|add counter…|move left|move right|-|to hand|to the graveyard|to exile|to the command zone|-|remove', await menuItems());
  const moveTitles = await evalJs(`[...document.querySelectorAll('#menu [role="menuitem"]')].filter(b=>b.textContent.startsWith('move ')).map(b=>b.title).join('|')`);
  check('and each says what it does', moveTitles === 'one place earlier in its row|one place later in its row', moveTitles);
  await pickItem('move left'); await sleep(80);
  check('move left steps the card one place earlier in its row, and the save agrees', (await rowOf('spells')).join('|') === [now[1], now[0], now[2]].join('|') && (await savedRow(false)).join('|') === (await rowOf('spells')).join('|'), JSON.stringify(await rowOf('spells')));
  logWas = (await ui()).log.length;
  await menuPick(`.card[data-uid="${now[1]}"]`, 'move right'); await sleep(80);
  check('move right steps it back, and neither wrote a log line', (await rowOf('spells')).join('|') === now.join('|') && (await ui()).log.length === logWas, JSON.stringify(await rowOf('spells')));
  await rightClickAt(`.card[data-uid="${now[0]}"]`);
  check('the first card of a run is offered move right and no move left', (await menuItems()) === 'copy|add counter…|move right|-|to hand|to the graveyard|to exile|to the command zone|-|remove', await menuItems());
  await key('Escape', 'Escape', 27); await sleep(50);
  await rightClickAt(`.card[data-uid="${now[2]}"]`);
  check('the last is offered move left and no move right', (await menuItems()) === 'copy|add counter…|move left|-|to hand|to the graveyard|to exile|to the command zone|-|remove', await menuItems());
  await key('Escape', 'Escape', 27); await sleep(50);
  await rightClickAt(`.card[data-uid="${lands[0]}"]`);
  check('a land is offered the moves of its own row, not the spells row\'s', (await menuItems()).includes('move right') && !(await menuItems()).includes('move left'), await menuItems());
  await key('Escape', 'Escape', 27); await sleep(50);

  // a row at a time: a land dragged at the spells row goes back where it was
  const saveWas = JSON.stringify(await state());
  carried = await dragOnto(`.card[data-uid="${lands[0]}"]`, '.zone[data-owner="me"] .tier[data-tier="spells"]', 'onto');
  check('a land cannot be dropped into the spells row: it is carried, but both rows are as they were and nothing was saved', carried.dragging && (await rowOf('lands')).join('|') === lands.join('|') && (await rowOf('spells')).join('|') === now.join('|') && JSON.stringify(await state()) === saveWas, JSON.stringify({ carried, lands: await rowOf('lands'), spells: await rowOf('spells') }));
  check('the land it carried is back in its own row, carrying nothing', (await el(`.card[data-uid="${lands[0]}"]`, "e.closest('.tier').dataset.tier")) === 'lands' && (await el(`.card[data-uid="${lands[0]}"]`, 'e.style.transform')) === '' && (await evalJs(`document.querySelectorAll('.card.dragging').length`)) === 0);

  await send('Page.navigate', { url: `${BASE}/` }); await sleep(800);
  check('the order survives a reload', (await rowOf('spells')).join('|') === now.join('|'), JSON.stringify(await rowOf('spells')));
  // The reload emptied the undo stack, so this drag is the one undo takes back.
  await dragOnto(`.card[data-uid="${now[0]}"]`, `.card[data-uid="${now[2]}"]`, 'after');
  check('a card dropped past the last of its row goes to the end of it', (await rowOf('spells')).join('|') === [now[1], now[2], now[0]].join('|'), JSON.stringify(await rowOf('spells')));
  await click('#undo'); await sleep(80);
  check('undo puts the order back, on the table and in the save', (await rowOf('spells')).join('|') === now.join('|') && (await savedRow(false)).join('|') === now.join('|'), JSON.stringify(await rowOf('spells')));

  // A drag called off with escape and let go over the log sends its click to
  // the log rather than the table, so nothing there clears the flag that
  // says the last press was a drag. The next press anywhere must clear it,
  // or it would swallow a click it has nothing to do with.
  const held = await centre(`.card[data-uid="${now[0]}"]`);
  await mouse('mousePressed', held.x, held.y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', held.x + 6 * i, held.y);
  await key('Escape', 'Escape', 27); await sleep(50);
  const away = await centre('#log-panel');
  await mouse('mouseReleased', away.x, away.y, 0); await sleep(80);
  check('escape calls a drag off: the card goes back and the row is as it was', (await rowOf('spells')).join('|') === now.join('|') && (await el(`.card[data-uid="${now[0]}"]`, 'e.style.transform')) === '' && (await evalJs(`document.querySelectorAll('.card.dragging').length`)) === 0, JSON.stringify(await rowOf('spells')));
  await clickAt('#turn'); // a press with nothing to do with the table
  await click(`.card[data-uid="${now[0]}"] img`); await sleep(80);
  check('and a press anywhere after it clears the drag, so the next click on a card taps it', (await zone('me', 'battlefield')).find((c) => c.uid === now[0]).tapped);
  await click(`.card[data-uid="${now[0]}"] img`); await sleep(80);
  check('(untapped again)', !(await zone('me', 'battlefield')).find((c) => c.uid === now[0]).tapped);

  await menuPick(`.card[data-uid="${order[1]}"]`, 'remove'); await sleep(50);
  await menuPick(`.card[data-uid="${order[2]}"]`, 'remove'); await sleep(50);
  await menuPick(`.card[data-uid="${lands[1]}"]`, 'remove'); await sleep(50);
  check('(the copies are removed, leaving the row as it was)', (await rowOf('spells')).join('|') === hand[1].uid && (await rowOf('lands')).join('|') === forestUid, JSON.stringify(await zone('me', 'battlefield')));

  await menuPick(`.card[data-uid="${forestUid}"]`, 'remove'); await sleep(50);
  await menuPick(`.card[data-uid="${(await zone('opp', 'battlefield')).find((c) => c.name === 'Forest').uid}"]`, 'remove'); await sleep(50);
  check('(both lands removed for the checks that follow)', (await zone('me', 'battlefield')).length === 1 && (await zone('opp', 'battlefield')).length === 1);

  // equipment: put on a creature from the menu, and tucked in behind it
  // How a card sits against the one before it in its row: how far the
  // neighbour covers it, and which of the two is drawn in front.
  const tucked = (uid) => evalJs(`(()=>{const e=document.querySelector('.card[data-uid="${uid}"]');const p=e.previousElementSibling;const r=e.getBoundingClientRect();const h=p?.getBoundingClientRect();return {attached:e.classList.contains('attached'), after:p?.dataset.uid, over:h?Math.round(h.right-r.left):null, width:Math.round(r.width), z:getComputedStyle(e).zIndex, hostZ:p?getComputedStyle(p).zIndex:null, hostMarked:Boolean(p?.classList.contains('has-equipment')), row:e.closest('.tier')?.dataset.tier}})()`);
  const attachedTo = async (uid) => (await state()).cards.find((c) => c.uid === uid)?.attachedTo;
  // A tucked card is pointed at by the edge of it that shows: its middle is
  // under its host, which is drawn in front of it.
  const showing = async (sel) => {
    await evalJs(`document.querySelector(${'${JSON.stringify(sel)}'}).scrollIntoView({block:'center'})`);
    await sleep(150);
    const r = await cardRect(sel);
    return { x: Math.round(r.right - 6), y: Math.round(r.top + r.height / 2) };
  };
  const pickAtEdge = async (sel, label) => { const p = await showing(sel); await rightClick(p.x, p.y); return pickItem(label); };
  await toHand('bonesplitter');
  const bonesUid = (await zone('me', 'hand')).find((c) => c.name === 'Bonesplitter').uid;
  const bonesSel = `.card[data-uid="${bonesUid}"]`;
  await rightClickAt(bonesSel);
  check('an equipment in hand is offered nothing to equip: it goes on a creature from the table', !(await menuItems()).includes('equip'), await menuItems());
  await pickItem('play'); await sleep(120);
  check('played, it stands in my spells row beside the creature', (await rowOf('spells')).join('|') === [hand[1].uid, bonesUid].join('|'), JSON.stringify(await rowOf('spells')));
  await rightClickAt(elvesSel);
  check('a creature\'s own menu is unchanged: nothing to equip on it', !(await menuItems()).includes('equip'), await menuItems());
  await key('Escape', 'Escape', 27); await sleep(50);
  await rightClickAt(bonesSel);
  check('the equipment offers the creature on its own battlefield, and not the one across the table', (await menuItems()) === 'copy|add counter…|move left|equip Llanowar Elves|-|to hand|to the graveyard|to exile|to the command zone|-|remove', await menuItems());
  await key('Escape', 'Escape', 27); await sleep(50);
  await toHand('delver');
  const myDelver = (await zone('me', 'hand')).find((c) => c.name.startsWith('Delver')).uid;
  await menuPick(`.card[data-uid="${myDelver}"]`, 'play'); await sleep(120);
  await rightClickAt(bonesSel);
  check('a second creature of mine is a second item, in the order they sit on the table', (await menuItems()).includes('equip Llanowar Elves|equip Delver of Secrets // Insectile Aberration'), await menuItems());
  await key('Escape', 'Escape', 27); await sleep(50);
  await menuPick(`.card[data-uid="${myDelver}"]`, 'remove'); await sleep(80);
  await menuPick(elvesSel, 'to hand'); await sleep(120);
  await rightClickAt(bonesSel);
  check('with no creature of mine out it says why, rather than leaving the choice out with no reason', (await menuOffered()).includes('no creature to equip (off)'), await menuOffered());
  await key('Escape', 'Escape', 27); await sleep(50);
  await menuPick(elvesSel, 'play'); await sleep(120);
  await menuPick(bonesSel, 'equip Llanowar Elves'); await sleep(150);
  let tuck = await tucked(bonesUid);
  u = await ui();
  check('choosing the creature equips it: the log says so, and the save has it on that card', /I equip Llanowar Elves with Bonesplitter/.test(u.log[0]) && (await attachedTo(bonesUid)) === hand[1].uid, JSON.stringify({ log: u.log[0], on: await attachedTo(bonesUid) }));
  check('and it is drawn straight after its host, tucked in behind it: covered by most of a card, and under it', tuck.attached && tuck.after === hand[1].uid && tuck.over > tuck.width / 2 && tuck.hostMarked && Number(tuck.z) < Number(tuck.hostZ) && tuck.row === 'spells', JSON.stringify(tuck));
  check('and a reader is told what it is on, which otherwise only a pointer can see', (await el(bonesSel, "e.getAttribute('aria-label')")) === 'Bonesplitter, battlefield, on Llanowar Elves', await el(bonesSel, "e.getAttribute('aria-label')"));
  let sliver = await showing(bonesSel);
  await mouse('mouseMoved', sliver.x, sliver.y, 0); await sleep(250);
  const raised = await evalJs(`getComputedStyle(document.querySelector('${bonesSel}')).zIndex`);
  let pk2 = await peekUi(bonesSel);
  check('hovering the edge that shows still brings it out in front of its host, with its own panel', Number(raised) > Number(tuck.hostZ) && !pk2.hidden && /Equipped creature gets \+2\/\+0/.test(pk2.text), JSON.stringify({ raised, hostZ: tuck.hostZ, text: pk2.text.slice(0, 40) }));
  await unhover();
  await shot('g-equipped');
  sliver = await showing(bonesSel);
  await rightClick(sliver.x, sliver.y);
  check('the edge that shows is the equipment\'s own to right-click, not its host\'s: the creature it is on is still listed but cannot be chosen, and unequip joins the menu', (await menuOffered()).includes('equip Llanowar Elves (off)') && (await menuOffered()).includes('unequip'), await menuOffered());
  check('an attached equipment is offered no move along the row: it goes where its host goes', !/move (left|right)/.test(await menuItems()), await menuItems());
  await pickItem('unequip'); await sleep(150);
  tuck = await tucked(bonesUid);
  check('unequip takes it off and it stands in its own place in the row again', !tuck.attached && !tuck.hostMarked && tuck.over < 0 && (await attachedTo(bonesUid)) === undefined && /my Bonesplitter comes off Llanowar Elves/.test((await ui()).log[0]) && (await el(bonesSel, "e.getAttribute('aria-label')")) === 'Bonesplitter, battlefield', JSON.stringify(tuck));
  await menuPick(bonesSel, 'equip Llanowar Elves'); await sleep(150);
  await click('#undo'); await sleep(150);
  check('undo steps the attachment back off', !(await tucked(bonesUid)).attached && (await attachedTo(bonesUid)) === undefined);
  await menuPick(bonesSel, 'equip Llanowar Elves'); await sleep(150);
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(800);
  tuck = await tucked(bonesUid);
  check('the attachment survives a reload, tucked in behind its host again', tuck.attached && tuck.after === hand[1].uid && (await attachedTo(bonesUid)) === hand[1].uid, JSON.stringify(tuck));
  logWas = (await ui()).log.length;
  await menuPick(elvesSel, 'to the graveyard'); await sleep(900);
  u = await ui();
  check('the host sent to the graveyard takes the equipment off, and the move is the only line about it', !(await tucked(bonesUid)).attached && (await attachedTo(bonesUid)) === undefined && u.log.length === logWas + 1 && /my Llanowar Elves to graveyard/.test(u.log[0]), JSON.stringify({ log: u.log.slice(0, 2), on: await attachedTo(bonesUid) }));
  await click('#undo'); await sleep(200);
  check('undo brings the creature back with the equipment on it again', (await tucked(bonesUid)).attached && (await attachedTo(bonesUid)) === hand[1].uid);
  await pickAtEdge(bonesSel, 'remove'); await sleep(120);
  check('(the equipment is off the table, leaving the row as it was)', (await rowOf('spells')).join('|') === hand[1].uid && (await el(elvesSel, "e.classList.contains('has-equipment')")) === false, JSON.stringify(await zone('me', 'battlefield')));

  // counters
  const squares = () => evalJs(`[...document.querySelectorAll('${elvesSel} .counter')].map(s=>({n:s.querySelector('.n').textContent,k:s.querySelector('.k').textContent,cid:s.dataset.cid,left:parseFloat(s.style.getPropertyValue('--x')),top:parseFloat(s.style.getPropertyValue('--y'))}))`);
  const counterState = async () => (await state()).cards.find((c) => c.uid === hand[1].uid).counters;
  await menuPick(elvesSel, 'add counter…'); await sleep(50);
  check('add counter… opens a picker on the card, prefilled +1/+1 and focused', !(await el('#ctr-pick', 'e.hidden')) && (await el('#ctr-pick', "e.closest('.card')?.dataset.uid")) === hand[1].uid && (await el('#ctr-kind', 'e.value')) === '+1/+1' && (await evalJs('document.activeElement.id')) === 'ctr-kind');
  await key('Enter', 'Enter', 13); await sleep(80);
  let sq = await squares();
  check('closed, the picker is not left inside the card', (await el('#ctr-pick', "e.closest('.card')")) === null && (await el('#ctr-pick', "e.parentElement.id")) === 'journal');
  check('enter adds a +1/+1 counter: one square, showing 1 and its kind; picker closes; logged', sq.length === 1 && sq[0].n === '1' && sq[0].k === '+1/+1' && (await el('#ctr-pick', 'e.hidden')) && /I put a \+1\/\+1 counter on Llanowar Elves \(1\)/.test((await ui()).log[0]), JSON.stringify(sq));
  await menuPick(elvesSel, 'add counter…'); await key('Enter', 'Enter', 13); await sleep(80); sq = await squares();
  check('a second +1/+1 stacks onto the same square: 2', sq.length === 1 && sq[0].n === '2', JSON.stringify(sq));
  await menuPick(elvesSel, 'add counter…');
  await evalJs(`document.getElementById('ctr-kind').value=''`); await type('lore'); await key('Enter', 'Enter', 13); await sleep(80); sq = await squares();
  check('a custom kind is its own square, below the first', sq.length === 2 && sq[1].k === 'lore' && sq[1].n === '1' && sq[1].top > sq[0].top && /I put a lore counter on/.test((await ui()).log[0]), JSON.stringify(sq));
  const sqBox = await evalJs(`(()=>{const s=document.querySelector('${elvesSel} .counter');const r=s.getBoundingClientRect();const c=document.querySelector('${elvesSel}').getBoundingClientRect();const st=getComputedStyle(s);return {w:r.width,h:r.height,inside:r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom,alpha:parseFloat((st.backgroundColor.match(/[\\d.]+\\)$/)||['1'])[0])}})()`);
  check('a square is small, translucent, and inside the card', sqBox.w < 40 && Math.abs(sqBox.w - sqBox.h) < 1 && sqBox.inside && sqBox.alpha < 0.8, JSON.stringify(sqBox));
  await shot('6-counters');

  // + and − on hover
  const c0 = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('${elvesSel} .counter[data-cid="${sq[0].cid}"]').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`));
  await mouse('mouseMoved', c0.x, c0.y, 0); await sleep(80);
  check('hovering a square shows + and −', (await evalJs(`getComputedStyle(document.querySelector('${elvesSel} .counter[data-cid="${sq[0].cid}"] .adj')).display`)) === 'flex');
  await click(`${elvesSel} .counter[data-cid="${sq[0].cid}"] button[data-ctr="1"]`); await sleep(50); sq = await squares();
  check('+ makes it 3', sq[0].n === '3' && /\(3\)/.test((await ui()).log[0]));
  for (let i = 0; i < 3; i++) { await click(`${elvesSel} .counter[data-cid="${sq[0].cid}"] button[data-ctr="-1"]`); await sleep(30); }
  sq = await squares();
  check('− three times removes the square; lore stays', sq.length === 1 && sq[0].k === 'lore' && /I remove a \+1\/\+1 counter from Llanowar Elves \(0\)/.test((await ui()).log[0]), JSON.stringify(sq));
  check('the card was not tapped by any of that', !(await zone('me', 'battlefield'))[0].tapped);

  // dragging. Measured either side of the drag with the card's zoom
  // settled: a commit re-draws the card under the pointer, which sets it
  // growing again, and a square on a card half-grown is not where it lands.
  await sleep(250);
  const cardBox = JSON.parse(await evalJs(`JSON.stringify(document.querySelector('${elvesSel}').getBoundingClientRect())`));
  let p0 = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('${elvesSel} .counter').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height})})()`));
  await mouse('mousePressed', p0.x, p0.y);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p0.x + 5 * i, p0.y + 8 * i);
  const during = JSON.parse(await evalJs(`(()=>{const s=document.querySelector('${elvesSel} .counter');return JSON.stringify({dragging:s.classList.contains('dragging'),left:s.style.left})})()`));
  await mouse('mouseReleased', p0.x + 40, p0.y + 64, 0); await sleep(250);
  let p1 = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('${elvesSel} .counter').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`));
  let ks = await counterState();
  check('a square drags with the pointer and is committed where it was let go', during.dragging && during.left.endsWith('px') && Math.abs(p1.x - (p0.x + 40)) <= 1 && Math.abs(p1.y - (p0.y + 64)) <= 1 && ks[0].x > 0.1 && ks[0].y > 0.2, JSON.stringify({ during, from: p0, to: p1, saved: [ks[0].x, ks[0].y] }));
  check('after the drop the square is placed by its fractions again, not pixels', (await evalJs(`(()=>{const s=document.querySelector('${elvesSel} .counter');return s.style.left===''&&s.style.getPropertyValue('--x')!==''})()`)));
  check('dragging did not tap the card', !(await zone('me', 'battlefield'))[0].tapped);
  await mouse('mousePressed', p1.x, p1.y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', p1.x + 80 * i, p1.y + 80 * i);
  await mouse('mouseReleased', p1.x + 480, p1.y + 480, 0); await sleep(80);
  const far = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('${elvesSel} .counter').getBoundingClientRect();const c=document.querySelector('${elvesSel}').getBoundingClientRect();return JSON.stringify({inside:r.left>=c.left-0.5&&r.right<=c.right+0.5&&r.top>=c.top-0.5&&r.bottom<=c.bottom+0.5,corner:Math.abs(r.right-c.right)<1&&Math.abs(r.bottom-c.bottom)<1})})()`));
  check('dragged far off the card, the square stops at its corner', far.inside && far.corner, JSON.stringify(far));
  ks = await counterState();
  check('the saved place is the far corner exactly: 1, 1', ks[0].x === 1 && ks[0].y === 1, JSON.stringify(ks[0]));

  // tapped: still on the card
  await click(`${elvesSel} img`); await sleep(200);
  const onTapped = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('${elvesSel} .counter').getBoundingClientRect();const c=document.querySelector('${elvesSel}').getBoundingClientRect();return JSON.stringify({inside:r.left>=c.left-0.5&&r.right<=c.right+0.5&&r.top>=c.top-0.5&&r.bottom<=c.bottom+0.5,corner:Math.abs(r.right-c.right)<1&&Math.abs(r.bottom-c.bottom)<1,box:[Math.round(c.width),Math.round(c.height)]})})()`));
  check('on a tapped card the square is still inside the box, still at its corner', onTapped.inside && onTapped.corner && onTapped.box[0] > onTapped.box[1], JSON.stringify(onTapped));
  await shot('7-counter-tapped');
  await click(`${elvesSel} img`); await sleep(200);

  // leaving the zone clears them; undo restores them
  await menuPick(elvesSel, 'to the graveyard'); await sleep(50);
  check('sent to the graveyard, the card loses its counters', (await counterState()).length === 0 && (await squares()).length === 0);
  await click('#undo'); await sleep(50);
  check('undo brings the card and its lore counter back', (await zone('me', 'battlefield')).length === 1 && (await squares()).length === 1 && (await squares())[0].k === 'lore');
  await click(`${elvesSel} .counter button[data-ctr="-1"]`); await sleep(50);
  check('(cleared for the checks that follow)', (await squares()).length === 0);

  check('no card carries the old hover strip any more', (await evalJs(`document.querySelectorAll('.card .actions, .card button[data-act]').length`)) === 0);
  await rightClickAt(elvesSel);
  items = await menuItems();
  check('the menu of a card that has been round the zones is still built from where it is now', items === 'copy|add counter…|-|to hand|to the graveyard|to exile|to the command zone|-|remove', items);
  await key('Escape', 'Escape', 27); await sleep(50);

  // the keyboard, now that the strip that carried it is gone
  await evalJs(`document.querySelector('${elvesSel}').focus()`);
  check('a card takes the focus', (await evalJs(`document.activeElement.dataset.uid`)) === hand[1].uid);
  await key('Enter', 'Enter', 13); await sleep(80);
  const under = await menuRect(); const onCard = await cardRect(elvesSel);
  check('enter opens the card\'s menu under it, with the focus on the first item', !(await el('#menu', 'e.hidden')) && under.top >= onCard.bottom - 1 && Math.abs(under.left - onCard.left) < 1 && (await evalJs(`document.activeElement.getAttribute('role')`)) === 'menuitem', JSON.stringify({ under, onCard }));
  await key('Escape', 'Escape', 27); await sleep(50);
  await key('ContextMenu', 'ContextMenu', 93); await sleep(80);
  check('the menu key opens it as well', !(await el('#menu', 'e.hidden')) && (await menuItems()).startsWith('copy|add counter…'));
  await key('Escape', 'Escape', 27); await sleep(50);
  await key(' ', 'Space', 32); await sleep(80);
  check('space taps the permanent it is on rather than opening the menu', (await zone('me', 'battlefield'))[0].tapped && (await el('#menu', 'e.hidden')));
  await key(' ', 'Space', 32); await sleep(80);
  check('and untaps it again', !(await zone('me', 'battlefield'))[0].tapped);
  await menuPick(elvesSel, 'to the graveyard'); await sleep(50);
  await evalJs(`document.querySelector('${elvesSel}').focus()`);
  await key(' ', 'Space', 32); await sleep(80);
  check('off the battlefield, where nothing taps, space opens the menu instead', !(await el('#menu', 'e.hidden')) && (await menuItems()).startsWith('copy|add counter…'));
  await key('Escape', 'Escape', 27); await sleep(50);
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);
  check('(the card is back on the battlefield for the checks that follow)', (await zone('me', 'battlefield')).length === 1);

  // render() only puts back the cards that moved: an element re-inserted
  // into the tree starts its CSS over, zoom and arrival with it.
  await hover(elvesSel);
  const zoomed = await zoomOf(elvesSel);
  await evalJs(`(()=>{window.__put=0;window.__mo?.disconnect();window.__mo=new MutationObserver((ms)=>{for(const m of ms)for(const n of m.addedNodes)if(n.classList?.contains('card'))window.__put++});window.__mo.observe(document.querySelector('.table'),{childList:true,subtree:true})})()`);
  await click('[data-life="me"][data-by="1"]'); // a commit that moves no card; no sleep, the zoom would be part-way back
  const zoomedAfter = await zoomOf(elvesSel);
  await sleep(50);
  check('a commit that moves no card puts none of them back into the table', (await evalJs(`window.__put`)) === 0);
  check('so the card under the pointer keeps the zoom it has rather than growing again from nothing', zoomed > 1.05 && zoomedAfter === zoomed, JSON.stringify({ zoomed, zoomedAfter }));
  await unhover();
  await menuPick(elvesSel, 'to hand'); await sleep(50);
  check('and a card that does change zone is put into its new one', (await evalJs(`window.__put`)) === 1 && (await zone('me', 'hand')).length === 1);
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);
  await click('[data-life="me"][data-by="-1"]'); await sleep(50);
  await evalJs(`window.__mo.disconnect()`);

  // leaving a zone: the tear and the warp, looked at while they are running
  const graves = (await zone('me', 'graveyard')).length;
  await menuPick(elvesSel, 'to the graveyard'); // 0.62s of tearing: the checks below are mid-animation
  let gh = await ghosts();
  check('a card sent to the graveyard is torn up: a ghost of it in two halves, fixed over the table and in nobody\'s way', gh.length === 1 && gh[0].effect === 'tear' && gh[0].halves === 2 && gh[0].imgs === 2 && gh[0].fixed === 'fixed' && gh[0].events === 'none' && gh[0].hidden === 'true' && gh[0].running.join('|') === 'tear-left|tear-right', JSON.stringify(gh));
  check('the card itself is in the graveyard already, not waiting on the animation, and the pile has counted it', (await zone('me', 'graveyard')).length === graves + 1 && (await zone('me', 'battlefield')).length === 0 && (await evalJs(`document.querySelector('[data-count="me:graveyard"]').textContent`)) === String(graves + 1) && (await el(elvesSel, "e.classList.contains('arriving')")) && (await evalJs(`document.querySelector('${elvesSel}').getAnimations({subtree:true}).map(a=>a.animationName).join('|')`)) === 'card-arrive', JSON.stringify({ graves }));
  await shot('c-tear');
  await sleep(900);
  check('the ghost is gone within a second, and the card it came from has stopped arriving', (await ghosts()).length === 0 && !(await el(elvesSel, "e.classList.contains('arriving')")));
  await menuPick(elvesSel, 'to exile');
  gh = await ghosts();
  check('a card sent to exile is warped instead: one ghost, one copy of the card, no halves', gh.length === 1 && gh[0].effect === 'warp' && gh[0].halves === 0 && gh[0].imgs === 1 && gh[0].running.join('|') === 'warp', JSON.stringify(gh));
  check('and it is in exile already, counted there', (await zone('me', 'exile')).length === 1 && (await evalJs(`document.querySelector('[data-count="me:exile"]').textContent`)) === '1');
  await shot('d-warp');
  await sleep(900);
  check('that ghost goes the same way', (await ghosts()).length === 0);
  await menuPick(elvesSel, 'to hand'); await sleep(50);
  check('a card moved to the hand is neither torn nor warped', (await ghosts()).length === 0 && (await zone('me', 'hand')).length === 1);
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);
  check('nor is one moved to the battlefield', (await ghosts()).length === 0 && (await zone('me', 'battlefield')).length === 1);
  // a card that was lying on its side tears as it lay, not squashed into
  // the landscape box it leaves behind
  await click(`${elvesSel} img`); await sleep(250); // tapped, and the turn finished
  await hover(elvesSel); // the pointer stays here for the right-click, so the box below is the one the ghost is made from
  const lying = await cardRect(elvesSel);
  await menuPick(elvesSel, 'to the graveyard');
  const turned = await evalJs(`(()=>{const g=document.querySelector('.ghost');const s=getComputedStyle(g);const r=g.getBoundingClientRect();return {w:Math.round(parseFloat(s.width)),h:Math.round(parseFloat(s.height)),rotate:s.rotate,cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)}})()`);
  check('a tapped card\'s ghost keeps the card\'s own proportions, turned on its side over the box it left', turned.rotate === '90deg' && turned.h > turned.w && Math.abs(turned.w - lying.height) <= 1 && Math.abs(turned.h - lying.width) <= 1 && Math.abs(turned.cx - (lying.left + lying.width / 2)) <= 1 && Math.abs(turned.cy - (lying.top + lying.height / 2)) <= 1, JSON.stringify({ lying: { w: Math.round(lying.width), h: Math.round(lying.height) }, turned }));
  await shot('e-tear-tapped');
  await unhover();
  await sleep(900);
  check('and it is gone with the others, leaving the card untapped in the graveyard', (await ghosts()).length === 0 && !(await zone('me', 'graveyard'))[0].tapped);
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);

  // and with stillness asked for, nothing is thrown across the table at all
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await menuPick(elvesSel, 'to the graveyard');
  check('asked for reduced motion, no ghost is made at all, and the card that landed only fades up where it is', (await ghosts()).length === 0 && (await evalJs(`document.querySelector('${elvesSel}').getAnimations({subtree:true}).map(a=>a.animationName).join('|')`)) === 'card-fade');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await menuPick(elvesSel, 'to the battlefield'); await sleep(50);

  const theirGraves = (await zone('opp', 'graveyard')).length;
  await oppPlays('lightning bolt');
  check('an opponent\'s instant, cast straight into their graveyard, was never anywhere to leave and makes no ghost', (await ghosts()).length === 0 && (await zone('opp', 'graveyard')).length === theirGraves + 1, JSON.stringify({ theirGraves }));

  // the opponent's creature, after my card has been through the picker and a zone change
  const delverSel = `.card[data-uid="${theirs[0].uid}"]`;
  await menuPick(delverSel, 'add counter…'); await sleep(50);
  check('the picker opens on the opponent\'s card with its input intact and focused', (await el('#ctr-pick', "e.closest('.card')?.dataset.uid")) === theirs[0].uid && (await evalJs(`document.querySelector('#ctr-pick input')!==null`)) && (await evalJs('document.activeElement.id')) === 'ctr-kind' && (await el('#ctr-kind', 'e.value')) === '+1/+1');
  await evalJs(`document.getElementById('ctr-kind').value=''`); await type('lore'); await key('Enter', 'Enter', 13); await sleep(100);
  const oppSquares = await evalJs(`[...document.querySelectorAll('${delverSel} .counter')].map(s=>({n:s.querySelector('.n').textContent,k:s.querySelector('.k').textContent}))`);
  check('a typed kind lands on the opponent\'s creature and is logged as theirs', oppSquares.length === 1 && oppSquares[0].k === 'lore' && oppSquares[0].n === '1' && /opponent puts a lore counter on Delver/.test((await ui()).log[0]), JSON.stringify(oppSquares));
  await click(`${delverSel} .counter button[data-ctr="1"]`); await sleep(50);
  check('+ on their square works too', (await evalJs(`document.querySelector('${delverSel} .counter .n').textContent`)) === '2');
  await click(`${delverSel} .counter button[data-ctr="-1"]`); await click(`${delverSel} .counter button[data-ctr="-1"]`); await sleep(50);
  check('(their square cleared)', (await evalJs(`document.querySelectorAll('${delverSel} .counter').length`)) === 0);

  // undo, persistence, unknown card
  const before = JSON.stringify(await state());
  await click('#undo'); await sleep(50);
  check('undo brings back the counter just removed', (await evalJs(`document.querySelectorAll('${delverSel} .counter').length`)) === 1 && (await evalJs(`document.querySelector('${delverSel} .counter .k').textContent`)) === 'lore');
  await click(`${delverSel} .counter button[data-ctr="-1"]`); await sleep(50);
  check('(redone by hand; state matches)', JSON.stringify(await state()) === before);
  let cardCount = (await state()).cards.length;
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(800); u = await ui();
  check('a reload keeps the game: same cards, turn, life, log', (await state()).cards.length === cardCount && u.turn === 'turn 3 · my turn' && u.opp === '14' && (await zone('opp', 'battlefield')).length === 1 && u.log.length > 10, JSON.stringify({ turn: u.turn, cards: cardCount }));
  check('but not the undo stack', u.undo);
  await evalJs(`document.getElementById('q').focus()`);
  await type('xyzzyplugh'); await key('Enter', 'Enter', 13); await sleep(300); u = await ui();
  check('an unknown name: Scryfall\'s message in the status line, nothing added', u.error && /No cards found/.test(u.status) && (await state()).cards.length === cardCount, u.status);
  st = await stagedUi();
  check('the box keeps the text for fixing, and nothing is staged', u.q === 'xyzzyplugh' && st.hidden, JSON.stringify(st));
  await evalJs(`document.getElementById('q').value=''`);


  // commander damage: a ticker per commander, under the life total
  const tickBtn = (side, uid, n) => click(`#cmd-dmg-${side} .ticker[data-uid="${uid}"] button[data-cmd="${n}"]`);
  const tickMany = (side, uid, n, times) => evalJs(`(()=>{for(let i=0;i<${times};i++){const b=document.querySelector('#cmd-dmg-${side} .ticker[data-uid="${uid}"] button[data-cmd="${n}"]');if(!b)return 'missing';b.click()}return 'ok'})()`);
  const oppLife = () => evalJs(`Number(document.getElementById('life-opp').textContent)`);
  tk = await tickers('opp');
  const cmdUid = tk[0]?.uid;
  check('my commander is still the opponent\'s only ticker, and it is named and labelled', tk.length === 1 && tk[0].name === 'Llanowar Elves' && tk[0].n === '0' && tk[0].labels.join('|') === 'One fewer from Llanowar Elves|One more from Llanowar Elves', JSON.stringify(tk));
  const lifeWas = await oppLife();
  await tickMany('opp', cmdUid, 1, 4); await sleep(80); tk = await tickers('opp'); u = await ui();
  check('+ four times: the tally reads 4 and the same four life are gone, in one line each', tk[0].n === '4' && (await oppLife()) === lifeWas - 4 && u.log[0] === `${(await state()).turn} opponent's 1 from Llanowar Elves (4), ${lifeWas - 4} life`, JSON.stringify({ tk, life: await oppLife(), log: u.log[0] }));
  await tickBtn('opp', cmdUid, -1); await sleep(80); tk = await tickers('opp'); u = await ui();
  check('− is a correction: the tally drops to 3 and the life comes back', tk[0].n === '3' && (await oppLife()) === lifeWas - 3 && /opponent's −1 from Llanowar Elves \(3\)/.test(u.log[0]), JSON.stringify({ n: tk[0].n, life: await oppLife(), log: u.log[0] }));
  await click('#undo'); await sleep(80); tk = await tickers('opp');
  check('undo steps one tick back, tally and life together', tk[0].n === '4' && (await oppLife()) === lifeWas - 4, JSON.stringify({ n: tk[0].n, life: await oppLife() }));
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(800); tk = await tickers('opp');
  check('a reload keeps the tallies', tk.length === 1 && tk[0].n === '4' && (await oppLife()) === lifeWas - 4, JSON.stringify(tk));
  await evalJs(`document.querySelector('#cmd-dmg-opp .ticker button[data-cmd="1"]').focus()`);
  await tickBtn('opp', cmdUid, 1); await sleep(80);
  check('the ticker keeps its buttons across the commit, so the keyboard does not lose its place', (await evalJs(`document.activeElement.getAttribute('aria-label')`)) === 'One more from Llanowar Elves');
  await tickMany('opp', cmdUid, 1, 16); await sleep(120); tk = await tickers('opp'); u = await ui();
  check('at 21 the ticker turns lethal and the log says so, once', tk[0].n === '21' && tk[0].lethal && /opponent is dead to commander damage from Llanowar Elves \(21\)/.test(u.log[0]) && u.log.filter((l) => /dead to/.test(l)).length === 1, JSON.stringify({ n: tk[0].n, lethal: tk[0].lethal, log: u.log.slice(0, 2) }));
  await shot('d-commander-damage');
  await tickBtn('opp', cmdUid, 1); await sleep(80); tk = await tickers('opp'); u = await ui();
  check('and 21 to 22 does not say it again', tk[0].n === '22' && tk[0].lethal && u.log.filter((l) => /dead to/.test(l)).length === 1, JSON.stringify({ n: tk[0].n, log: u.log[0] }));
  check('my own row is still empty: no opponent has a commander yet', (await tickers('me')).length === 0);
  await stage('forest');
  await menuPick('#staged', "send to opponent's command zone"); await sleep(80);
  tk = await tickers('me');
  check('their commander gives me a ticker, while their row still shows only mine', tk.length === 1 && tk[0].name === 'Forest' && tk[0].n === '0' && (await tickers('opp')).map((t) => t.name).join('|') === 'Llanowar Elves', JSON.stringify(tk));
  await tickMany('me', (await tickers('me'))[0].uid, 1, 3); await sleep(80); u = await ui();
  const myLife = await evalJs(`Number(document.getElementById('life-me').textContent)`);
  check('my row takes my life, not theirs', (await tickers('me'))[0].n === '3' && new RegExp(`my 1 from Forest \\(3\\), ${myLife} life`).test(u.log[0]), JSON.stringify({ me: myLife, log: u.log[0] }));
  await menuPick(`.card[data-uid="${(await tickers('me'))[0].uid}"]`, 'remove'); await sleep(80);
  check('removing a commander takes its ticker with it, the life it took standing', (await tickers('me')).length === 0 && (await evalJs(`Number(document.getElementById('life-me').textContent)`)) === myLife, JSON.stringify(await tickers('me')));
  await click('#undo'); await sleep(80);
  check('undo brings the card and its ticker back', (await tickers('me')).length === 1 && (await tickers('me'))[0].n === '3');
  cardCount = (await state()).cards.length; // a commander joined the table here; what follows counts from now

  // the navbar's game menu
  await clickAt('#menu-game');
  let m = await menuUi();
  check('the game button opens a menu of new game and reset game, each with what it does', !m.hidden && m.expanded === 'true' && m.items.map((i) => i.label).join('|') === 'new game|reset game' && /opponents and life/.test(m.items[0].title) && /same opponents and life/.test(m.items[1].title) && m.roles.every((r) => r === 'menuitem'), JSON.stringify(m));
  check('the navbar has one button, game, and no card button exists', (await evalJs(`[...document.querySelectorAll('#navbar button')].map(b=>b.id).join('|')`)) === 'menu-game' && (await evalJs(`document.getElementById('menu-card') === null`)));
  const menuBox = JSON.parse(await evalJs(`(()=>{const m=document.getElementById('menu').getBoundingClientRect();const b=document.getElementById('menu-game').getBoundingClientRect();return JSON.stringify({fixed:getComputedStyle(document.getElementById('menu')).position,under:m.top>=b.bottom-1&&Math.abs(m.left-b.left)<1,inView:m.left>=8&&m.top>=8&&m.right<=innerWidth-8&&m.bottom<=innerHeight-8})})()`));
  check('the menu hangs under the button, fixed and inside the viewport', menuBox.fixed === 'fixed' && menuBox.under && menuBox.inView, JSON.stringify(menuBox));
  check('opened with the mouse, the focus waits on the menu, not on an item', m.focus === 'menu');
  await key('ArrowDown', 'ArrowDown', 40); await sleep(30);
  check('arrow down takes the first item', (await evalJs(`document.activeElement.textContent`)) === 'new game');
  await key('ArrowDown', 'ArrowDown', 40); await key('ArrowDown', 'ArrowDown', 40); await sleep(30);
  check('and wraps round the two of them', (await evalJs(`document.activeElement.textContent`)) === 'new game');
  await key('End', 'End', 35); await sleep(30);
  check('end jumps to the last', (await evalJs(`document.activeElement.textContent`)) === 'reset game');
  await key('Escape', 'Escape', 27); await sleep(50);
  check('escape closes the menu, unsays it is open, and gives the button back the focus', (await el('#menu', 'e.hidden')) && (await el('#menu-game', "e.getAttribute('aria-expanded')")) === 'false' && (await evalJs(`document.activeElement.id`)) === 'menu-game');
  await key('Enter', 'Enter', 13); await sleep(80);
  check('opened from the keyboard, the focus lands on the first item', (await evalJs(`document.activeElement.textContent`)) === 'new game' && !(await el('#menu', 'e.hidden')));
  await key('Escape', 'Escape', 27); await sleep(50);
  await clickAt('#menu-game');
  await evalJs(`document.body.click()`); await sleep(50);
  check('a click outside puts the menu away', (await el('#menu', 'e.hidden')) && (await el('#menu-game', "e.getAttribute('aria-expanded')")) === 'false');
  await clickAt('#menu-game');
  await clickAt('#menu-game');
  check('a second click on the button closes its own menu rather than reopening it', await el('#menu', 'e.hidden'));

  // new game: the dialog, cancelled, then a three-opponent commander game
  check('choosing new game from the menu puts the menu away and opens the dialog, warning that the table is cleared', (await fromGameMenu('new game')) === 'ok' && (await el('#menu', 'e.hidden')) && (await el('#new-dialog', 'e.open')) && !(await el('#new-warn', 'e.hidden')));
  await click('#new-cancel'); await sleep(50);
  check('cancel closes it and changes nothing', !(await el('#new-dialog', 'e.open')) && (await state()).cards.length === cardCount);

  // starting life is typed, with two presets that fill the field but do not submit
  await fromGameMenu('new game');
  await click('[data-life-preset="40"]');
  check('the 40 preset fills the field without submitting', (await el('#new-life', 'e.value')) === '40' && (await el('#new-dialog', 'e.open')), await el('#new-life', 'e.value'));
  await click('[data-life-preset="20"]');
  check('and the 20 preset fills it back, still without submitting', (await el('#new-life', 'e.value')) === '20' && (await el('#new-dialog', 'e.open')), await el('#new-life', 'e.value'));
  await evalJs(`document.getElementById('new-life').value = '34'`);
  await evalJs(`document.getElementById('new-form').requestSubmit()`); await sleep(200); u = await ui();
  check('a typed number starts everyone at it and logs it', (await state()).cards.length === 0 && u.me === '34' && u.opp === '34' && /new game: 1 opponent, 34 life/.test(u.log[0]), JSON.stringify({ me: u.me, opp: u.opp, log: u.log[0] }));

  await fromGameMenu('new game');
  check('the dialog reopens showing the current starting life, not always 20', (await el('#new-life', 'e.value')) === '34');
  await click('input[name="opponents"][value="3"]'); await click('[data-life-preset="40"]');
  await evalJs(`document.getElementById('new-form').requestSubmit()`); await sleep(200); u = await ui(); o = await oppUi();
  check('three opponents at 40: the table is cleared, everyone at 40, three tabs', (await state()).cards.length === 0 && u.turn === 'turn 1 · my turn' && u.me === '40' && u.opp === '40' && /3 opponents, 40 life/.test(u.log[0]) && !o.tabsHidden && o.tabs.length === 3 && o.tabs[0].selected && o.name === 'opponent 1', JSON.stringify({ turn: u.turn, me: u.me, o }));
  check('the dialog closed and the table has no card elements left', !(await el('#new-dialog', 'e.open')) && (await evalJs(`document.querySelectorAll('.card').length`)) === 0);
  await shot('3-three-opponents');

  await click('#opp-tabs button[data-opp="opp2"]'); await sleep(50); o = await oppUi();
  check('the second tab brings up opponent 2\'s board', o.name === 'opponent 2' && o.tabs[1].selected && !o.tabs[0].selected, JSON.stringify(o));
  await oppPlays('llanowar elves');
  check('shift+enter plays it for opponent 2', (await zone('opp', 'battlefield')).length === 1 && /opponent 2 plays Llanowar Elves/.test((await ui()).log[0]));
  await click('[data-life="opp"][data-by="-5"]'); await sleep(50); o = await oppUi();
  check('the life buttons act on the opponent in view; every tab shows its owner\'s life', o.life === '35' && o.tabs[1].text === 'opponent 235' && o.tabs[0].text === 'opponent 140' && /opponent 2 loses 5 life \(35\)/.test((await ui()).log[0]), JSON.stringify(o.tabs));
  await click('#opp-tabs button[data-opp="opp1"]'); await sleep(50); o = await oppUi();
  check('back on opponent 1: an empty board and 40 life; opponent 2\'s card is kept, not shown', (await zone('opp', 'battlefield')).length === 0 && o.life === '40' && (await state()).cards.length === 1, JSON.stringify(o));
  await click('#opp-tabs button[data-opp="opp2"]'); await sleep(50);
  check('and it is there again on opponent 2', (await zone('opp', 'battlefield')).length === 1);
  // the staged card's menu names whoever's tab is up, and is rebuilt when it changes
  await stage('bolt');
  await rightClickAt('#staged');
  items = await menuItems();
  check('the staged card\'s menu names the opponent in view', items === "send to my hand|opponent 2 plays|send to my command zone|send to opponent 2's command zone", items);
  await key('Escape', 'Escape', 27); await sleep(50);
  await click('#opp-tabs button[data-opp="opp3"]'); await sleep(50);
  await rightClickAt('#staged');
  items = await menuItems();
  check('and follows the tab: the same staged card now offers opponent 3', items === "send to my hand|opponent 3 plays|send to my command zone|send to opponent 3's command zone", items);
  await pickItem("send to opponent 3's command zone");
  cmd = await zone('opp', 'command');
  check('their command zone item puts it in their command zone, as their commander', cmd.length === 1 && cmd[0].name === 'Lightning Bolt' && (await el(`.card[data-uid="${cmd[0].uid}"]`, "e.classList.contains('commander')")) && (await stagedUi()).hidden && /opponent 3 puts Lightning Bolt in command zone/.test((await ui()).log[0]), JSON.stringify(cmd));
  await menuPick(`.card[data-uid="${cmd[0].uid}"]`, 'remove'); await sleep(50);
  await oppPlays('delver');
  check('opponent 3 can have a board too', (await zone('opp', 'battlefield')).length === 1 && /opponent 3 plays Delver/.test((await ui()).log[0]));
  await click(`.card[data-uid="${(await zone('opp', 'battlefield'))[0].uid}"] img`); await sleep(50);
  check('opponent 3\'s creature tapped', (await zone('opp', 'battlefield'))[0].tapped);
  await shot('4-opp3');

  // the turn goes round the table, and the view follows it
  const turns = [];
  for (let i = 0; i < 4; i++) { await click('#next'); await sleep(80); u = await ui(); o = await oppUi(); turns.push([u.turn, o.name, o.tabs.findIndex((t) => t.active)]); }
  check('next turn goes me -> 1 -> 2 -> 3 -> me, and brings each opponent\'s board up in turn', JSON.stringify(turns) === JSON.stringify([["turn 2 · opponent 1's turn", 'opponent 1', 0], ["turn 3 · opponent 2's turn", 'opponent 2', 1], ["turn 4 · opponent 3's turn", 'opponent 3', 2], ['turn 5 · my turn', 'opponent 3', -1]]), JSON.stringify(turns));
  check('opponent 3 untapped at the start of their turn', !(await zone('opp', 'battlefield'))[0].tapped);
  check('the log marks turn lines', (await evalJs(`document.querySelectorAll('#log li.turn-line').length`)) === 4);

  // reset: same table, cleared
  const beforeReset = await state();
  await fromGameMenu('reset game'); u = await ui(); o = await oppUi();
  check('reset clears the table and starts over with the same three opponents at 40', (await state()).cards.length === 0 && u.turn === 'turn 1 · my turn' && u.me === '40' && u.opp === '40' && o.tabs.length === 3 && o.tabs.every((t) => /40$/.test(t.text)) && o.tabs[0].selected && u.log.length === 1 && /game reset: 3 opponents, 40 life/.test(u.log[0]) && (await evalJs(`document.querySelectorAll('.card').length`)) === 0, JSON.stringify({ turn: u.turn, log: u.log, tabs: o.tabs.map((t) => t.text) }));
  check('the status line says undo brings it back', /undo/.test(u.status) && !u.error, u.status);
  await click('#undo'); await sleep(100); u = await ui();
  check('and undo does: the cards, the turn, and the life are back', JSON.stringify(await state()) === JSON.stringify(beforeReset) && u.turn === 'turn 5 · my turn' && (await state()).cards.length === 2, JSON.stringify({ turn: u.turn }));
  await click('#opp-tabs button[data-opp="opp3"]'); await sleep(50);
  check('the view is not part of undo: it stays on opponent 1, and opponent 3\'s card is still there when you look', (await zone('opp', 'battlefield')).length === 1);

  // a menu at the edge of a small window: it flips rather than hanging off
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 340, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  const corner = JSON.parse(await evalJs(`(()=>{const c=[...document.querySelectorAll('.card')].map(e=>e.getBoundingClientRect()).sort((a,b)=>(b.right+b.bottom)-(a.right+a.bottom))[0];return JSON.stringify({x:Math.min(Math.round(c.right)-3,innerWidth-3),y:Math.min(Math.round(c.bottom)-3,innerHeight-3)})})()`));
  await rightClick(corner.x, corner.y);
  const edge = await menuRect();
  const vp = JSON.parse(await evalJs(`JSON.stringify({w:innerWidth,h:innerHeight})`));
  check('right-clicked at the far corner of a small window, the menu flips and stays inside it', edge.left >= 8 && edge.top >= 8 && edge.right <= vp.w - 8 && edge.bottom <= vp.h - 8 && (edge.top < corner.y || edge.left < corner.x), JSON.stringify({ corner, edge, vp }));
  await shot('a-menu-at-the-edge');
  await key('Escape', 'Escape', 27); await sleep(50);
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(200);

  // a save from before there were several opponents
  const old = { turn: 3, active: 'opp', life: { me: 18, opp: 12 }, cards: [{ ...parseFixture('elves'), uid: '1', owner: 'opp', zone: 'battlefield', tapped: true }], log: [{ turn: 1, text: 'new game' }], nextUid: 2 };
  await evalJs(`localStorage.setItem('mtg-journal.game', ${JSON.stringify(JSON.stringify(old))})`);
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(800); u = await ui(); o = await oppUi();
  check('an old save opens as a one-opponent game with the same board', u.turn === "turn 3 · opponent's turn" && u.opp === '12' && u.me === '18' && o.tabsHidden && (await zone('opp', 'battlefield')).length === 1 && (await zone('opp', 'battlefield'))[0].tapped, JSON.stringify({ turn: u.turn, opp: u.opp, me: u.me }));

  // phone width: nothing overflows
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(600);
  check('no horizontal overflow at 390px', await evalJs('document.documentElement.scrollWidth <= window.innerWidth'));
  await shot('5-phone');

  const bad = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || (e.method === 'Network.responseReceived' && e.params.response.status >= 400));
  check('no JS errors or failed requests', bad.length === 0, bad.map((e) => JSON.stringify(e.params).slice(0, 200)).join('\n'));
  done(results.every(Boolean) ? 0 : 1);
} catch (e) { console.error(e); done(2); }
