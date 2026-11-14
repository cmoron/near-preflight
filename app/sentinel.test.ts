// The sentinel's decision on a request read: never skip a request merely absent from a lagging node;
// and its node calls through a public node's rate limit.
import { describe, expect, test } from "bun:test";
import { toHex } from "viem";
import { INDEX_SPAN_S, windowProblem } from "./index";
import type { Check } from "./near";
import { chainProblem, indexer, refusal, step } from "./sentinel";
import { CHAIN_ID, checkExit, checkToken, patientFetch, rpc, stampOf } from "./verifier";

const check = (verdict: Check["verdict"]): Check => ({
  agent: "agent.test",
  target: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  requested_ns: "1",
  verdict,
  reasons: "",
  judged_ns: "0",
  evidence_sha256: "",
  quote: "0",
  settled: false,
  approved: false,
  signed_tx: null,
  code: null,
  exit_amount: null,
  decision_sha256: null,
  buy_decision_sha256: null,
  amount_wei: "10000000000000",
  tx_hashes: [],
  votes: verdict ? [{ sentinel: "s1.test", verdict, evidence_sha256: "" }] : [],
});

test("absent on a node behind last_check_id: reread on the next round, not skipped", () => {
  expect(step(null, 99, 100)).toBe("retry");
});
test("absent at last_check_id's block or after: erased by refund_check, skipped", () => {
  expect(step(null, 100, 100)).toBe("skip");
  expect(step(null, 101, 100)).toBe("skip");
});
// The guard says whether this sentinel's vote on a check can still count (view vote_due): the quorum's
// rules live in the contract, the sentinel no longer copies them.
describe("the guard's vote_due decides", () => {
  test("due: judged, whatever the verdict so far (a block may still overturn an allow, an exit takes every quote)", () => {
    for (const v of [null, "allow", "warn", "block"] as const) expect(step(check(v), 100, 100, true)).toBe("judge");
    expect(step({ ...check("allow"), exit_amount: "5" }, 100, 100, true)).toBe("judge");
  });
  test("not due (voted, decided, 300 s old, signed, or no longer a sentinel): skipped", () => {
    for (const v of [null, "allow", "warn", "block"] as const) expect(step(check(v), 100, 100, false)).toBe("skip");
  });
  test("not due on a node behind the one that showed the check: reread, a node that has not seen the check says false", () => {
    expect(step(check(null), 100, 100, false, 99)).toBe("retry");
    expect(step(check(null), 100, 100, false, 100)).toBe("skip");
    expect(step(check(null), 100, 100, true, 99)).toBe("judge"); // true is never a node's ignorance
  });
});

// Review of a274879: restarted by check-mainnet.sh, the sentinels voted mainnet warns on fork checks #8 and #9,
// decided blocks still short of the quorum. A sentinel votes only on checks requested since it started:
// its own run, on the node it was given (a fork check and a mainnet one share chain id 8453 and the guard).
// vote_due does not know which chain a sentinel reads: a check under 300 s old is still due to it.
describe("checks from before this sentinel started", () => {
  const at = (ns: string, c: Check): Check => ({ ...c, requested_ns: ns });
  test("requested before its start: skipped, though the guard says its vote is due", () => {
    expect(step(at("4", check(null)), 100, 100, true, 100, 5n)).toBe("skip");
    expect(step(at("4", check("block")), 100, 100, true, 100, 5n)).toBe("skip");
  });
  test("requested since its start: the guard decides", () => {
    expect(step(at("5", check(null)), 100, 100, true, 100, 5n)).toBe("judge");
    expect(step(at("6", check("block")), 100, 100, false, 100, 5n)).toBe("skip");
  });
});
// A vote the guard refuses because the sentinel set or the quorum changed since this one read them.
describe("a vote refused for the set or the quorum", () => {
  test("decided by others, or a quorum lowered: settled, the set and quorum read again", () => {
    expect(refusal("Smart contract panicked: verdict already posted")).toBe("settled");
    expect(refusal("Smart contract panicked: sentinel already voted")).toBe("settled");
  });
  test("no longer one of the guard's sentinels: the set read again", () => expect(refusal("Smart contract panicked: sentinel only")).toBe("not a sentinel"));
  test("any other refusal: retried as a failure", () => expect(refusal("tx hashes are not what the guard would sign now: preview again")).toBeNull());
});

// Batch 9: the later side reads 100 blocks of receipts from Base's public node, which answers HTTP 429
// to a burst; a check or a replay then failed on the first one.
describe("rpc: a public node's rate limit", () => {
  test("429 twice, then an answer: waited out (1 s, then 2 s); a 429 after the last wait is returned, an error for rpc", async () => {
    let calls = 0;
    const limit = { n: 2 };
    const node = Bun.serve({ port: 0, fetch: () => (++calls <= limit.n ? new Response("{}", { status: 429 }) : Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })) });
    try {
      expect(await rpc<string>(`http://127.0.0.1:${node.port}`, "eth_chainId", [])).toBe("0x1");
      expect(calls).toBe(3);
      [calls, limit.n] = [0, 3];
      expect((await patientFetch(`http://127.0.0.1:${node.port}`, { method: "POST", body: "{}" }, [10, 10])).status).toBe(429); // two waits, three tries
      expect(calls).toBe(3);
    } finally {
      node.stop(true);
    }
  }, 20_000);
});

// The mainnet check judged every token without a template index (a warn); a sentinel on real Base now
// builds it for each check over the 2 h before the check's block, on a node that serves logs (INDEX_RPC).
describe("the sentinel's template index, from its environment", () => {
  /** A Base-like node: five blocks a second, `head` mined so far, no pools; `logs: false` refuses eth_getLogs
   *  as mainnet.base.org does. */
  const fakeBase = (head: { n: number }, logs = true) => {
    const block = (n: number) => (n > head.n ? null : { number: toHex(n), timestamp: toHex(1_800_000_000 + Math.floor(n / 5)) });
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const { method, params } = (await req.json()) as { method: string; params: unknown[] };
        if (method === "eth_getLogs" && !logs) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "request limit reached" } });
        const result =
          method === "eth_chainId" ? "0x2105"
          : method === "eth_getBlockByNumber" ? block(params[0] === "latest" ? head.n : Number(params[0]))
          : method === "eth_getLogs" ? []
          : "0x";
        return Response.json({ jsonrpc: "2.0", id: 1, result });
      },
    });
  };
  test("no INDEX_FROM: from the last block 2 h before the check's, on INDEX_RPC, once that node has the block", async () => {
    const head = { n: 39_999 }; // the index node is one block behind the check's
    const node = fakeBase(head);
    const url = `http://127.0.0.1:${node.port}`;
    const lines: string[] = [];
    try {
      const ix = indexer({ EVM_RPC: "http://127.0.0.1:1", INDEX_RPC: url }, (l) => lines.push(l))!;
      expect(ix.rpc).toBe(url);
      setTimeout(() => (head.n = 40_000), 700);
      const index = await ix.build(40_000);
      expect([index.from, index.to]).toEqual([4_004, 40_000]); // 36,000 blocks is 7,200 s: the 5th block of that second
      const [ref, from, next] = await Promise.all([40_000, index.from, index.from + 1].map((n) => stampOf(url, toHex(n))));
      expect(windowProblem(ref, from, index.to)).toBeNull();
      expect(BigInt(next.timestamp)).toBeGreaterThan(BigInt(ref.timestamp) - BigInt(INDEX_SPAN_S)); // the narrowest window accepted
      expect(lines[0]).toMatch(/^template index of blocks 4004\.\.40000 on .*: 0 WETH pools, built in \d+ requests/);
    } finally {
      node.stop(true);
    }
  }, 20_000);
  test("INDEX_FROM=<block> fixes the start (the fork); INDEX_FROM=none: no index; INDEX_RPC defaults to EVM_RPC", async () => {
    const node = fakeBase({ n: 40_000 });
    const url = `http://127.0.0.1:${node.port}`;
    try {
      const ix = indexer({ EVM_RPC: url, INDEX_FROM: "100" })!;
      expect(ix.rpc).toBe(url);
      expect((await ix.build(40_000)).from).toBe(100);
      expect(indexer({ EVM_RPC: url, INDEX_FROM: "none" })).toBeNull();
    } finally {
      node.stop(true);
    }
  });
  test("a node that refuses eth_getLogs: the error names what the index needs", async () => {
    const node = fakeBase({ n: 40_000 }, false);
    try {
      await expect(indexer({ EVM_RPC: `http://127.0.0.1:${node.port}` })!.build(40_000)).rejects.toThrow(/request limit reached\): the template index needs a node that serves logs .* INDEX_RPC/);
    } finally {
      node.stop(true);
    }
  });
});

// A sentinel votes with the state of one chain on what the guard signs for one chain: both must be the
// chain this process is set for, or it would allow on Base Sepolia a token that is a trap on Base.
describe("the sentinel's chain", () => {
  test("a guard deployed before the chain was an init argument is a Base guard", () => {
    expect(chainProblem(undefined, 8453, 8453)).toBeNull();
    expect(chainProblem(8453, 8453, 8453)).toBeNull();
    expect(chainProblem(84532, 84532, 84532)).toBeNull();
  });
  test("refused: a node, a guard or a setting of another chain", () => {
    expect(chainProblem(84532, 8453, 84532)).toContain("node serves chain 8453");
    expect(chainProblem(8453, 84532, 84532)).toContain("guard signs for chain 8453");
    expect(chainProblem(undefined, 84532, 84532)).toContain("guard signs for chain 8453");
    expect(chainProblem(84532, 84532, 8453)).toContain("EVM_CHAIN_ID");
  });
});

// The sentinel compares the node's chain with the guard's at startup; a node can change behind its URL
// afterwards (anvil restarted on the same port, a provider's alias moved).
test("a check on a node that now serves another chain is refused before anything is simulated", async () => {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { id, method } = (await req.json()) as { id: number; method: string };
      calls.push(method);
      return Response.json({ jsonrpc: "2.0", id, ...(method === "eth_chainId" ? { result: "0x1" } : { error: { code: -32601, message: "Method not found" } }) });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const guard = "0x000000000000000000000000000000000000dEaD";
  const refused = `the EVM node serves chain 1, the guard signs for ${CHAIN_ID}: no check`;
  try {
    await expect(checkToken(url, token, guard, () => ({}) as never, {} as never)).rejects.toThrow(refused);
    await expect(checkExit(url, token, guard, 1n, async () => [])).rejects.toThrow(refused);
    expect(calls).toEqual(["eth_chainId", "eth_chainId"]);
  } finally {
    server.stop(true);
  }
});
