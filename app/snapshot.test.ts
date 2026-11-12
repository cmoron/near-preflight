// The pages' snapshot merge logic (docs/snapshot.js): which checks a page still has to read from NEAR.
import { expect, test } from "bun:test";
import "../docs/snapshot.js";

const S = (globalThis as any).Snapshot;
const T = Date.parse("2026-11-12T12:00:00Z") / 1000;
const ns = (s: number) => String(BigInt(s) * 1_000_000_000n);
const chk = (judgedAgo: number | null) => ({ verdict: judgedAgo === null ? null : "allow", judged_ns: ns(T - (judgedAgo ?? 0)) });
const snap = {
  guard: "g.testnet", taken_at: "2026-11-12T12:00:00Z", last_check_id: 4, entries: [["0xa", {}], ["0xb", {}], ["0xc", {}]],
  checks: { 1: chk(5000), 2: null, 3: chk(100), 4: chk(null) }, // final, refunded, judged 100 s before, still pending
  agents: { a: { frozen: true, stopped_at: null } }, bounds: {}, evm_config: {}, signing_since: null, escrow: "0", credits_total: "0",
};

test("staleIds: the new checks and the ones that were not final, nothing else", () => {
  expect(S.staleIds(snap, 4)).toEqual([4, 3]);
  expect(S.staleIds(snap, 6)).toEqual([6, 5, 4, 3]);
  expect(S.staleIds(snap, 6, new Set([5, 3]))).toEqual([6, 4]);
});

test("finals: only what could no longer change when the snapshot was taken", () => {
  expect([...S.finals(snap).keys()]).toEqual([1, 2]);
});

test("usable: another guard or a malformed file is ignored", () => {
  expect(S.usable(snap, "g.testnet")).toBe(snap);
  expect(S.usable(snap, "other.testnet")).toBeNull();
  expect(S.usable({ ...snap, taken_at: "nope" }, "g.testnet")).toBeNull();
  expect(S.usable({ guard: "g.testnet" }, "g.testnet")).toBeNull();
});

test("view answers like the contract, and refuses what it does not hold", () => {
  expect(S.view(snap, "last_check_id")).toBe(4);
  expect(S.view(snap, "get_check", { id: 2 })).toBeNull();
  expect(S.view(snap, "list_entries", { from_index: 2, limit: 50 })).toEqual([["0xc", {}]]);
  expect(S.view(snap, "is_frozen", { account: "a" })).toBe(true);
  expect(() => S.view(snap, "is_frozen", { account: "b" })).toThrow();
});
