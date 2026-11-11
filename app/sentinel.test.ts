// Decision de la sentinelle sur une demande lue : jamais sauter une demande seulement absente d'un noeud en retard.
import { expect, test } from "bun:test";
import type { Check } from "./near";
import { step } from "./sentinel";

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
  signed_tx: null,
});

test("absente sur un noeud en retard sur last_check_id : relue au tour suivant, pas sautee", () => {
  expect(step(null, 99, 100)).toBe("retry");
});
test("absente au bloc de last_check_id ou apres : effacee par refund_check, sautee", () => {
  expect(step(null, 100, 100)).toBe("skip");
  expect(step(null, 101, 100)).toBe("skip");
});
test("sans verdict : jugee, quel que soit le noeud", () => {
  expect(step(check(null), 99, 100)).toBe("judge");
  expect(step(check(null), 100, 100)).toBe("judge");
});
test("deja jugee : sautee", () => {
  for (const v of ["allow", "warn", "block"] as const) expect(step(check(v), 100, 100)).toBe("skip");
});
