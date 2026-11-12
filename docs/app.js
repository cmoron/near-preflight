'use strict';
// Guard account to read. Override with ?guard=<account id>.
const DEFAULT_GUARD = 'guard.goblin-guard-69369.testnet';
const RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const REFRESH_MS = 30000, BATCH = 5, PAGE = 50;
// A check judged this long ago no longer changes (approval, buy and quoted exit end 120 s after the
// verdict, a stuck signing slot is released after 600 s); a refunded one is gone: neither is read again.
const FINAL_S = 900;
// ponytail: every check is read once per page load; page through them if a guard ever holds thousands.

// Short names of the demo tokens, by their key in evm/tokens.json. The addresses come from
// docs/tokens.json, which evm/fork.sh copies from evm/tokens.json; an unknown address shows as is.
const LABELS = {
  usdc: 'USDC (real Base contract)',
  usdc_copies: 'copy of USDC code, its pool drained',
  safe: 'healthy demo token',
  hold_one_block: 'honest: one-block holding rule',
  owner_reclaim: 'trap: owner takes tokens back',
  sell_blocked: 'trap: sale refused',
  sell_blocked_later: 'trap: sale refused after 5 min',
  sell_tax: 'trap: 90 % sale tax',
  sell_tax_later: 'trap: 90 % sale tax after 5 min',
  sell_tax_20: '20 % sale tax',
  sim_detector: 'trap: sells only in a simulation',
  guard_frozen: "trap: freezes the guard's address",
  late_liquidity: 'old pair, fresh liquidity',
  lp_burned: 'young pool, LP burned',
  lp_held: 'young pool, LP held by one wallet',
  farm_fresh: 'trap: copy of a drained template',
  gas_hungry: 'sale needs 500,000 gas',
  approve_max_only: 'trap: sells only after a max approve',
  buy_001_only: 'trap: sells only after a 0.01 ETH buy',
  judge_trap: 'trap: sells only after a top-level read',
  untouched_buyer: 'trap: a new buyer never sells',
  stranger_key: "trap: sale keyed on a stranger's call",
  pair_pull_tax: 'trap: tax hidden in a pool swap',
  red_l1_trap: 'trap: reads L1Block',
  helper_trap: 'trap: reads L1Block through a helper',
  basefee_trap: 'trap: keyed on the base fee',
  next_block_key: 'trap: sells only in the next block',
  amount_trap: 'trap: sells only half or all',
  weth_key: "trap: sells only while nobody else uses WETH",
  approve_key: "trap: approves only while nobody else uses WETH",
  busy_tell: 'trap: sells only while WETH is still, or after a new pair',
  cooldown_60: 'honest: 30-block cooldown after a buy (6 s on Base)',
  impl_mark: "trap: the next buy marks you in its implementation's storage",
  guard_later: "trap: closes the guard's sales 8 min after its buy",
  late_close: 'trap: closes every sale 20 min after it is armed',
  pool_clock: "trap: the same, the time read from its own pool",
};

const GUARD = new URLSearchParams(location.search).get('guard') || DEFAULT_GUARD;
const names = new Map(); // lowercase address -> label
const finals = new Map(); // check id -> a check that can no longer change (null: refunded)
let rpcIdx = 0, rpcCalls = 0;
// docs/snapshot.json (docs/snapshot.js): drawn at once, labelled, until the first full live read. `offline`: view() answers from it.
let snap = null, offline = false, liveOnce = false;
const $ = (id) => document.getElementById(id);

async function rpc(params) {
  let lastErr;
  for (let round = 0; round < 3; round++) {
    // Both endpoints failing is most often a rate limit (a 429 without CORS headers, after about 25 quick
    // calls from one address): wait 2 s, then 4 s, and retry.
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
        $('rpc').textContent = url;
        return j.result;
      } catch (e) { lastErr = new Error(url + ': ' + e.message); }
    }
  }
  throw lastErr;
}

// view call: args to base64 JSON, result bytes to JSON (null when the contract returns None)
async function view(method, args = {}) {
  if (offline) return Snapshot.view(snap, method, args);
  rpcCalls++;
  const res = await rpc({
    request_type: 'call_function', finality: 'final', account_id: GUARD, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

async function loadNames() {
  const r = await fetch('tokens.json');
  if (!r.ok) throw new Error('tokens.json: HTTP ' + r.status);
  for (const [key, v] of Object.entries(await r.json())) {
    for (const a of [].concat(v)) if (typeof a === 'string') names.set(a.toLowerCase(), LABELS[key] || key.replaceAll('_', ' '));
  }
}

function fmtUnits(raw, decimals, digits) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals), frac = s.slice(-decimals).slice(0, digits).replace(/0+$/, '');
  return frac ? int + '.' + frac : int;
}
// ponytail: a non-zero amount below the precision shows as "< 0.0001"
const near = (y) => (BigInt(y) > 0n && BigInt(y) < 10n ** 20n ? '< 0.0001' : fmtUnits(y, 24, 4)) + ' NEAR';
const eth = (w) => fmtUnits(w, 18, 8) + ' ETH';
const secs = (ns) => Number(BigInt(ns) / 1000000000n);
const when = (ns) => (BigInt(ns) === 0n ? '-' : new Date(secs(ns) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
const short = (s) => (s && s.length > 20 ? s.slice(0, 10) + '…' + s.slice(-6) : s || '-');
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : e.setAttribute(k, v);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}
const mono = (full, text) => el('code', { title: full || '' }, text ?? short(full));
const badge = (v) => el('b', { class: 'verdict ' + v }, v);
// A check as its four lamps (asked, simulated, verdict stored, signed by NEAR) in its verdict's colour, and the verdict
// word. The fourth lights only once NEAR signed: an allow never bought stays at three, a warn the owner approved reaches four.
const lamps = (v, signed) => el('span', { class: 'v ' + v + (signed ? ' signed' : '') }, el('span', { class: 'lamps', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i')), badge(v));
const REPLAY_DOC = 'https://github.com/cmoron/near-preflight/blob/main/docs/replay.md';
const acct = (a) => el('code', { class: 'acct' }, a); // account names: dots read badly in B612 Mono

// The tab icon: the four-lamp mark in the state of the newest verdict, in the browser's light or dark palette.
const LAMP = { dark: { allow: '#00EC97', warn: '#FFB547', block: '#FF6B5F', off: '#2B3D57' }, light: { allow: '#00794D', warn: '#965A00', block: '#C8352B', off: '#D2D9E3' } };
function favicon(v, signed) {
  const css = (p) => [0, 1, 2, 3].map((i) => '.l' + i + '{fill:' + (((i < 3 || signed) && p[v]) || p.off) + '}').join('');
  const cells = [[0, 6], [4, 10], [8, 6], [12, 2]].map(([x, y], i) => '<rect class="l' + i + '" x="' + x + '" y="' + y + '" width="3" height="3"/>').join('');
  $('icon').href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><style>'
    + css(LAMP.dark) + '@media (prefers-color-scheme:light){' + css(LAMP.light) + '}</style>' + cells + '</svg>');
}
// A token: its label over its shortened address in small type (inline: beside it); an unknown token: its address.
function token(addr, inline) {
  const label = names.get(String(addr).toLowerCase());
  const a = el('code', { class: 'addr', title: addr }, label ? short(addr) : addr);
  return label ? el('span', { class: inline ? '' : 'tok' }, el('span', {}, label), inline ? ' ' : null, a) : a;
}
const kindOf = (k) => (k.exit_amount != null ? 'sale' : 'buy');
const verdictOf = (k) => k.verdict || 'pending';
const signedOf = (k) => (kindOf(k) === 'sale' ? k.settled : !!k.signed_tx); // as the "Signed by NEAR" fact below
// The sentinels' votes on a check (none on a guard deployed before the quorum): an allow or a warn takes the
// quorum's identical votes (the guard takes no more once they are in), one block vote blocks; on an exit every
// sentinel quotes, and the median of three quotes stands, the highest of fewer.
const votesOf = (k) => k.votes || [];
let sentinelSet = null; // the guard's sentinels and quorum (view sentinels), read once; null on a guard without the view
const tally = (k) => {
  const v = votesOf(k), same = v.filter((x) => x.verdict === k.verdict).length;
  const quotes = v.filter((x) => x.quote != null).length;
  if (kindOf(k) === 'sale') return quotes >= 3 ? 'the median of ' + quotes + ' quotes stands' : quotes ? 'the highest of ' + plural(quotes, 'quote') + ' stands' : 'no quote';
  const of = sentinelSet ? sentinelSet.sentinels.length : v.length;
  return k.verdict === 'block' ? 'blocked by ' + same + ' of ' + v.length + (v.length === 1 ? ' vote' : ' votes') : same + ' of ' + of + (of === 1 ? ' sentinel' : ' sentinels');
};
// The guard stores at most 280 characters of reasons: a cut one ends with an ellipsis, not mid-word.
const reasonsOf = (k) => (k.reasons && k.reasons.length >= 280 ? k.reasons + '…' : k.reasons);
const firstReason = (k) => (k.verdict ? (k.reasons ? reasonsOf(k).split(' ; ')[0] : '-') : 'waiting for the sentinels' + (votesOf(k).length ? ' (' + votesOf(k).length + ' voted)' : ''));
// A block that judged nothing: a sentinel's node failed three times (app/sentinel.ts), or the simulation came
// after the buy's swap deadline (the router's EXPIRED). Said as such, its reason after it.
const FAIL_CLOSED = 'blocked because the check could not be completed — the guard fails closed';
const failClosed = (k) => k.verdict === 'block' && /^(simulation impossible after |simulated buy failed: UniswapV2Router: EXPIRED)/.test(k.reasons || '');

async function mapBatches(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
  return out;
}

function facts(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([t, ...d]) => [el('dt', {}, t), el('dd', {}, ...d)]));
}

// One check, collapsed to id, token, verdict and first reason; the rest when opened.
function checkItem({ id, check: k }, open) {
  if (!k) return el('li', { class: 'gone' }, el('div', { class: 'row' }, el('span', { class: 'id' }, '#' + id), el('span', {}, 'Refunded: the check was removed.')));
  const sale = kindOf(k) === 'sale';
  const extra = k.reasons ? k.reasons.split(' ; ').length - 1 : 0;
  const decisions = [['at the check', k.decision_sha256], ['at the buy', k.buy_decision_sha256]].filter(([, h]) => h);
  const body = el('dl', { class: 'facts' });
  facts(body, [
    ['Token', el('code', {}, k.target)],
    ['Agent', k.agent],
    ['Asked', sale ? 'a sale of ' + k.exit_amount + ' token units (exit quote)' : 'a buy of ' + eth(k.amount_wei)],
    ['Requested', when(k.requested_ns)],
    ['Judged', k.verdict ? when(k.judged_ns) + ' (' + (secs(k.judged_ns) - secs(k.requested_ns)) + ' s later)' : 'not yet'],
    ['Votes', votesOf(k).length ? el('span', { class: 'stack' }, ...(k.verdict ? [tally(k) + ':'] : []), ...votesOf(k).map((v) => el('span', { class: 'vote' }, badge(v.verdict), ' ', acct(v.sentinel), el('small', {}, v.quote != null ? ' quotes ' + eth(v.quote) + ',' : '', ' evidence ', mono(v.evidence_sha256))))) : 'none yet'],
    ['Reasons', ...(failClosed(k) ? [FAIL_CLOSED + ': '] : []), reasonsOf(k) || '-'],
    ['Quote', sale ? eth(k.quote) + ' for the sale' : k.quote + ' token units for the buy'],
    k.verdict === 'warn' && ['Owner approval', k.approved ? 'approved' : 'not approved'],
    k.verdict === 'block' && ['Asked to list the token', k.list_target ? 'yes' : 'no'],
    ['Evidence sha256', k.evidence_sha256 ? mono(k.evidence_sha256, k.evidence_sha256) : '-'],
    ['Transactions it may sign', k.tx_hashes.length ? el('span', { class: 'stack' }, ...k.tx_hashes.map((h) => mono('0x' + h, '0x' + h))) : 'none'],
    ['Model decision sha256', decisions.length ? el('span', { class: 'stack' }, ...decisions.map(([w, h]) => el('span', {}, w + ': ', mono(h, h)))) : 'none attached'],
    ['Signed by NEAR', sale ? (k.settled ? 'yes, or reserved after a signature that did not come back' : 'no')
      : k.signed_tx ? el('span', { class: 'stack' }, 'yes, ' + atob(k.signed_tx).length + ' bytes (base64):', el('code', { class: 'blob' }, k.signed_tx)) : 'no'],
    k.verdict && ['How to verify', 'replay the proof file with ', el('code', {}, 'app/replay.ts --check'),
      ...(decisions.length ? [', the model decision with ', el('code', {}, 'app/attest.ts')] : []), ': ', el('a', { href: REPLAY_DOC }, 'docs/replay.md')],
  ].filter(Boolean));
  const summary = el('summary', { class: 'row' },
    el('span', { class: 'id' }, '#' + id),
    el('span', { class: 'kind' }, token(k.target), sale ? el('small', {}, ' sale') : null),
    lamps(verdictOf(k), signedOf(k)),
    el('span', { class: 'why' }, ...(failClosed(k) ? [FAIL_CLOSED, el('small', {}, ' (' + firstReason(k) + ')')] : [firstReason(k)]), extra ? el('small', {}, ' (+' + extra + ' more)') : null));
  const d = el('details', { 'data-id': String(id) }, summary, body);
  d.open = open.has(String(id));
  return el('li', {}, d);
}

// The latest purchase NEAR signed, told as the four steps.
function renderSteps(checks) {
  const c = checks.find((x) => x.check && x.check.signed_tx);
  if (!c) { $('steps-of').textContent = '(no purchase signed yet)'; $('steps').classList.remove('lit'); return; }
  const k = c.check;
  $('steps-of').textContent = '(check #' + c.id + ', the latest purchase signed)';
  const step = (title, ...text) => el('li', {}, el('b', {}, title), ' ', ...text);
  $('steps').replaceChildren(
    step('The agent asks.', acct(k.agent), ' asked to buy ', eth(k.amount_wei), ' of ', token(k.target, true), ' at ', when(k.requested_ns), '.'),
    step('The sentinels simulate.', 'The buy NEAR would sign, then two sales of what it bought, were simulated by each sentinel on its Base node. ',
      secs(k.judged_ns) - secs(k.requested_ns) + ' s after the request, ' + (votesOf(k).length ? tally(k) : 'the sentinel') + ' answered ', badge(k.verdict), ': ', el('q', {}, firstReason(k)), '.'),
    step('The verdict is stored on NEAR.', 'With the sha256 of its evidence, ', mono(k.evidence_sha256), ', a quote of ', k.quote,
      ' token units, and the hash of the only transaction the guard may sign for it, ', mono('0x' + k.tx_hashes[0]), '.'),
    step('NEAR signs.', 'The guard built the swap (router, path, recipient = its own address, floor = quote minus slippage) and NEAR Chain Signatures signed it: ',
      atob(k.signed_tx).length + ' bytes, ready to broadcast by a relay, a program that holds no key.'),
  );
  // The four lamps light in order the first time (two frames, so the new steps are painted unlit first), in the
  // verdict's colour: a warn the owner approved is signed too.
  $('steps').dataset.v = k.verdict;
  if (!$('steps').classList.contains('lit')) requestAnimationFrame(() => requestAnimationFrame(() => $('steps').classList.add('lit')));
}

function renderSummary(checks, last, listed) {
  const n = { block: 0, warn: 0, allow: 0, pending: 0, gone: 0, signed: 0 };
  for (const { check: k } of checks) {
    if (!k) n.gone++;
    else {
      n[verdictOf(k)]++;
      if (k.signed_tx) n.signed++;
    }
  }
  const num = (v, cls) => el('strong', { class: cls }, String(v));
  $('summary').replaceChildren(
    num(last), ' ', last === 1 ? 'request' : 'requests', ': ',
    num(n.block, 'block'), ' blocked, ', num(n.warn, 'warn'), ' warned, ', num(n.allow, 'allow'), ' allowed',
    ...(n.pending ? [', ', num(n.pending, 'pending'), ' waiting for a verdict'] : []), ...(n.gone ? [', ', num(n.gone), ' refunded'] : []),
    '. ', num(n.signed), ' ', n.signed === 1 ? 'purchase' : 'purchases', ' signed by NEAR. ',
    num(listed), ' ', listed === 1 ? 'token' : 'tokens', ' on the shared blocklist.',
  );
  const total = n.block + n.warn + n.allow + n.pending || 1;
  $('bar').replaceChildren(...['block', 'warn', 'allow', 'pending'].filter((v) => n[v]).map((v) => el('span', { class: v, style: 'flex-grow:' + n[v] / total })));
}

async function renderChecks() {
  const last = Number(await view('last_check_id'));
  const ids = Array.from({ length: last }, (_, i) => last - i);
  const checks = await mapBatches(ids, async (id) => {
    if (finals.has(id)) return { id, check: finals.get(id) };
    const k = await view('get_check', { id });
    if (!offline && (!k || (k.verdict && Date.now() / 1000 - secs(k.judged_ns) > FINAL_S))) finals.set(id, k); // kept even if this refresh fails later
    return { id, check: k };
  });
  const open = new Set([...document.querySelectorAll('#checks details[open]')].map((d) => d.dataset.id));
  $('checks').replaceChildren(...(checks.length ? checks.map((c) => checkItem(c, open)) : [el('li', { class: 'empty' }, 'No check yet.')]));
  $('count').textContent = '(' + plural(last, 'request') + ')';
  return { checks, last };
}

// The whole blocklist, PAGE entries per list_entries call.
async function renderBlocklist() {
  const entries = [];
  for (let page; !page || page.length === PAGE; entries.push(...page)) page = await view('list_entries', { from_index: entries.length, limit: PAGE });
  const rows = entries.map(([t, e]) => el('tr', {},
    el('td', {}, token(t)), el('td', {}, acct(e.reporter)), el('td', {}, when(e.at_ns)),
    el('td', { title: 'evidence sha256 ' + e.evidence_sha256 }, e.note || '-')));
  $('blocklist').tBodies[0].replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 4, class: 'empty' }, 'The blocklist is empty.'))]));
  $('listed').textContent = '(' + plural(entries.length, 'token') + ')';
  return entries.length;
}

// Each agent seen in the checks: frozen by the owner's stop or not, and its last stop; then the
// signing slot and what the guard holds for others.
async function renderState(checks) {
  const agents = [...new Set(checks.filter((c) => c.check).map((c) => c.check.agent))].sort();
  const per = await mapBatches(agents, async (a) => [a, await view('is_frozen', { account: a }), await view('stopped_at', { account: a })]);
  const [since, escrow, credits] = await Promise.all([view('signing_since'), view('escrow'), view('credits_total')]);
  facts($('state'), [
    ...per.map(([a, frozen, stop]) => [acct(a), frozen ? el('strong', { class: 'block' }, 'frozen by the owner') : 'not frozen',
      stop ? ', last stopped ' + when(stop) : ', never stopped']),
    ['Signature in progress', since ? 'requested ' + when(since) : 'none'],
    ['Held in escrow', near(escrow) + ': prices of checks awaiting a verdict, charges of a signature in progress or reserved'],
    ['Prepaid credit of all accounts', near(credits)],
  ]);
}

async function renderBounds() {
  // A guard deployed before the quorum has neither view: its two lines say so, the rest still shows.
  const opt = (m) => view(m).catch((err) => { console.warn(m + ' not read:', err); return null; });
  const span = (s) => (s % 3600 ? s / 60 + ' min' : s / 3600 + ' h');
  const [b, e, s, t] = await Promise.all([view('bounds'), view('evm_config'), opt('sentinels'), opt('token_limits')]);
  facts($('bounds'), [
    ['Max budget per arming', near(b.max_budget)],
    ['Max arming duration', b.max_duration_s + ' s'],
    ['Max armed over 7 days', near(b.max_7d)],
    ['Max per buy', eth(b.max_buy_wei)],
    ['Sentinels', s ? el('span', { class: 'stack' }, ...s.sentinels.map(acct), s.quorum + ' of ' + s.sentinels.length + ' matching votes for an allow or a warn; one block vote blocks; an exit sells on the median of their quotes') : 'not read on this guard'],
    ['Per token, all agents', t ? 'a block closes the token for ' + span(t.quarantine_s) + '; at most ' + eth(t.cap_wei) + ' bought per ' + span(t.cap_period_s) : 'not read on this guard'],
    ['EVM address NEAR signs for', mono(e.address, e.address)],
    ['Withdrawal address (owner)', mono(e.withdraw_to, e.withdraw_to)],
    ['Floor under the quote', (e.max_slippage_bps / 100) + ' % (' + e.max_slippage_bps + ' bps)'],
    ['Gas limit, max fee', e.gas_limit + ' gas, ' + fmtUnits(e.max_fee_per_gas, 9, 4) + ' gwei'],
    ['Budget rate', e.yocto_per_wei + ' yoctoNEAR per wei signed'],
    ['Signer (MPC contract)', acct(e.mpc)],
  ]);
  if (!offline) $('bounds').dataset.read = 'yes'; // a snapshot's bounds are read live once
}

async function refresh() {
  try {
    sentinelSet ||= await view('sentinels').catch((err) => { console.warn('sentinels not read:', err); return null; });
    const { checks, last } = await renderChecks();
    const listed = await renderBlocklist();
    renderSummary(checks, last, listed);
    renderSteps(checks);
    const judged = checks.find((c) => c.check && c.check.verdict);
    if (judged) favicon(judged.check.verdict, signedOf(judged.check)); // none yet: the static mark stays
    await renderState(checks);
    if (!$('bounds').dataset.read) await renderBounds(); // owner settings, read once per page load
    $('updated').textContent = (offline ? 'Snapshot of ' + Snapshot.utc(snap) + ', refreshing from NEAR…'
      : 'Live, read from NEAR testnet just now (' + new Date().toLocaleTimeString() + ', refreshed every ' + REFRESH_MS / 1000 + ' s).')
      + (names.size ? '' : ' Token names unavailable: addresses shown as is.');
    $('error').hidden = true;
    if (!offline && !liveOnce) console.info('RPC calls to first live read:', rpcCalls);
    liveOnce ||= !offline;
    return true;
  } catch (e) {
    if (offline) { console.warn('snapshot not drawn:', e); return false; }
    console.error(e);
    $('error').hidden = false;
    if (!liveOnce) $('updated').textContent = ''; // the error line says it
    $('error').textContent = liveOnce ? 'RPC error: ' + e.message + ' (showing the last good data, retrying).'
      : !snap ? 'NEAR testnet could not be read: ' + e.message + ' (retrying).'
      : 'NEAR RPC is rate-limiting this browser: showing the snapshot of ' + Snapshot.utc(snap) + ' (retrying in the background).';
    return false;
  }
}

async function loadSnapshot() {
  try {
    const r = await fetch('snapshot.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    snap = Snapshot.usable(await r.json(), GUARD);
  } catch (e) { console.warn('no snapshot, reading NEAR directly:', e); }
}

if (typeof document !== 'undefined') {
  $('guard').textContent = GUARD;
  loadNames().catch((e) => console.error('token names:', e)).finally(async () => {
    await loadSnapshot();
    if (snap) {
      offline = true;
      await refresh();
      offline = false;
      for (const [id, k] of Snapshot.finals(snap)) finals.set(id, k); // only what was final when it was taken
    }
    // Every 30 s; after a failure, backed off (60 s, 120 s, 240 s) so a rate limit is not hammered.
    for (let fails = 0; ; ) {
      fails = (await refresh()) ? 0 : fails + 1;
      await new Promise((r) => setTimeout(r, Math.min(REFRESH_MS * 2 ** Math.max(0, fails - 1), 240000)));
    }
  });
}
