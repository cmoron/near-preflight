// Step 4: joins the outcome labels (pools files: facts after launch) and the verdicts (checks files: facts
// up to the later block) into corpus.json, one object per pair, and prints the tables of corpus.md, per set.
// Usage: bun report.ts <corpus.json> <set>=<pools.json>:<checks.json> ...
const [out, ...sets] = process.argv.slice(2);
const short = (t: string | null) => (t ? `${t.slice(0, 6)}..${t.slice(-4)}` : "no code");
const table = (head: string[], body: (string | number)[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const count = (xs: any[], f: (r: any) => string) => xs.reduce((m: Record<string, number>, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const flat = (m: Record<string, number>) => Object.entries(m).sort().map(([k, n]) => `${n} ${k}`).join(", ");
const V = ["block", "warn", "allow", "failed"];
const LABELS = ["drained", "honeypot-like", "dumped", "alive", "unclear"];

/** Which rule set the verdict: the levels each rule gave on its own (check.ts by_rule). */
function rule(c: any): string {
  if (!c || c.error) return "check failed (a sentinel posts block after 3 failures)";
  const rep = c.by_rule.reputation.find((x: string) => x.startsWith("block"));
  const sim = c.by_rule.simulation_and_code.verdict;
  const liq = c.by_rule.liquidity.find((x: string) => x.startsWith("warn"));
  if (c.verdict === "block") return rep && sim === "block" ? "block: reputation and simulation/code" : rep ? "block: template reputation" : "block: simulation/code";
  if (c.verdict === "warn") return sim === "warn" && liq ? "warn: removable LP and code/simulation" : liq ? "warn: removable LP only" : "warn: code/simulation only";
  return "allow";
}
const material = (c: any) => {
  const x = c.reputation;
  if (!x) return "no index";
  if (x.before_block === null) return "not applied";
  return x.pools < 3 ? "fewer than 3 earlier pools" : x.drained / x.pools >= 0.8 ? "3+ earlier pools, >= 80 % drained" : "3+ earlier pools, < 80 % drained";
};

const all: any[] = [];
const meta: any = {};
for (const s of sets) {
  const [name, files] = s.split("=");
  const [poolsFile, checksFile] = files.split(":");
  const P = await Bun.file(poolsFile).json();
  const checks: any[] = await Bun.file(checksFile).json();
  const byPair = new Map(checks.map((c) => [c.pair, c]));
  meta[name] = { window: P.window, pairs_listed: P.pairs_listed ?? P.pools.length, skipped_template: P.skipped_template ?? null, skipped: P.skipped ?? 0, labelled: P.built, labelling_requests: P.nodes };
  for (const p of P.pools) {
    const c = byPair.get(p.pair);
    if (name === "first" && !c) continue; // the first-pools set: only the pools checked
    all.push({
      set: name,
      pair: p.pair,
      token: p.token,
      created_block: p.created,
      launch_block: p.launch,
      launch_tx: p.launch_tx ?? null,
      family: p.launch === null ? null : { template: p.template, launcher: p.launcher, code_bytes: p.code_bytes },
      outcome: { label: p.label, reason: p.label_reason, evidence: p.outcome ?? null },
      check: c
        ? {
            requested_s: c.requested_s,
            reference_block: c.block ?? null,
            later_block: c.later_block ?? null,
            verdict: c.error ? null : c.verdict,
            reasons: c.reasons ?? null,
            deciding_rule: rule(c),
            reputation_input: c.error ? null : material(c),
            by_rule: c.by_rule ?? null,
            reputation: c.reputation ?? null,
            liquidity: c.liquidity ?? null,
            quote: c.quote ?? null,
            calls: c.calls ?? null,
            opcodes: c.opcodes ?? null,
            token_calls: c.token_calls ?? null,
            token_opcodes: c.token_opcodes ?? null,
            later: c.later ?? null,
            sales: c.sales ?? null,
            error: c.error ?? null,
            attempts: c.attempt,
            seconds: c.seconds,
          }
        : null,
    });
  }
}
await Bun.write(out, JSON.stringify({ built: new Date().toISOString(), sets: meta, pools: all }, null, 1));

const vOf = (r: any) => r.check.verdict ?? "failed";
const noRep = (r: any) => (r.check.error ? "failed" : r.check.by_rule.simulation_and_code.verdict === "block" ? "block" : r.check.by_rule.simulation_and_code.verdict === "warn" || r.check.by_rule.liquidity.length ? "warn" : "allow");
for (const name of Object.keys(meta)) {
  const rows = all.filter((r) => r.set === name && r.check);
  console.log(`\n# Set ${name}: ${all.filter((r) => r.set === name).length} pairs, ${rows.length} checked`);
  console.log(`labels of all pairs: ${flat(count(all.filter((r) => r.set === name), (r) => r.outcome.label))}\n`);
  console.log(table(["outcome", "pools", ...V], LABELS.map((l) => { const xs = rows.filter((r) => r.outcome.label === l); const m = count(xs, vOf); return [l, xs.length, ...V.map((v) => m[v] ?? 0)]; })));
  console.log(`\ndeciding rule:\n`);
  const rules = [...new Set(rows.map((r) => r.check.deciding_rule))].sort() as string[];
  console.log(table(["deciding rule", ...LABELS], rules.map((x) => [x, ...LABELS.map((l) => rows.filter((r) => r.outcome.label === l && r.check.deciding_rule === x).length)])));
  console.log(`\nwithout the reputation rule (simulation, code and liquidity only):\n`);
  console.log(table(["outcome", "pools", ...V], LABELS.map((l) => { const xs = rows.filter((r) => r.outcome.label === l); const m = count(xs, noRep); return [l, xs.length, ...V.map((v) => m[v] ?? 0)]; })));
  console.log(`\nreputation input at the reference block:\n`);
  console.log(table(["input", "pools", ...V], Object.entries(count(rows.filter((r) => !r.check.error), (r) => r.check.reputation_input)).map(([k, n]) => [k, n, ...V.map((v) => rows.filter((r) => r.check.reputation_input === k && vOf(r) === v).length)])));
  const shares = rows.filter((r) => r.check.reputation?.pools >= 3).map((r) => r.check.reputation.drained / r.check.reputation.pools).sort((a, b) => a - b);
  if (shares.length) console.log(`\ndrained share of earlier pools (3+): min ${shares[0].toFixed(2)}, median ${shares[shares.length >> 1].toFixed(2)}, max ${shares.at(-1).toFixed(2)}`);
  console.log(`\nfamilies:\n`);
  const fams = new Map<string, any[]>();
  for (const r of all.filter((r) => r.set === name && r.family)) (fams.get(r.family.template) ?? fams.set(r.family.template, []).get(r.family.template)!).push(r);
  console.log(table(["template", "code bytes", "pools", "launchers", "outcomes", "verdicts", "deciding rules"], [...fams.entries()].sort((a, b) => b[1].length - a[1].length).map(([t, ps]) => {
    const xs = ps.filter((r) => r.check);
    const weth = ps.map((r) => Number(r.outcome.evidence.launch_weth) / 1e18);
    return [`${short(t)} (${Math.min(...weth).toPrecision(2)}-${Math.max(...weth).toPrecision(2)} ETH)`, ps[0].family.code_bytes, ps.length, new Set(ps.map((r) => r.family.launcher)).size, flat(count(ps, (r) => r.outcome.label)), flat(count(xs, vOf)), flat(count(xs, (r) => r.check.deciding_rule))];
  })));
  console.log(`\nsimulation/code verdict alone: ${flat(count(rows.filter((r) => !r.check.error), (r) => r.check.by_rule.simulation_and_code.verdict))}`);
  console.log(`simulation/code reasons: ${flat(count(rows.filter((r) => !r.check.error), (r) => r.check.by_rule.simulation_and_code.reasons))}`);
  const gone = rows.filter((r) => r.outcome.evidence?.lp_pulled !== null && r.check.later_block !== null && r.outcome.evidence.lp_pulled <= r.check.later_block);
  console.log(`LP pulled before the check's later block: ${gone.length}`);
  const failed = rows.filter((r) => r.check.error);
  if (failed.length) console.log(`failed checks: ${failed.map((r) => r.check.error).join(" | ")}`);
  const secs = rows.map((r) => r.check.seconds).sort((a, b) => a - b);
  console.log(`check wall time per pool: median ${secs[secs.length >> 1]} s, max ${secs.at(-1)} s`);
  if (name !== "window") for (const r of rows) console.log(`  ${short(r.family?.template)} ${(Number(r.outcome.evidence.launch_weth) / 1e18).toPrecision(2)} ETH ${r.outcome.label}: ${vOf(r)} [${r.check.deciding_rule}] ${(r.check.reasons ?? r.check.error ?? "").slice(0, 200)}`);
}
