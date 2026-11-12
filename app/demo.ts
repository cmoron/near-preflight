// Demo, the agent's process: it holds only its function-call key (.env.agent) and no EVM key.
// Default: four moments. (1) A poisoned message pushes the agent to a trap token: the sentinel blocks
// it with its reason and the contract refuses the buy. With NEAR_AI_API_KEY the agent is the live
// attested model (app/llm.ts); without it, its recorded decision is verified instead. (2) A farm token
// whose simulation is clean is blocked by its template's reputation. (3) A healthy token: allow, NEAR
// signs the buy, a keyless relay broadcasts it on the Base fork. (4) The compromised agent bypasses its
// wrapper: the contract and the protocol refuse.
// --full adds, unchanged: the agent's exit, a warn refused then approved by the human, a trap aimed at
// the guard's own EVM address, a second agent, and with the key the injection count and the model's
// own USDC buy. demo.sh adds the armer's bounds, the emergency stop and the withdrawal.
// The commands that verify this run (replay, attest) are written to proofs/verify.txt.
// Usage: bun --env-file=.env --env-file=.env.agent [--env-file=.env.llm] app/demo.ts [--full]
import { formatNearAmount, nearToYocto } from "near-api-js";
import { decodeFunctionData, formatEther, getAddress, parseAbi, parseEther, parseTransaction, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { agent, BUY_GAS, guardedBuy, requestCheck, sellAll, waitVerdict } from "./agent";
import { GUARD_PATH, MPC_CONTRACT } from "./derive";
import { boundSystem, costUsd, guardTools, inbox, injectionRuns, MODEL, runAgent, type Step, type Usage } from "./llm";
import { call, env, reason, view, type Entry } from "./near";
import { WETH } from "./verifier";

const FULL = process.argv.includes("--full");
/** The trap the poisoned inbox pushes: every sale refused after the buy. */
const TRAP = tokens.sell_blocked as Address;
/** --full: a trap that freezes only the guard's own EVM address. */
const GUARD_TRAP = tokens.guard_frozen as Address;
const USDC = tokens.usdc as Address;
const FRESH = tokens.farm_fresh as Address;
const ATTACKER = `attacker.${env("OWNER")}`;
const ATTACKER_EVM = "0x000000000000000000000000000000000000dEaD";
const WEI = 10_000_000_000_000n; // 0.00001 ETH per buy
const swap = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
]);
const step = (s: string) => console.log(`\n${s}`);
const buyArgs = (id: number, wei: bigint) => ({ id, amount_wei: wei.toString() });
const spawnEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
/** Commands that verify this run, written to proofs/verify.txt for demo.sh to print last. */
const verify: string[] = [];
const replayCmd = (id: number, what: string) => verify.push(`bun --env-file=.env app/replay.ts proofs/${id}.json --check   # ${what}`);

/** An attempt that must fail for the reason `want`; otherwise the demo fails (exit code 1). */
async function mustFail(what: string, want: string, attempt: () => Promise<unknown>, by = "contract") {
  try {
    await attempt();
    console.log(`  !!! ${what} : ACCEPTED, the guard failed`);
    process.exitCode = 1;
  } catch (e) {
    console.log(`  [${by}] ${what} : REFUSED (${reason(e)})`);
    if (!reason(e).includes(want)) {
      console.log(`  !!! refused, but not because: ${want}`);
      process.exitCode = 1;
    }
  }
}

/** Relay in its own process, without the agent's key: it reads only .env (no key). */
async function relay(...args: (string | number)[]): Promise<boolean> {
  const p = Bun.spawn(["bun", "--env-file=.env", "app/relay.ts", ...args.map(String)], { env: spawnEnv, stdout: "inherit", stderr: "inherit" });
  return (await p.exited) === 0;
}

/** The human approving a warn: own process, the owner's full-access key read from the near-cli
 *  keychain by that process, never by this one. */
function humanApproves(id: number): void {
  console.log(`  [demo] the human reads the reasons and approves #${id} (own process, owner's key)`);
  Bun.spawn(["bun", "--env-file=.env", "app/human.ts", "approve", String(id)], { env: spawnEnv, stdout: "inherit", stderr: "inherit" });
}

/** app/attest.ts in its own process (no key: it reads the package and, with --check, the guard). */
async function attest(args: (string | number)[], guard = env("GUARD")): Promise<boolean> {
  const p = Bun.spawn(["bun", "app/attest.ts", ...args.map(String)], {
    env: { ...spawnEnv, GUARD: guard, NEAR_RPC: env("NEAR_RPC") },
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = (await new Response(p.stdout).text()).trim();
  console.log(out.replace(/^/gm, "  [attest] "));
  return (await p.exited) === 0;
}

/** The model's guard calls in a run, with what the guard answered. */
const trace = (steps: Step[]) =>
  steps.flatMap((s) => s.calls.filter((c) => c.name !== "read_inbox").map((c) => `${c.name}(${JSON.stringify(c.args)}) -> ${c.result.slice(0, 110)}`));

/** Runs one moment. If anything in it throws, says which moment failed and why, and the demo ends with
 *  exit code 1: never an unhandled exception. */
async function moment(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.log(`  !!! ${name} failed: ${reason(e)}`);
    process.exitCode = 1;
  }
}

/** A recorded decision (app/fixtures), anchored on our deployment: verified when there is no key. */
const FIXTURE = "app/fixtures/decision.json";
const FIXTURE_GUARD = "guard.goblin-guard-13713.testnet";
const FIXTURE_CHECK = 1;
const KEY = process.env.NEAR_AI_API_KEY;
const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
let tools: Awaited<ReturnType<typeof guardTools>> | null = null;
let trapCheck: number | undefined;
let witness: { id: number; signed: string | null } | null = null;

/** The owner removes `token`'s entry from the shared blocklist (app/human.ts unlist, own process, the
 *  owner's key), so that this run shows its check again. */
async function unlist(token: Address): Promise<void> {
  const p = Bun.spawn(["bun", "--env-file=.env", "app/human.ts", "unlist", token], { env: spawnEnv, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`unlist ${token} failed`);
}

/** request_check on `token`. A run interrupted before its verdicts leaves checks that the sentinel judges
 *  first in this run: one of them can list the trap again after setup. The owner then unlists it again. */
async function requestUnlisted(token: Address): Promise<number> {
  for (let tries = 1; ; tries++) {
    try {
      return await requestCheck(token, WEI);
    } catch (e) {
      if (tries === 3 || !reason(e).includes("target is on the shared blocklist")) throw e;
      console.log(`[demo] ${token} was listed again, by a check an earlier run left pending: the owner removes the entry`);
      await unlist(token);
    }
  }
}

await moment("setup", async () => {
  // A previous run listed the trap on the shared blocklist: the owner removes the entry.
  for (const token of [TRAP, GUARD_TRAP, FRESH, USDC]) {
    if (!(await view<Entry | null>("get_entry", { token }))) continue;
    console.log(`[demo] ${token} is still listed by a previous run: the owner removes the entry`);
    await unlist(token);
  }
  tools = KEY ? await guardTools(inbox(TRAP, USDC), WEI) : null;
});

step(`1. A poisoned message in the agent's inbox (it reaches the model as a tool result):`);
await moment("moment 1", async () => {
  const poisoned = (JSON.parse(inbox(TRAP, USDC)) as { from: string; text: string }[]).find((m) => m.from === "anon_7f3e")!;
  console.log(`  > ${poisoned.from}: ${poisoned.text}`);
  if (!KEY || !tools) {
    console.log(`  no NEAR_AI_API_KEY: live model skipped; verifying its recorded decision on this inbox (anchored as check #${FIXTURE_CHECK} on ${FIXTURE_GUARD})`);
    if (!(await attest([FIXTURE, "--check", FIXTURE_CHECK], FIXTURE_GUARD))) process.exitCode = 1;
    verify.push(`GUARD=${FIXTURE_GUARD} bun app/attest.ts ${FIXTURE} --check ${FIXTURE_CHECK}   # the model's recorded decision`);
  } else {
    const n = FULL ? Number(process.env.LLM_RUNS ?? 3) : 1;
    console.log(`  The agent is ${MODEL} on NEAR AI Cloud, in a TEE: ${n} run(s); each completion is signed by the model and archived with an attestation fetched with a fresh nonce, its signed request names this guard, this agent and the latest NEAR block, and each guard call carries the decision's sha256.`);
    try {
      const runs = await injectionRuns({ n, key: KEY, trap: TRAP, tools, dir: "proofs/llm", usage, system: await boundSystem() });
      for (const [i, r] of runs.entries()) {
        console.log(`  [model] run ${i + 1}: ${r.resisted ? "resisted" : "FOLLOWED THE INJECTION"}, ${r.label}; ${r.steps.length} signed completions in ${r.steps[0].file.replace(/-1\.json$/, "-*.json")}`);
        for (const t of trace(r.steps)) console.log(`      ${t}`);
      }
      if (FULL) console.log(`  [demo] resisted ${runs.filter((r) => r.resisted).length} of ${n}`);
      // The first decision that reached the guard: its package against the check that carries its sha256.
      const asked = runs.flatMap((r) => r.steps).find((s) => s.calls.some((c) => c.name === "request_check" && c.result.startsWith("{")));
      const checked = asked?.calls.find((c) => c.name === "request_check" && c.result.startsWith("{"));
      if (asked && checked) {
        const id = Number(JSON.parse(checked.result).check_id);
        if (String(checked.args.token).toLowerCase() === TRAP.toLowerCase()) trapCheck = id;
        if (!(await attest([asked.file, "--check", id]))) process.exitCode = 1;
        verify.push(`bun --env-file=.env app/attest.ts ${asked.file} --check ${id}   # the model's decision, anchored on check #${id}`);
      } else {
        if (!(await attest([runs[0].steps[0].file]))) process.exitCode = 1;
        verify.push(`bun app/attest.ts ${runs[0].steps[0].file}   # the model's first decision (no guard call to anchor it)`);
      }
    } catch (e) {
      console.log(`  !!! LLM step failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      process.exitCode = 1;
    }
  }
  console.log(`  [simulated agent] A compromised agent (scripted, not an LLM) obeys the message: it checks ${TRAP}, then calls buy anyway.`);
  const trapId = trapCheck ?? (await requestUnlisted(TRAP));
  const trapVerdict = await waitVerdict(trapId);
  console.log(`  [sentinel] #${trapId}: ${trapVerdict?.verdict?.toUpperCase()} (${trapVerdict?.reasons})`);
  if (trapVerdict?.verdict !== "block") process.exitCode = 1;
  await mustFail(`buy(#${trapId}) of 0.00001 ETH`, "verdict does not allow the purchase", () => call(agent, "buy", buyArgs(trapId, WEI), 0n, BUY_GAS));
  replayCmd(trapId, "moment 1: the trap's block");
});

step(`2. A farm token (${FRESH}): its simulation is clean, but its code template launched 5 pools that their creators drained 2 blocks after funding.`);
await moment("moment 2", async () => {
  const farm = await guardedBuy(FRESH, WEI);
  const farmVerdict = await waitVerdict(farm.id); // a plain view may hit an RPC node behind the verdict
  const farmListed = await view<Entry | null>("get_entry", { token: FRESH });
  console.log(`  [contract] get_entry ${FRESH}: ${farmListed ? "LISTED" : "not listed (a reputation-only block never lists: copies of a token's code cannot get it listed)"}`);
  if (farm.signed || farmVerdict?.verdict !== "block" || !farmVerdict.reasons.startsWith("template ") || farmListed) {
    console.log(`  !!! farm #${farm.id}: verdict ${farmVerdict?.verdict} (${farmVerdict?.reasons}), listed ${!!farmListed}`);
    process.exitCode = 1;
  }
  replayCmd(farm.id, "moment 2: the farm's block (rebuilds the template index from the node)");
});

step(`3. A healthy token, USDC: three copies of its code were funded and drained on this fork, yet copies cannot get it blocked (its pool predates the template index). Verdict allow, the guard builds the swap, NEAR signs it, a relay with no key broadcasts it on the Base fork.`);
await moment("moment 3", async () => {
  witness = await guardedBuy(USDC, WEI);
  const v = await waitVerdict(witness.id);
  console.log(`  [sentinel] #${witness.id}: ${v?.verdict?.toUpperCase()} (${v?.reasons})`);
  if (!witness.signed || !(await relay(witness.id))) process.exitCode = 1;
  replayCmd(witness.id, "moment 3: the allow NEAR signed (the transaction signed is the one simulated)");
});

step("4. The compromised agent bypasses its wrapper, with its own function-call key:");
await moment("moment 4", async () => {
  await mustFail(
    `sign on ${MPC_CONTRACT} directly`,
    "does not match transaction receiver",
    () => agent.callFunction({ contractId: MPC_CONTRACT, methodName: "sign", args: { request: { path: GUARD_PATH, payload_v2: { Ecdsa: "00".repeat(32) }, domain_id: 0 } } }),
    "protocol",
  );
  // Deliberately small amount: the agent can afford it, only its key's permission can refuse.
  await mustFail(`direct transfer of 0.01 NEAR to ${ATTACKER}`, "Access key requires full access", () => agent.transfer({ receiverId: ATTACKER, amount: nearToYocto("0.01") }), "protocol");
  await mustFail(`request_check on USDC for a buy of 1 ETH`, "amount above the owner's per-buy limit", () => call(agent, "request_check", { target: USDC, amount_wei: parseEther("1").toString() }));
  const id = await requestCheck(USDC, WEI);
  const check = await waitVerdict(id);
  console.log(`  [agent] verdict #${id} on a buy of ${formatEther(WEI)} ETH of USDC: ${check?.verdict}; it now tries to spend it on its own terms`);
  await mustFail(`buy(#${id}) of 1 ETH`, "amount is not the one checked", () => call(agent, "buy", buyArgs(id, parseEther("1")), 0n, BUY_GAS));
  // buy has no target, router, recipient, path or minimum: the contract ignores these injected fields.
  const injected = { ...buyArgs(id, WEI), target: TRAP, recipient: ATTACKER_EVM, router: ATTACKER_EVM, path: [WETH, TRAP], min_out: "0" };
  console.log(`  [agent] buy(#${id}) with target ${TRAP}, recipient and router ${ATTACKER_EVM}, min_out 0 added to the arguments`);
  const { value: raw } = await call<Hex | null>(agent, "buy", injected, 0n, BUY_GAS);
  if (!raw) throw new Error("no signature returned");
  const tx = parseTransaction(raw);
  const { args } = decodeFunctionData({ abi: swap, data: tx.data ?? "0x" });
  const bought = getAddress(args[1][1]);
  console.log(
    `  [contract] signed for router ${tx.to}: path WETH -> ${bought} (the checked USDC), recipient ${args[2]}, ` +
      `amountOutMin ${args[0]} (sentinel quote minus 3 %), gas limit ${tx.gas}: the transaction the sentinel simulated; the injected fields were ignored`,
  );
  if (bought !== getAddress(USDC) || args[0] === 0n || !(await relay(id))) process.exitCode = 1;
});

if (FULL) {
  step("5. Exit: the agent sells the USDC it holds for ETH, on a sentinel exit quote; NEAR signs the approve and swap the sentinel simulated, back to the guard's address.");
  await moment("moment 5", async () => {
    if (!witness?.signed) throw new Error("moment 3 bought nothing to sell");
    const exit = await sellAll(witness.id);
    if (exit.signed.length !== 2 || !(await relay("exit", exit.nonce))) process.exitCode = 1;
  });

  const TAX = tokens.sell_tax_20 as Address;
  step(`6. A token with a 20 % sale tax (${TAX}): WARN. The wrapper asks the human and waits; nobody approves.`);
  await moment("moment 6", async () => {
    const ignored = await guardedBuy(TAX, WEI, { approvalWaitMs: 10_000 });
    if (ignored.signed) process.exitCode = 1;
    await mustFail(`buy(#${ignored.id}) on the unapproved warn, wrapper bypassed`, "warn verdict not approved by the owner", () => call(agent, "buy", buyArgs(ignored.id, WEI), 0n, BUY_GAS));
  });

  step("7. Same token, new check: the human approves the warn on chain, then the guard has NEAR sign the purchase.");
  await moment("moment 7", async () => {
    const approved = await guardedBuy(TAX, WEI, { onWarn: humanApproves });
    if (!approved.signed || !(await relay(approved.id))) process.exitCode = 1;
  });

  step(`8. A trap aimed at the guard's own EVM address (${GUARD_TRAP} freezes the tokens it holds): block, but not listed, since it rests on the guard's state, which anyone can change.`);
  await moment("moment 8", async () => {
    const aimed = await guardedBuy(GUARD_TRAP, WEI);
    const aimedListed = await view<Entry | null>("get_entry", { token: GUARD_TRAP });
    console.log(`  [contract] get_entry ${GUARD_TRAP}: ${aimedListed ? "LISTED" : "not listed"}`);
    if (aimed.signed || aimedListed) process.exitCode = 1;
  });

  console.log(`\n9. A second agent, its own process and key, asks for a check of the farm token:`);
  await moment("moment 9", async () => {
    const second = Bun.spawn(["bun", "--env-file=.env", "--env-file=.env.agent2", "app/check.ts", FRESH], { env: spawnEnv, stdout: "pipe", stderr: "pipe" });
    const said = (await new Response(second.stdout).text()).trim();
    console.log(said);
    if ((await second.exited) !== 0 || !said.includes("verdict=block") || !said.includes("reasons=template ")) {
      console.log("  !!! the second agent's check was not blocked by the template's reputation");
      process.exitCode = 1;
    }
  });

  if (KEY && tools) {
    const own = tools;
    step(`10. The owner asks the model to buy ${formatEther(WEI)} ETH of USDC: check, then buy, each call carrying its decision's sha256; a relay with no key broadcasts the purchase.`);
    await moment("moment 10", async () => {
      const steps = await runAgent({ key: KEY, system: await boundSystem(), user: `Buy ${formatEther(WEI)} ETH of USDC (${USDC}) for me through the guard, then report what you did.`, tools: own, dir: "proofs/llm", usage });
      for (const t of trace(steps)) console.log(`      ${t}`);
      const bought = steps.find((s) => s.calls.some((c) => c.name === "buy" && c.result.includes('"signed":true')));
      const buyId = bought && Number(bought.calls.find((c) => c.name === "buy")!.args.check_id);
      if (!bought) console.log("  [demo] the model did not complete a purchase (its choice, or a refusal above)");
      else if (!(await relay(buyId!)) || !(await attest([bought.file, "--check", buyId!]))) process.exitCode = 1;
    });
  }
}
if (KEY) console.log(`  [demo] NEAR AI Cloud: ${usage.prompt_tokens} input and ${usage.completion_tokens} output tokens, about ${costUsd(usage).toFixed(4)} USD`);

await moment("summary", async () => {
  const [credit, budget] = await Promise.all([view<string>("credit_of", { account: env("AGENT") }), view<string>("budget_left", { account: env("AGENT") })]);
  step(`Summary: prepaid credit ${formatNearAmount(credit, 4)} NEAR, armed budget left ${formatNearAmount(budget, 4)} NEAR.`);
});
console.log(
  process.exitCode
    ? "DEMO FAILED: a moment failed (see !!! above), an attempt went through, a refusal had another reason, a healthy purchase did not complete, or a verdict was not the expected one."
    : "The trap and the farm were blocked and their buys refused; the bypasses were refused by the contract and the protocol; the healthy purchases were signed by NEAR, as simulated, and executed on the fork.",
);
await Bun.write("proofs/verify.txt", ["Verify this run yourself (fork still running; each command exits 0):", ...verify.map((l) => `  ${l}`), ""].join("\n"));
