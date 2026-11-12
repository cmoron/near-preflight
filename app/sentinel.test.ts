// The sentinel's decision on a request read: never skip a request merely absent from a lagging node;
// and its node calls through a public node's rate limit.
import { describe, expect, test } from "bun:test";
import { toHex } from "viem";
import { INDEX_SPAN_S, windowProblem } from "./index";
import type { Check } from "./near";
import { indexer, step } from "./sentinel";
import { patientFetch, rpc, stampOf } from "./verifier";

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
test("without a verdict: judged, whatever the node", () => {
  expect(step(check(null), 99, 100)).toBe("judge");
  expect(step(check(null), 100, 100)).toBe("judge");
});
test("already judged: skipped", () => {
  for (const v of ["allow", "warn", "block"] as const) expect(step(check(v), 100, 100)).toBe("skip");
});
// The quorum: a sentinel votes while its vote can still count.
describe("two sentinels, both needed", () => {
  const voted = (by: string, verdict: "allow" | "block", decided: Check["verdict"]): Check => ({ ...check(decided), votes: [{ sentinel: by, verdict, evidence_sha256: "" }] });
  test("the other sentinel's allow is in, the check undecided: judged", () => expect(step(voted("s1.test", "allow", null), 100, 100, "s2.test", 2)).toBe("judge"));
  test("my own vote is in: skipped", () => expect(step(voted("s2.test", "allow", null), 100, 100, "s2.test", 2)).toBe("skip"));
  test("the other sentinel blocked: judged, a block lists only with the quorum", () => expect(step(voted("s1.test", "block", "block"), 100, 100, "s2.test", 2)).toBe("judge"));
  test("both voted: skipped", () => {
    const both: Check = { ...check("allow"), votes: ["s1.test", "s3.test"].map((sentinel) => ({ sentinel, verdict: "allow" as const, evidence_sha256: "" })) };
    expect(step(both, 100, 100, "s2.test", 2)).toBe("skip");
  });
  test("an exit quote takes one vote: skipped once another sentinel posted it", () => {
    expect(step({ ...voted("s1.test", "allow", "allow"), exit_amount: "5" }, 100, 100, "s2.test", 2)).toBe("skip");
    expect(step({ ...check(null), exit_amount: "5" }, 100, 100, "s2.test", 2)).toBe("judge");
  });
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
