// "Or check your own token": the core of the sentinel's simulation, run in the visitor's browser against a
// public Base node, read only; nothing is signed or sent. A fresh address funded by state override buys
// 0.0001 ETH of the token through Uniswap V2, sells a share of it a few blocks later and the rest 255 blocks
// after the buy (the last block eth_simulateV1 reaches), and owner() tries transferFrom without approval.
//
// Mirrors app/verifier.ts, by hand: plan (its probe side: the buy, each sale's approve in the block before
// its swap, every block up to the late sale listed), buildRequest (block number and time at the cadence of
// cadenceAt and timeOf, the real block's base fee and coinbase, the demo guard's gas limit and fees on every
// call, traceTransfers), balances and topUp, buyStage and sideFindings (tokens bought from Transfer logs
// against the pool's quote; a sale's ETH from the ETH transfer logs against the quote at the pool's last
// Sync; the pool paying out more WETH than the seller receives; owner()'s takeback), quoteAt, revertReason,
// and the 10 % / 50 % tax thresholds.
// Leaves out: the guard side (the guard's own address and the bytes NEAR signs), probes and sales derived
// from the NEAR ticket (here a random address and share, fixed delays), the takeback by a stranger, the
// later side (the sales again on a later real Base block), the trace of what the token reads (environment
// rule), LP holders, the code template's reputation, the NEAR blocklist, one prevrandao per L1 epoch, the
// first block of a second as reference, and the verdict stored on NEAR.

// Primary and fallback: both answer eth_simulateV1 to a browser (CORS), measured 2026-11-12.
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/; // ?rpc= is taken for a local fork only
const ROUTER = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24'; // Uniswap V2 Router02 (Base)
const FACTORY = '0x8909dc15e40173ff4699343b6eb8132c65e18ec6';
const WETH = '0x4200000000000000000000000000000000000006';
const AMOUNT = 10n ** 14n; // 0.0001 ETH, the most the demo guard lets an agent buy (app/setup.ts)
const FEES = { gas: '0x3d090', maxFeePerGas: '0x2faf080', maxPriorityFeePerGas: '0xf4240' }; // the demo guard's: 250,000, 0.05 gwei, 0.001 gwei
const FUND = 10n ** 18n;
const LATE = 255; // the late sale's swap lands in the 256th block above the real one, eth_simulateV1's limit
const CADENCE_BLOCKS = 100;
const FIRST_S = 2;
const BEHIND = 10n; // simulate on a block 2 s old: every node behind a load balancer has it
const TAX_WARN = 0.1, TAX_BLOCK = 0.5;
const TIMEOUT_MS = 15_000;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SYNC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const ETH_LOGS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // traceTransfers logs each ETH transfer from here
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ABI encoding of the few calls made: static words, and the [from, to] path at the end of the swaps.
const word = (x) => (typeof x === 'bigint' ? x.toString(16) : x.slice(2).toLowerCase()).padStart(64, '0');
const fn = (selector, ...args) => selector + args.map(word).join('');
const path = (a, b) => word(2n) + word(a) + word(b);
export const abi = {
  getPair: (a, b) => fn('0xe6a43905', a, b),
  getReserves: () => '0x0902f1ac',
  owner: () => '0x8da5cb5b',
  decimals: () => '0x313ce567',
  symbol: () => '0x95d89b41',
  approve: (spender, n) => fn('0x095ea7b3', spender, n),
  transferFrom: (from, to, n) => fn('0x23b872dd', from, to, n),
  // swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, token], to, deadline): the path at offset 0x80
  buy: (token, to, deadline) => fn('0xb6f9de95', 0n, 0x80n, to, deadline) + path(WETH, token),
  // swapExactTokensForETHSupportingFeeOnTransferTokens(n, 0, [token, WETH], to, deadline): the path at 0xa0
  sell: (token, n, to, deadline) => fn('0x791ac947', n, 0n, 0xa0n, to, deadline) + path(token, WETH),
};

// An ABI string (or a bytes32, as older tokens return), printable characters only, at most `max`.
function text(h, max) {
  if (!h || h.length < 66) return null;
  const raw = h.length === 66 ? h.slice(2) : h.slice(130, 130 + 2 * Math.min(max * 4, Number(BigInt('0x' + h.slice(66, 130)))));
  const bytes = Uint8Array.from(raw.match(/../g) ?? [], (x) => parseInt(x, 16));
  return new TextDecoder().decode(bytes).replace(/[^\p{L}\p{N}\p{P}\p{S} ]/gu, '').trim().slice(0, max) || null;
}
/** A revert's reason, as verifier.ts revertReason: Error(string), else the data's first bytes. */
export function reason(r) {
  const data = r.error?.data ?? r.returnData ?? '0x';
  if (data.startsWith('0x08c379a0')) return text('0x' + data.slice(10), 120) ?? 'revert without reason';
  if (data.startsWith('0x4e487b71')) return 'panic 0x' + BigInt('0x' + data.slice(10, 74)).toString(16);
  return data === '0x' ? 'revert without reason' : data.slice(0, 18);
}

class NodeError extends Error {} // the node answered with an error: asking the other one changes nothing
let urls = RPCS;
const host = (u) => new URL(u).host;
const hex = (n) => '0x' + BigInt(n).toString(16);

// One JSON-RPC call: the primary node, then once the fallback if the first is unreachable, slow or rate-limited.
async function rpc(method, params) {
  const failed = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(r.status === 429 ? 'rate-limited (HTTP 429)' : 'HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new NodeError(host(url) + ': ' + (j.error.message || JSON.stringify(j.error)));
      if (url !== urls[0]) urls = [url, ...urls.filter((u) => u !== url)]; // keep asking the one that answers
      return j.result;
    } catch (e) {
      if (e instanceof NodeError) throw e;
      failed.push(host(url) + ': ' + (e.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000} s` : e.message));
    }
  }
  throw new Error(failed.join('; '));
}
// eth_call, null when the function reverts or is missing (owner(), decimals(), symbol() are optional).
async function read(to, data, at) {
  try { return await rpc('eth_call', [{ to, data }, at]); }
  catch (e) { if (e instanceof NodeError && /revert/i.test(e.message)) return null; throw e; }
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const topicIs = (t, a) => !!t && same('0x' + t.slice(26), a);
const ok = (r) => r?.status === '0x1';
// What `who` received (`to`) or sent (`from`) of `asset` in the Transfer logs of `results` (verifier.ts moves).
function moves(results, asset, who, side) {
  return results.flatMap((r) => r?.logs ?? []).filter((l) => same(l.address, asset) && l.topics[0] === TRANSFER && l.topics.length === 3
    && topicIs(l.topics[side === 'from' ? 1 : 2], who)).reduce((n, l) => n + (l.data.length === 66 ? BigInt(l.data) : 0n), 0n);
}
function lastSync(results, pair) {
  const s = results.flatMap((r) => r?.logs ?? []).filter((l) => same(l.address, pair) && l.topics[0] === SYNC && l.data.length === 130).at(-1);
  return s ? [BigInt('0x' + s.data.slice(2, 66)), BigInt('0x' + s.data.slice(66))] : null;
}
const out = (x, rIn, rOut) => (rIn + x === 0n ? 0n : (x * 997n * rOut) / (rIn * 1000n + x * 997n)); // getAmountOut, 0.3 % fee
// [token reserve, WETH reserve] from the pair's (reserve0, reserve1): token0 is the lower address.
const sides = (token, [r0, r1]) => (BigInt(token) < BigInt(WETH) ? [r0, r1] : [r1, r0]);
const loss = (got, expected) => (expected > 0n ? 1 - Number(got) / Number(expected) : 1);
const randomAddress = () => '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('');

// The real block, its cadence and the token's pool, owner(), decimals and symbol.
async function facts(token) {
  const n = BigInt(await rpc('eth_blockNumber', [])) - BEHIND;
  const at = hex(n);
  const [head, past, pairWord, ownerWord, decWord, symWord] = await Promise.all([
    rpc('eth_getBlockByNumber', [at, false]), rpc('eth_getBlockByNumber', [hex(n - BigInt(CADENCE_BLOCKS)), false]),
    read(FACTORY, abi.getPair(token, WETH), at), read(token, abi.owner(), at), read(token, abi.decimals(), at), read(token, abi.symbol(), at),
  ]);
  let seconds = Number(BigInt(head.timestamp) - BigInt(past.timestamp));
  if (seconds <= 0) throw new Error(`the ${CADENCE_BLOCKS} blocks before block ${n} share its timestamp: no cadence`);
  // anvil's eth_simulateV1 refuses two blocks with one timestamp, which Base's node accepts (docs/sentinel.md).
  if (LOCAL.test(urls[0])) seconds = Math.max(seconds, CADENCE_BLOCKS);
  const addr = (w) => (w?.length === 66 && BigInt(w) !== 0n ? '0x' + w.slice(26) : null);
  const pair = addr(pairWord), owner = addr(ownerWord);
  const decimals = decWord?.length === 66 && BigInt(decWord) <= 36n ? Number(BigInt(decWord)) : null;
  const [reserves, ownerBalance] = await Promise.all([
    pair ? read(pair, abi.getReserves(), at) : null, owner ? rpc('eth_getBalance', [owner, at]) : null]);
  const [rToken, rWeth] = reserves?.length >= 130 ? sides(token, [BigInt(reserves.slice(0, 66)), BigInt('0x' + reserves.slice(66, 130))]) : [0n, 0n];
  return {
    token, head, cadence: { blocks: CADENCE_BLOCKS, seconds }, pair, owner, ownerBalance, decimals, rToken, rWeth,
    symbol: text(symWord, 16), renounced: ownerWord?.length === 66 && BigInt(ownerWord) === 0n, node: host(urls[0]),
  };
}

// One eth_simulateV1 request on the real block (buildRequest): calls[k] runs in the k-th block above it, every
// block up to the last listed, at the time a real one would have; balances set before the first.
function simulate(f, calls, balances) {
  const n0 = BigInt(f.head.number), t0 = BigInt(f.head.timestamp), { blocks, seconds } = f.cadence;
  const last = Math.max(...Object.keys(calls).map(Number));
  const blockStateCalls = Array.from({ length: last }, (_, i) => ({
    blockOverrides: {
      number: hex(n0 + BigInt(i + 1)), time: hex(t0 + (BigInt(i + 1) * BigInt(seconds)) / BigInt(blocks)),
      baseFeePerGas: f.head.baseFeePerGas, feeRecipient: f.head.miner, prevRandao: f.head.mixHash,
    },
    ...(i ? {} : { stateOverrides: Object.fromEntries(Object.entries(balances).map(([a, b]) => [a, { balance: hex(b) }])) }),
    calls: (calls[i + 1] ?? []).map((c) => ({ ...c, ...FEES })),
  }));
  return rpc('eth_simulateV1', [{ blockStateCalls, validation: false, traceTransfers: true }, hex(n0)])
    .then((res) => res.flatMap((b) => b.calls));
}

// Two requests, as verifier.ts's two simulations: the buy alone with owner()'s takeback after it, for the
// amount bought; then the buy and both sales, with that amount.
async function run(f) {
  const probe = randomAddress();
  const { blocks, seconds } = f.cadence;
  const first = Math.max(2, Math.floor((FIRST_S * blocks) / seconds));
  const deadline = BigInt(f.head.timestamp) + (BigInt(LATE + 1) * BigInt(seconds)) / BigInt(blocks) + 10_000n;
  const buy = { from: probe, to: ROUTER, value: hex(AMOUNT), data: abi.buy(f.token, probe, deadline) };
  const balances = { [probe]: FUND + AMOUNT };
  const owner = f.owner;
  // owner() keeps its real balance if it covers its call's gas, else gets FUND (verifier.ts balances).
  const ownerFunds = owner && BigInt(f.ownerBalance) < BigInt(FEES.gas) * BigInt(FEES.maxFeePerGas) ? { [owner]: FUND } : {};
  const take = owner ? [{ from: owner, to: f.token, data: abi.transferFrom(probe, owner, 1n) }] : [];
  const [buy0, takeback] = await simulate(f, { 1: [buy, ...take] }, { ...balances, ...ownerFunds });
  const bought = ok(buy0) ? moves([buy0], f.token, probe, 'to') - moves([buy0], f.token, probe, 'from') : 0n;
  const result = { probe, first, buy0, takeback, bought, bps: 1301 + crypto.getRandomValues(new Uint32Array(1))[0] % 7399 };
  if (bought < 10n) return result;
  const share = (bought * BigInt(result.bps)) / 10_000n;
  const [x1, x2] = [share, bought - share];
  const sale = (x) => [{ from: probe, to: f.token, data: abi.approve(ROUTER, x) }, { from: probe, to: ROUTER, data: abi.sell(f.token, x, probe, deadline) }];
  const [a1, s1] = sale(x1), [a2, s2] = sale(x2);
  const r = await simulate(f, { 1: [buy], [first]: [a1], [first + 1]: [s1], [LATE]: [a2], [LATE + 1]: [s2] }, balances);
  return { ...result, sim: r, amounts: [x1, x2] };
}

// What each step found, and the outcome: the first block finding, else the first warn, else none.
function judge(f, r) {
  const unit = f.decimals === null ? 'token units' : f.symbol || 'tokens';
  const tok = (x) => fmt(x, f.decimals ?? 0) + ' ' + unit;
  const findings = [];
  const add = (level, word, means) => findings.push({ level, word, means });
  const taxed = (got, expected, what, step) => {
    const tax = loss(got, expected);
    const pct = Math.max(0, Math.round(tax * 100));
    if (tax >= TAX_BLOCK) add('block', `${pct} % ${what} tax`, `The guard would block this token: ${pct} % lost against the pool's quote ${step}, and it blocks from 50 %.`);
    else if (tax >= TAX_WARN) add('warn', `${pct} % ${what} tax`, `The guard would warn and let its owner decide: ${pct} % lost against the pool's quote ${step}.`);
    return pct ? `${pct} % ${what} tax` : `no ${what} tax`;
  };
  const steps = [];
  const quoted = out(AMOUNT, f.rWeth, f.rToken);
  if (!ok(r.buy0)) {
    add('block', 'buy refused', ['The guard would block this token: the buy reverts with ', el('q', {}, reason(r.buy0)), '.']);
    steps.push([`Buy refused: `, el('q', {}, reason(r.buy0)), '.']);
    return { steps, ...outcome(findings) };
  }
  if (r.bought < 10n) {
    add('block', 'no tokens received', 'The guard would block this token: the buy went through and delivered nothing.');
    steps.push([`The buy went through and delivered no tokens; the pool quoted ${tok(quoted)}.`]);
    return { steps, ...outcome(findings) };
  }
  const buyTax = taxed(r.bought, quoted, 'buy', 'on the buy');
  // verifier.ts moved(): the transferFrom went through and did not return false.
  const took = ok(r.takeback) && (r.takeback.returnData === '0x' || BigInt(r.takeback.returnData) !== 0n);
  let takeback = f.renounced ? ' owner() is 0x0, renounced: no takeback to try.' : ' No owner(): no takeback to try.';
  if (f.owner) takeback = ` owner() ${short(f.owner)} ${took ? 'took 1 unit' : 'could not take any'} back without approval.`;
  if (took) add('block', 'owner takes tokens back', ['The guard would block this token: owner() ', code(f.owner), ' takes tokens back by transferFrom without approval.']);
  steps.push([`A fresh address bought ${tok(r.bought)} for ${fmt(AMOUNT, 18)} ETH; the pool quoted ${tok(quoted)}: ${buyTax}.` + takeback]);
  const [buy, a1, s1, a2, s2] = r.sim;
  const secs = (k) => fmt(BigInt(k * f.cadence.seconds), 0, f.cadence.blocks);
  const sales = [[a1, s1, r.first, `${(r.bps / 100).toFixed(2)} % of it`], [a2, s2, LATE, 'The rest']];
  sales.forEach(([approve, swap, k, what], i) => {
    const when = `${k} blocks (${secs(k)} s) after the buy`;
    const x = r.amounts[i];
    if (!ok(swap) || !ok(approve)) {
      const why = reason(ok(approve) ? swap : approve);
      add('block', 'sale refused', [`The guard would block this token: the sale ${when} reverts with `, el('q', {}, why), '.']);
      return steps.push([`${what}, ${tok(x)}, could not be sold ${when}: `, el('q', {}, why), '.']);
    }
    const before = [buy, ...sales.slice(0, i).flatMap(([a, s]) => [a, s])];
    const sync = lastSync(before, f.pair);
    const quote = sync ? out(x, ...sides(f.token, sync)) : 0n;
    const got = moves([approve, swap], ETH_LOGS, r.probe, 'to');
    const tax = taxed(got, quote, 'sale', `on the sale ${when}`);
    if (moves([approve, swap], WETH, f.pair, 'from') > got) add('block', 'pool pays more than the seller gets', `The guard would block this token: the pool paid out more WETH than the seller received, ${when}.`);
    steps.push([`${what}, ${tok(x)}, sold ${when}${k === LATE ? ', the last block a simulation reaches' : ''}: received ${fmt(got, 18)} ETH, the pool quoted ${fmt(quote, 18)}: ${tax}.`]);
  });
  return { steps, ...outcome(findings) };
}
function outcome(findings) {
  const top = findings.find((x) => x.level === 'block') ?? findings.find((x) => x.level === 'warn');
  return top ?? { level: 'none', word: 'resale simulated without anomaly', means: 'Quick check: the buy, both sales and the takeback probe went as for an honest token. This is not the guard\'s verdict.' };
}

// Display: at most 4 significant digits (Number is exact enough for that), `per` for a fraction of seconds.
const fmt = (raw, decimals, per = 1) => (Number(raw) / per / 10 ** decimals).toLocaleString('en-US', { maximumSignificantDigits: 4 });
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

// The page. Only addresses that pass ADDRESS reach the node; everything shown goes in as text nodes.
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : e.setAttribute(k, v);
  e.append(...kids);
  return e;
}
const code = (a) => el('code', { title: a }, short(a));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, calm() ? 0 : ms));
let busy = false;

function light(i, parts) {
  const li = $('qboard').querySelectorAll('.seq>li')[i];
  $('q' + (i + 1)).replaceChildren(...parts);
  li.classList.add('on');
}
function finish(o, reached) {
  const board = $('qboard');
  board.dataset.v = o.level;
  board.classList.toggle('judged', o.level !== 'none');
  const lamps = el('span', { class: 'lamps', 'aria-hidden': 'true' }, ...[0, 1, 2, 3].map((i) => el('i', i < reached ? { class: 'on' } : {})));
  $('qplate').replaceChildren(lamps, el('span', { class: 'word' }, o.word), el('span', { class: 'means' }, ...[].concat(o.means)));
  board.classList.add('done');
}

async function check(token) {
  busy = true;
  const btn = $('qrun');
  for (const b of $('qform').querySelectorAll('button')) b.setAttribute('aria-disabled', 'true');
  btn.textContent = 'Checking…';
  const board = $('qboard');
  board.classList.remove('judged', 'done');
  board.dataset.v = 'none';
  board.setAttribute('aria-busy', 'true');
  board.querySelectorAll('.seq>li').forEach((li) => li.classList.remove('on'));
  $('qcaption').replaceChildren('Reading Base from ', el('strong', {}, host(urls[0])), '…');
  let reached = 0;
  try {
    const f = await facts(token);
    $('qcaption').replaceChildren(el('strong', {}, f.symbol ?? 'Token'), ' ', code(token), `, simulated by this browser on Base block ${BigInt(f.head.number).toLocaleString('en-US')} through ${f.node}, read only.`);
    if (!f.pair || f.rWeth === 0n) {
      light(0, f.pair ? ['Pool ', code(f.pair), ' holds no WETH: nothing to buy with.'] : ['No Uniswap V2 WETH pool for this token.']);
      return finish({ level: 'none', word: 'cannot be checked here', means: 'The guard buys only through a Uniswap V2 WETH pool, so this token cannot be checked here.' }, 1);
    }
    light(0, ['Pool ', code(f.pair), ` holds ${fmt(f.rWeth, 18)} WETH and ${fmt(f.rToken, f.decimals ?? 0)} ${f.decimals === null ? 'token units' : f.symbol || 'tokens'}.`]);
    reached = 1;
    const j = judge(f, await run(f));
    for (const parts of j.steps) {
      await wait(450);
      light(reached++, parts);
    }
    await wait(450);
    finish(j, reached);
  } catch (e) {
    console.error('quick check:', e);
    if (!reached) $('qcaption').replaceChildren('Nothing could be read from Base.');
    finish({ level: 'none', word: 'check not finished', means: [e.message.length > 200 ? e.message.slice(0, 200) + '…' : e.message, '. Try again in a moment.'] }, reached);
  } finally {
    busy = false;
    board.setAttribute('aria-busy', 'false');
    for (const b of $('qform').querySelectorAll('button')) b.removeAttribute('aria-disabled');
    btn.textContent = 'Check this token';
  }
}

function init() {
  const asked = new URLSearchParams(location.search).get('rpc');
  if (asked && LOCAL.test(asked)) urls = [asked];
  else if (asked) console.warn('quick check: ?rpc= is taken only for http://127.0.0.1 or http://localhost with a port; using public Base nodes');
  const input = $('qaddr'), hint = $('qhint'), hintText = hint.textContent;
  $('qform').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    const v = input.value.trim();
    const bad = !ADDRESS.test(v);
    input.setAttribute('aria-invalid', String(bad));
    hint.classList.toggle('err', bad);
    hint.textContent = bad ? 'Not a token address: 0x then 40 hexadecimal digits.' : hintText;
    if (bad) return input.focus();
    check(v.toLowerCase());
  });
  for (const b of document.querySelectorAll('#qform [data-addr]')) {
    b.addEventListener('click', () => {
      if (busy) return;
      input.value = b.dataset.addr;
      $('qform').requestSubmit();
    });
  }
}
if (typeof document !== 'undefined') init();
