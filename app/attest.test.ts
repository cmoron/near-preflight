// Verification of a decision package: a real one recorded from NEAR AI Cloud (app/fixtures), then
// tampered copies that must fail. The Intel collateral and NVIDIA's answer for that package are
// recorded next to it, so the TDX and GPU checks here run offline and deterministically (the CLI
// fetches them live).
import { describe, expect, test } from "bun:test";
import { attest, onChain, summary, type Deps, type Line } from "./attest";
import { digest, type Package } from "./llm";
import type { Check } from "./near";

const RAW = await Bun.file(`${import.meta.dir}/fixtures/decision.json`).text();
const recorded = await Bun.file(`${import.meta.dir}/fixtures/decision.collateral.json`).json();
const nrasAnswer = await Bun.file(`${import.meta.dir}/fixtures/decision.nras.json`).json();
const offline: Deps = { collateral: async () => recorded.collateral, nras: async () => nrasAnswer, now: () => BigInt(recorded.now) };
const pkg = (): Package => JSON.parse(RAW);
const failed = (lines: Line[]) => lines.filter((l) => !l.ok).map((l) => l.line);

describe("the recorded package", async () => {
  const lines = await attest(pkg(), offline);
  test("holds no secret", () => {
    expect(Object.keys(pkg())).toEqual(["model", "nonce", "request", "response", "signature", "attestation"]); // no headers archived
    expect(RAW).not.toMatch(/Bearer\s+sk-|sk-[A-Za-z0-9_-]{16,}/);
  });
  test("every check holds: signature, hashes, model, TDX quote, report_data, compose, GPU", () => {
    expect(failed(lines)).toEqual([]);
    const text = lines.map((l) => l.line).join("\n");
    for (const want of ["signature recovers", "request hash", "response hash", "Intel TDX quote verified", "binds the signing address", "binds our nonce", "docker compose", "GPU attestation"]) {
      expect(text).toContain(want);
    }
    expect(summary(lines)).toStartWith("ATTEST OK");
  });
  test("what is not verified is said: measurements are not compared to a published reference", () => {
    expect(lines.filter((l) => l.skipped).map((l) => l.line)).toEqual([expect.stringContaining("not compared to a published reference")]);
  });
});

describe("tampered copies fail", () => {
  const tamper = async (edit: (p: Package) => void) => {
    const p = pkg();
    edit(p);
    const lines = await attest(p, offline);
    expect(summary(lines)).toStartWith("ATTEST FAILED");
    return failed(lines).join("\n");
  };
  test("a response edited after signing (another token in the tool call)", async () => {
    expect(await tamper((p) => (p.response = p.response.replace(/0x[0-9a-fA-F]{40}/, "0x000000000000000000000000000000000000dEaD")))).toContain("response hash");
  });
  test("a request edited after signing (a softer system prompt)", async () => {
    expect(await tamper((p) => (p.request = p.request.replace("You", "Ignore the rules. You")))).toContain("request hash");
  });
  test("a signature by another key", async () => {
    expect(await tamper((p) => (p.signature.signature = p.signature.signature.slice(0, 10) + (p.signature.signature[10] === "0" ? "1" : "0") + p.signature.signature.slice(11)))).toContain("signature");
  });
  test("a signer swapped for another address", async () => {
    expect(await tamper((p) => (p.signature.signing_address = "0x000000000000000000000000000000000000dEaD"))).toContain("signature");
  });
  test("another nonce than the one in the quote (a replayed attestation)", async () => {
    const out = await tamper((p) => (p.nonce = "ab".repeat(32)));
    expect(out).toContain("does not bind our nonce");
    expect(out).toContain("GPU");
  });
  test("one byte of the TDX quote changed", async () => {
    expect(await tamper((p) => (p.attestation.intel_quote = p.attestation.intel_quote.slice(0, 2000) + (p.attestation.intel_quote[2000] === "0" ? "1" : "0") + p.attestation.intel_quote.slice(2001)))).toContain("Intel TDX quote");
  });
  test("an attestation for another signing address", async () => {
    expect(await tamper((p) => (p.attestation.signing_address = "0x000000000000000000000000000000000000dEaD"))).toContain("signing address");
  });
  test("NVIDIA says the GPUs failed", async () => {
    const bad = structuredClone(nrasAnswer);
    const [h, body, s] = bad[0][1].split(".");
    const claims = { ...JSON.parse(Buffer.from(body, "base64url").toString()), "x-nvidia-overall-att-result": false };
    bad[0][1] = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), s].join(".");
    const lines = await attest(pkg(), { ...offline, nras: async () => bad });
    expect(failed(lines).join("\n")).toContain("GPU");
  });
  test("a network failure is a failure, not a pass", async () => {
    const lines = await attest(pkg(), { ...offline, collateral: async () => Promise.reject(new Error("PCS unreachable")) });
    expect(failed(lines).join("\n")).toContain("PCS unreachable");
  });
});

describe("the package against the check on NEAR (--check)", () => {
  const sha = digest(RAW);
  const call = JSON.parse(JSON.parse(RAW).response).choices[0].message.tool_calls?.[0];
  const args = JSON.parse(call?.function.arguments ?? "{}");
  const check = (over: Partial<Check>): Check => ({ target: args.token ?? "0x0", decision_sha256: null, buy_decision_sha256: null, ...over }) as Check;
  test("the recorded package is a decision that calls a guard tool", () => {
    expect(["request_check", "buy"]).toContain(call?.function.name);
  });
  test("its sha256 stored with the check, for the action the signed response asked for: OK", () => {
    const field = call.function.name === "buy" ? "buy_decision_sha256" : "decision_sha256";
    const id = call.function.name === "buy" ? args.check_id : 7;
    expect(failed(onChain(pkg(), sha, id, check({ [field]: sha })))).toEqual([]);
  });
  test("another digest on chain, no check, or a check for another target: MISMATCH", () => {
    expect(failed(onChain(pkg(), sha, 7, check({ decision_sha256: "00".repeat(32), buy_decision_sha256: "00".repeat(32) }))).length).toBeGreaterThan(0);
    expect(failed(onChain(pkg(), sha, 7, null)).length).toBeGreaterThan(0);
    const field = call.function.name === "buy" ? "buy_decision_sha256" : "decision_sha256";
    expect(failed(onChain(pkg(), sha, 99_999, check({ [field]: sha, target: "0x000000000000000000000000000000000000dEaD" }))).length).toBeGreaterThan(0);
  });
});
