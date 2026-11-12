// The sentinel's decision on a request read: never skip a request merely absent from a lagging node;
// and its node calls through a public node's rate limit.
import { describe, expect, test } from "bun:test";
import type { Check } from "./near";
import { step } from "./sentinel";
import { rpc } from "./verifier";

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

// Batch 9: the later side reads 100 blocks of receipts from Base's public node, which answers HTTP 429
// to a burst; a check or a replay then failed on the first one.
describe("rpc: a public node's rate limit", () => {
  test("429 twice, then an answer: waited out (2 s, then 4 s); a fourth 429 is an error", async () => {
    let calls = 0;
    const limit = { n: 2 };
    const node = Bun.serve({ port: 0, fetch: () => (++calls <= limit.n ? new Response("{}", { status: 429 }) : Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })) });
    try {
      expect(await rpc<string>(`http://127.0.0.1:${node.port}`, "eth_chainId", [])).toBe("0x1");
      expect(calls).toBe(3);
      [calls, limit.n] = [0, 4];
      await expect(rpc(`http://127.0.0.1:${node.port}`, "eth_chainId", [])).rejects.toThrow("eth_chainId : 429");
      expect(calls).toBe(4);
    } finally {
      node.stop(true);
    }
  }, 20_000);
});
