'use strict';
// Guard account to read. Override with ?guard=<account id>.
const DEFAULT_GUARD = 'guard.goblin-guard-63518.testnet';
const RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const LAST_N = 20, REFRESH_MS = 15000, BATCH = 5, PAGE = 50;

const GUARD = new URLSearchParams(location.search).get('guard') || DEFAULT_GUARD;
let rpcIdx = 0;
const $ = (id) => document.getElementById(id);

async function rpc(params) {
  let lastErr;
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
  throw lastErr;
}

// view call: args to base64 JSON, result bytes to JSON (null when the contract returns None)
async function view(method, args = {}) {
  const res = await rpc({
    request_type: 'call_function', finality: 'final', account_id: GUARD, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  const text = new TextDecoder().decode(new Uint8Array(res.result));
  return JSON.parse(text);
}

function fmtUnits(raw, decimals, digits) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals), frac = s.slice(-decimals).slice(0, digits).replace(/0+$/, '');
  return frac ? int + '.' + frac : int;
}
// ponytail: a non-zero amount below the precision shows as "< 0.0001"
const near = (y) => (BigInt(y) > 0n && BigInt(y) < 10n ** 20n ? '< 0.0001' : fmtUnits(y, 24, 4)) + ' NEAR';
const eth = (w) => fmtUnits(w, 18, 8) + ' ETH';
const when = (ns) => (BigInt(ns) === 0n ? '-' : new Date(Number(BigInt(ns) / 1000000n)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
const short = (s) => (s && s.length > 20 ? s.slice(0, 10) + '…' + s.slice(-6) : s || '-');

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : e.setAttribute(k, v);
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
}
const cell = (label, ...kids) => el('td', { 'data-label': label }, ...kids);
const mono = (full, text) => el('span', { class: 'mono', title: full || '' }, text ?? short(full));

function row(c) {
  const tr = el('tr');
  const id = c.id;
  if (!c.check) { // get_check returned null: refunded or unknown
    tr.append(cell('Id', String(id)), el('td', { colspan: 9, 'data-label': 'State' }, 'No such check (refunded or removed).'));
    return tr;
  }
  const k = c.check, v = k.verdict || 'pending';
  const exit = k.exit_amount != null;
  tr.append(
    cell('Id', '#' + id),
    cell('Kind', exit ? 'exit quote' : 'buy'),
    cell('Verdict', el('span', { class: 'badge ' + v }, v)),
    cell('Target', mono(k.target)),
    cell('Agent', mono(k.agent, k.agent)),
    cell('Reasons', k.reasons || (k.verdict ? '-' : 'waiting for the sentinel')),
    cell('Human OK', k.approved ? 'yes' : k.verdict === 'warn' ? 'awaiting' : 'no'),
    cell('Signed', exit ? (k.settled ? 'yes (exit)' : 'no') : (k.signed_tx ? 'yes' : 'no')),
    cell('Evidence', k.evidence_sha256 ? mono(k.evidence_sha256) : '-'),
    cell('Model decision', decisions(k)),
  );
  return tr;
}

// sha256 of the attested model decisions anchored with the check (request_check) and its buy
function decisions(k) {
  const d = [['check', k.decision_sha256], ['buy', k.buy_decision_sha256]].filter(([, h]) => h);
  if (!d.length) return '-';
  const out = el('span');
  d.forEach(([what, h], i) => out.append(i ? el('br') : '', what + ' ', mono(h)));
  return out;
}

function emptyRow(n, text) {
  return el('tr', {}, el('td', { colspan: n, class: 'empty' }, text));
}

async function mapBatches(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
  return out;
}

async function renderBounds() {
  const [b, e] = await Promise.all([view('bounds'), view('evm_config')]);
  const dl = $('bounds');
  dl.replaceChildren();
  const add = (t, ...d) => dl.append(el('dt', {}, t), el('dd', {}, ...d));
  add('Max budget per arming', near(b.max_budget));
  add('Max arming duration', b.max_duration_s + ' s');
  add('Max armed over 7 days', near(b.max_7d));
  add('EVM address NEAR signs for', mono(e.address, e.address));
  add('Withdrawal address (owner)', mono(e.withdraw_to, e.withdraw_to));
  add('Slippage bound under quote', (e.max_slippage_bps / 100) + ' % (' + e.max_slippage_bps + ' bps)');
  add('Gas limit / max fee', e.gas_limit + ' gas / ' + fmtUnits(e.max_fee_per_gas, 9, 4) + ' gwei');
  add('Budget rate', e.yocto_per_wei + ' yoctoNEAR per wei signed');
  add('Signer (MPC contract)', mono(e.mpc, e.mpc));
}

async function renderChecks() {
  const last = Number(await view('last_check_id'));
  const ids = [];
  for (let i = last; i >= 1 && ids.length < LAST_N; i--) ids.push(i);
  const checks = await mapBatches(ids, async (id) => ({ id, check: await view('get_check', { id }) }));
  const tb = $('checks').tBodies[0];
  tb.replaceChildren(...(checks.length ? checks.map(row) : [emptyRow(10, 'No check yet.')]));
  $('count').textContent = '(last ' + checks.length + ' of ' + last + ', newest first)';
  return checks;
}

// The whole blocklist, PAGE entries per list_entries call.
async function renderBlocklist() {
  const entries = [];
  for (let page; !page || page.length === PAGE; entries.push(...page)) page = await view('list_entries', { from_index: entries.length, limit: PAGE });
  const tb = $('blocklist').tBodies[0];
  const rows = entries.map(([token, e]) => el('tr', {},
    cell('Token', mono(token)),
    cell('Reporter', mono(e.reporter, e.reporter)),
    cell('Listed at', when(e.at_ns)),
    cell('Evidence', mono(e.evidence_sha256)),
    cell('Note', e.note || '-'),
  ));
  tb.replaceChildren(...(rows.length ? rows : [emptyRow(5, 'The blocklist is empty.')]));
  $('listed').textContent = '(' + entries.length + ' token' + (entries.length === 1 ? '' : 's') + ')';
}

async function refresh() {
  try {
    await renderBounds();
    await renderChecks();
    await renderBlocklist();
    $('updated').textContent = 'Last updated ' + new Date().toLocaleTimeString() + ', refresh every ' + REFRESH_MS / 1000 + ' s.';
    $('error').hidden = true;
  } catch (e) {
    console.error(e);
    $('error').hidden = false;
    $('error').textContent = 'RPC error: ' + e.message + ' (showing the last good data, retrying).';
  }
}

if (typeof document !== 'undefined') {
  $('guard').textContent = GUARD;
  refresh();
  setInterval(refresh, REFRESH_MS);
}
