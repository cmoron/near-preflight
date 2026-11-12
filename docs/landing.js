'use strict';
// The landing page: live figures and "Run a check", read from the demo guard's view methods on NEAR testnet.
// RPC endpoints, retry and view() follow app.js (the journal); duplicated because app.js drives the journal's DOM.
const RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const BATCH = 5;
// A check judged this long ago no longer changes (app.js: FINAL_S): it is cached in this browser and not read again.
const FINAL_S = 900;
const STEP_MS = [250, 1150, 2150, 3050, 3650]; // when lamps 1 to 4 light, then the verdict plate

// The tokens offered: a key of tokens.json, its label, and which check to replay. USDC replays the latest
// purchase NEAR signed (the allow path); the others their latest check. A token with no check is not offered.
const CHOICES = [
  { key: 'usdc', label: 'USDC (real Base contract)', signed: true },
  { key: 'sell_blocked', label: 'trap: sale refused' },
  { key: 'farm_fresh', label: 'trap: copy of a drained template' },
  { key: 'weth_key', label: 'trap: sells only while Base stands still' },
  { key: 'sell_tax_20', label: '20 % sale tax' },
  { key: 'guard_frozen', label: "trap: freezes the guard's address" },
];

const $ = (id) => document.getElementById(id);
// ?guard= ends up in a shell command the visitor copies: only a NEAR account id is accepted.
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const asked = new URLSearchParams(location.search).get('guard');
const query = asked && ACCOUNT_ID.test(asked) ? asked : null;
let rpcIdx = 0;

// The guard to read: ?guard=, else DEFAULT_GUARD read from app.js, its one source; a copy here would go
// stale silently at the next deploy, while a failed read shows on the page.
async function guardId() {
  if (query) return query;
  const r = await fetch('app.js');
  if (!r.ok) throw new Error('app.js: HTTP ' + r.status);
  const m = (await r.text()).match(/DEFAULT_GUARD\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('no DEFAULT_GUARD in app.js');
  return m[1];
}

async function rpc(params) {
  let lastErr;
  for (let round = 0; round < 3; round++) {
    // Both endpoints failing is most often a rate limit: wait 2 s, then 4 s, and retry (as app.js).
    if (round) await new Promise((r) => setTimeout(r, 2000 * round));
    for (let i = 0; i < RPCS.length; i++) {
      const url = RPCS[(rpcIdx + i) % RPCS.length];
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.error) throw new Error(j.error.data || j.error.message || JSON.stringify(j.error));
        if (j.result.error) throw new Error(j.result.error);
        rpcIdx = (rpcIdx + i) % RPCS.length;
        return j.result;
      } catch (e) { lastErr = new Error(url + ': ' + e.message); }
    }
  }
  throw lastErr;
}

async function view(guard, method, args = {}) {
  const res = await rpc({
    request_type: 'call_function', finality: 'final', account_id: guard, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

// Final checks per guard, in localStorage: a second load reads only last_check_id and the checks still open.
// ponytail: every check is read once per browser; page through them if a guard ever holds thousands.
function loadCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); }
  catch (e) { console.warn('check cache unavailable, reading every check:', e); return {}; }
}
function saveCache(key, cache) {
  try { localStorage.setItem(key, JSON.stringify(cache)); }
  catch (e) { console.warn('check cache not saved:', e); }
}

// Every check, newest first: the live counts need them all, the picker the latest of each token.
async function readChecks(guard) {
  const last = Number(await view(guard, 'last_check_id'));
  const key = 'near-preflight:checks:' + guard;
  const cache = loadCache(key);
  const ids = Array.from({ length: last }, (_, i) => last - i);
  const checks = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    checks.push(...await Promise.all(ids.slice(i, i + BATCH).map(async (id) => {
      if (id in cache) return { id, check: cache[id] };
      const k = await view(guard, 'get_check', { id });
      if (!k || (k.verdict && Date.now() / 1000 - secs(k.judged_ns) > FINAL_S)) cache[id] = k; // null: refunded
      return { id, check: k };
    })));
  }
  saveCache(key, cache);
  return { last, checks };
}

async function loadTokens() {
  const r = await fetch('tokens.json');
  if (!r.ok) throw new Error('tokens.json: HTTP ' + r.status);
  return r.json();
}

// Formatting, as app.js.
function fmtUnits(raw, decimals, digits) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals), frac = s.slice(-decimals).slice(0, digits).replace(/0+$/, '');
  return frac ? int + '.' + frac : int;
}
const eth = (w) => fmtUnits(w, 18, 8) + ' ETH';
const secs = (ns) => Number(BigInt(ns) / 1000000000n);
const iso = (ns) => new Date(secs(ns) * 1000).toISOString();
const when = (ns) => iso(ns).slice(0, 10) + ' at ' + iso(ns).slice(11, 19) + ' UTC';
const short = (s) => (s && s.length > 20 ? s.slice(0, 6) + '…' + s.slice(-4) : s || '-');
const units = (n) => BigInt(n).toLocaleString('en-US');

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : e.setAttribute(k, v);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}
const mono = (full, text) => el('code', { title: full }, text ?? short(full));
const lamps = () => el('span', { class: 'lamps', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'));
const journalLink = (hash) => {
  const u = new URL('journal.html', location.href);
  if (query) u.searchParams.set('guard', query);
  u.hash = hash || '';
  return u.pathname.split('/').pop() + u.search + u.hash;
};

function renderLive(guard, last, checks) {
  let blocked = 0, signed = 0;
  for (const { check: k } of checks) {
    if (k && k.verdict === 'block') blocked++;
    if (k && k.signed_tx) signed++;
  }
  const n = (v) => el('strong', {}, String(v));
  $('live').replaceChildren(
    n(last), last === 1 ? ' check' : ' checks', ' requested so far, ', n(blocked), ' blocked, ', n(signed), signed === 1 ? ' purchase' : ' purchases',
    ' signed by NEAR.', el('small', {}, 'Read from NEAR testnet by this page just now, on the demo guard ', el('code', { class: 'acct' }, guard), '.'));
}

// What each lamp's line says, from the check's own fields.
function lines(c, choice, addr) {
  const k = c.check;
  const reasons = k.reasons ? k.reasons.split(' ; ') : [];
  const bytes = k.signed_tx ? atob(k.signed_tx).length : 0;
  const w1 = [el('code', { class: 'acct' }, k.agent), ' asked to buy ', el('strong', {}, eth(k.amount_wei)), ' of token ', mono(addr),
    ', and paid for the check.'];
  const w2 = ['The sentinel simulated the buy NEAR would sign, then two sales of what it bought, and answered ',
    secs(k.judged_ns) - secs(k.requested_ns) + ' s after the request. The buy quotes ' + units(k.quote) + ' token units.'];
  const w3 = [el('b', { class: 'verdict ' + k.verdict }, k.verdict), ', the sentinel\'s reasons:',
    el('ul', { class: 'reasons' }, ...reasons.map((r) => el('li', {}, el('q', {}, r)))),
    el('small', {}, 'Stored with the sha256 of its evidence, ', mono(k.evidence_sha256), ', and the hash of the one transaction NEAR may sign, ',
      mono('0x' + k.tx_hashes[0]), '.')];
  let w4, means;
  if (k.signed_tx) {
    w4 = (k.verdict === 'warn' ? 'The owner approved the warn. ' : '') + 'NEAR Chain Signatures signed the swap the guard built from the simulation: '
      + bytes + ' bytes, for a relay with no key to broadcast.';
    means = k.verdict === 'warn' ? 'The owner decided: approved, and NEAR signed.' : 'The agent may buy, and NEAR signed its swap.';
  } else if (k.verdict === 'block') {
    w4 = 'NEAR signed nothing: the guard refuses a buy on a block.' + (k.list_target ? ' The token went on the shared blocklist, refused to every agent.' : '');
    means = 'Refused. NEAR signs nothing.' + (k.list_target ? ' Listed for every agent.' : '');
  } else if (k.verdict === 'warn') {
    w4 = 'NEAR signed nothing: a warn waits for the owner\'s approval, and it was not given.';
    means = 'The owner decides: not approved, so NEAR signed nothing.';
  } else {
    w4 = 'NEAR signed nothing for this check: no buy followed the allow.';
    means = 'The agent could buy within 120 s; no signed purchase followed.';
  }
  const caption = [el('strong', {}, choice.label), ': a replay of check #' + c.id + ', recorded on NEAR testnet on ' + when(k.requested_ns) + ', '
    + (choice.signed ? 'the latest purchase of this token NEAR signed. ' : 'the latest check of this token. '),
  el('a', { href: journalLink('check-' + c.id) }, 'Open it in the journal')];
  return { caption, w: [w1, w2, w3, [w4]], means };
}

let timers = [];
function setStep(n) {
  const board = $('board');
  board.querySelectorAll('.seq>li').forEach((li, i) => li.classList.toggle('on', i < n));
  board.classList.toggle('judged', n >= 3);
  board.classList.toggle('done', n >= 5);
}

function play(entry) {
  timers.forEach(clearTimeout);
  timers = [];
  const k = entry.c.check;
  const { caption, w, means } = lines(entry.c, entry.choice, entry.addr);
  const board = $('board');
  setStep(0);
  board.dataset.v = k.verdict;
  board.dataset.signed = k.signed_tx ? 'yes' : 'no';
  $('caption').replaceChildren(...caption);
  w.forEach((parts, i) => $('w' + (i + 1)).replaceChildren(...parts));
  const plate = el('span', { class: 'v ' + k.verdict + (k.signed_tx ? ' signed' : '') }, lamps());
  $('plate').replaceChildren(plate, el('span', { class: 'word' }, k.verdict), el('span', { class: 'means' }, means));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setStep(5);
  timers = STEP_MS.map((ms, i) => setTimeout(() => setStep(i + 1), ms));
}

function renderPicker(tokens, checks) {
  const entries = CHOICES.flatMap((choice) => {
    const addrs = [].concat(tokens[choice.key] || []).map((a) => String(a).toLowerCase());
    const c = checks.find(({ check: k }) => k && k.verdict && k.exit_amount == null && addrs.includes(k.target.toLowerCase())
      && (!choice.signed || (k.verdict === 'allow' && k.signed_tx)));
    return c ? [{ choice, c, addr: c.check.target }] : [];
  });
  if (!entries.length) {
    $('choices').replaceChildren(el('p', { class: 'empty' }, 'No check of these tokens on this guard yet.'));
    return;
  }
  let current = entries[0];
  $('choices').replaceChildren(...entries.map((e, i) => {
    const input = el('input', { type: 'radio', name: 'token', value: e.choice.key });
    input.checked = i === 0;
    input.addEventListener('change', () => { current = e; play(e); $('board').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    return el('label', { class: 'choice' }, input, el('span', { class: 'name' }, e.choice.label), el('span', { class: 'id' }, 'check #' + e.c.id));
  }));
  $('replay').addEventListener('click', () => play(current));
  $('picker').disabled = false;
  // The one orchestrated moment: the first token plays once, when the board comes into view.
  new IntersectionObserver((seen, obs) => {
    if (!seen.some((s) => s.isIntersecting)) return;
    obs.disconnect();
    play(current);
  }, { threshold: 0.35 }).observe($('board'));
}

function renderDown(err) {
  const msg = err.message.length > 160 ? err.message.slice(0, 160) + '…' : err.message;
  $('live').replaceChildren('Live figures unavailable: the demo guard could not be read from NEAR testnet. ',
    el('a', { href: journalLink() }, 'The journal'), ' retries on its own.');
  $('choices').replaceChildren(el('p', { class: 'empty' }, 'Nothing to replay.'));
  $('caption').replaceChildren('The checks could not be read from NEAR testnet, so there is nothing to replay. The ',
    el('a', { href: journalLink() }, 'journal'), ' shows the same checks and retries on its own.',
    el('span', { class: 'err' }, msg));
}

// Copy the verify commands; with no clipboard API (plain http, permission denied), select them for Ctrl+C.
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('cmds').textContent);
    $('copied').textContent = 'Copied.';
  } catch (e) {
    console.warn('clipboard unavailable, selecting the commands instead:', e);
    getSelection().selectAllChildren($('cmds'));
    $('copied').textContent = 'Selected: press Ctrl+C to copy.';
  }
});

(async () => {
  if (query) document.querySelectorAll('a[href="journal.html"]').forEach((a) => (a.href = journalLink()));
  try {
    const guard = await guardId();
    $('cmd-guard').textContent = guard;
    const [tokens, { last, checks }] = await Promise.all([loadTokens(), readChecks(guard)]);
    renderLive(guard, last, checks);
    renderPicker(tokens, checks);
  } catch (e) {
    console.error(e);
    renderDown(e);
  }
})();
