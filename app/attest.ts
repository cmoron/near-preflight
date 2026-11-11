// Verifies one decision package of the agent's model (app/llm.ts), then, with --check, ties it to the
// action on NEAR that carries its sha256.
// Verified cryptographically, here: the EIP-191 signature recovers the signing address; the signed
// text is `model:sha256(request):sha256(response)` for the exact bytes archived; the Intel TDX quote
// verifies (DCAP, @phala/dcap-qvl-node as in nearai-cloud-verifier, collateral from Intel PCS); its
// report_data binds that signing address and our nonce; the docker compose in the report is the one
// measured in the quote (mr_config_id). Taken on trust: NVIDIA's NRAS verdict on the GPU evidence
// (fetched over TLS, its JWT signature not checked, as in the official verifiers), Intel's PCS
// collateral, and that the measured code is what it claims (no published reference to compare to).
// With --check, the package is tied to check <id> on the guard: its sha256 is stored there, the signed
// response asked for that action, and the signed request names that guard, the check's agent and a NEAR
// block at most 600 s before the check was requested (a package cannot be re-anchored on another guard).
// Usage: bun [--env-file=.env] app/attest.ts <package.json> [--check <id>]   (--check reads GUARD)
import { js_get_collateral, js_verify } from "@phala/dcap-qvl-node";
import { recoverMessageAddress, sha256, type Hex } from "viem";
import { BINDING, digest, type Package } from "./llm";
import type { Check } from "./near";

export type Line = { ok: boolean; skipped?: boolean; line: string };
/** Remote facts the checks need; the tests pass recorded ones. */
export type Deps = { collateral: (quote: Uint8Array) => Promise<unknown>; nras: (payload: string) => Promise<unknown>; now: () => bigint };
export const live: Deps = {
  collateral: (quote) => js_get_collateral("https://api.trustedservices.intel.com/tdx/certification/v4", quote),
  nras: async (payload) => {
    const r = await fetch("https://nras.attestation.nvidia.com/v3/attest/gpu", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: payload });
    if (!r.ok) throw new Error(`NVIDIA NRAS: HTTP ${r.status}`);
    return r.json();
  },
  now: () => BigInt(Math.floor(Date.now() / 1000)),
};

const line = (ok: boolean, text: string, skipped = false): Line => ({ ok, skipped, line: `${skipped ? "SKIPPED " : ok ? "OK      " : "MISMATCH"} ${text}` });
const hashOf = (s: string) => sha256(new TextEncoder().encode(s)).slice(2);
const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

export async function attest(p: Package, deps: Deps = live): Promise<Line[]> {
  const out: Line[] = [];
  const signer = p.signature.signing_address.toLowerCase();
  // 1. signature
  const recovered = await recoverMessageAddress({ message: p.signature.text, signature: p.signature.signature as Hex }).catch(() => null);
  const sigOk = recovered?.toLowerCase() === signer;
  out.push(line(sigOk, sigOk ? `signature recovers the signing address ${signer} (EIP-191)` : `signature recovers ${recovered ?? "nothing"}, not the signing address ${signer}`));
  // 2. signed text: model, request and response hashes
  const [model, reqHash, resHash] = p.signature.text.split(":");
  const req = (() => {
    try {
      return JSON.parse(p.request) as { model?: string; stream?: boolean };
    } catch {
      return {};
    }
  })();
  const modelOk = p.signature.text.split(":").length === 3 && model === p.model && req.model === p.model && req.stream === false;
  out.push(line(modelOk, modelOk ? `signed by the model itself for ${model}, the canonical name requested, non-streaming` : `signed text names ${model}, request asks ${req.model} (stream ${req.stream}): not a model signature of this request`));
  out.push(line(hashOf(p.request) === reqHash, `request hash ${reqHash?.slice(0, 12)}... ${hashOf(p.request) === reqHash ? "matches" : "differs from"} sha256 of the archived request`));
  out.push(line(hashOf(p.response) === resHash, `response hash ${resHash?.slice(0, 12)}... ${hashOf(p.response) === resHash ? "matches" : "differs from"} sha256 of the archived response`));
  // 3. TDX quote, then what it binds
  const a = p.attestation;
  const addrOk = a.signing_address.toLowerCase() === signer;
  out.push(line(addrOk, addrOk ? `attestation is for the signing address ${short(signer)}` : `attestation is for ${a.signing_address}, not the signing address ${signer}`));
  let td = null as { report_data: string; mr_config_id: string } | null;
  try {
    const quote = Buffer.from(a.intel_quote, "hex");
    const r = js_verify(quote, await deps.collateral(quote), deps.now()) as { status: string; report: { TD10?: typeof td; TD15?: typeof td } };
    // As the official verifier: UpToDate, or OutOfDate (platform below the latest TCB, quote still valid).
    const statusOk = r.status === "UpToDate" || r.status === "OutOfDate";
    td = statusOk ? (r.report.TD10 ?? r.report.TD15 ?? null) : null;
    out.push(line(statusOk && !!td, `Intel TDX quote verified (DCAP, collateral from Intel PCS): TCB status ${r.status}`));
  } catch (e) {
    out.push(line(false, `Intel TDX quote not verified: ${why(e)}`));
  }
  const rd = td?.report_data.toLowerCase() ?? "";
  const wantAddr = signer.slice(2).padEnd(64, "0");
  out.push(line(!!td && rd.slice(0, 64) === wantAddr, td ? `report_data of the verified quote ${rd.slice(0, 64) === wantAddr ? "binds" : "does not bind"} the signing address` : "report_data binds the signing address: no verified quote"));
  out.push(line(!!td && rd.slice(64, 128) === p.nonce.toLowerCase(), td ? `report_data of the verified quote ${rd.slice(64, 128) === p.nonce.toLowerCase() ? "binds our nonce" : "does not bind our nonce"} ${p.nonce.slice(0, 12)}...` : "report_data binds our nonce: no verified quote"));
  const tcb = typeof a.info?.tcb_info === "string" ? JSON.parse(a.info.tcb_info) : a.info?.tcb_info;
  const compose: string = tcb?.app_compose ?? "";
  const composeHash = hashOf(compose);
  const images = [...new Set(compose.match(/@sha256:[0-9a-f]{64}/g) ?? [])].map((d) => d.slice(8, 20));
  const composeOk = !!td && !!compose && td.mr_config_id.toLowerCase().startsWith(`01${composeHash}`);
  out.push(line(composeOk, `docker compose ${composeOk ? "is the one measured in the verified quote" : "is not the one measured in the quote"} (mr_config_id = 01 + sha256 ${composeHash.slice(0, 12)}...), images ${images.join(", ") || "none"}`));
  // 4. GPU evidence, judged by NVIDIA
  try {
    const payload = JSON.parse(a.nvidia_payload) as { nonce: string };
    const [[, overall], gpus] = (await deps.nras(a.nvidia_payload)) as [[string, string], Record<string, string>];
    const all = claims(overall);
    const each = Object.values(gpus).map(claims);
    const ok = payload.nonce.toLowerCase() === p.nonce.toLowerCase() && all["x-nvidia-overall-att-result"] === true && each.length > 0 && each.every((g) => g.measres === "success" && g["x-nvidia-gpu-attestation-report-nonce-match"] === true);
    out.push(line(ok, `GPU attestation: NVIDIA NRAS verdict ${all["x-nvidia-overall-att-result"]} for ${each.length} GPU(s) ${each[0]?.hwmodel ?? ""}, evidence nonce ${payload.nonce.toLowerCase() === p.nonce.toLowerCase() ? "= our nonce" : "is not our nonce"}`));
  } catch (e) {
    out.push(line(false, `GPU attestation not verified: ${why(e)}`));
  }
  out.push(line(true, "measurements (MRTD, RTMRs, compose images) not compared to a published reference: none is published", true));
  return out;
}

/** The package's sha256 against check #id read on the guard: stored as the decision of request_check
 *  or of buy, anchored by the guard on that check alone (`anchored`: decision_of, the check the guard
 *  says this digest backs; it refuses a digest twice), and the signed response asked for that very
 *  action. */
export function onChain(p: Package, sha: string, id: number, check: Check | null, anchored: string | null): Line[] {
  if (!check) return [line(false, `check #${id} not found on the guard`)];
  const kind = check.decision_sha256 === sha ? "request_check" : check.buy_decision_sha256 === sha ? "buy" : null;
  if (!kind) return [line(false, `check #${id} carries ${check.decision_sha256 ?? "no digest"} (request_check) and ${check.buy_decision_sha256 ?? "no digest"} (buy), not this package's sha256 ${sha}`)];
  const out = [line(true, `check #${id} on the guard carries this package's sha256 ${sha.slice(0, 12)}... as the decision of its ${kind}`)];
  const alone = anchored === String(id);
  out.push(line(alone, alone ? `the guard anchors this decision on check #${id} alone (it refuses a digest already anchored)` : `the guard anchors this decision on ${anchored ? `check #${anchored}` : "no check"}, not #${id}`));
  const calls = (JSON.parse(p.response).choices?.[0]?.message?.tool_calls ?? []) as { function: { name: string; arguments: string } }[];
  const asked = calls.map((c) => ({ name: c.function.name, args: JSON.parse(c.function.arguments || "{}") }));
  const match = asked.find((c) => c.name === kind && (kind === "buy" ? Number(c.args.check_id) === id : String(c.args.token).toLowerCase() === check.target.toLowerCase()));
  out.push(line(!!match, match ? `the signed response asked for ${kind}(${kind === "buy" ? `#${id}` : check.target}), the action on chain` : `the signed response asked for ${asked.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "nothing"}, not ${kind} of check #${id} (${check.target})`));
  return out;
}

/** How long before its check's request the NEAR block a decision cites may be. */
const FRESH_S = 600n;
/** A NEAR block by hash: its time and height (the CLI asks the NEAR RPC; the tests pass fixed ones). */
export type NearBlock = (hash: string) => Promise<{ timestamp_ns: bigint; height: number }>;

/** The signed request must name the guard checked, the check's agent and a NEAR block at most FRESH_S
 *  before the check was requested (never after): then the package was written for this check, not
 *  replayed onto another guard, another agent or a later check. */
export async function bound(p: Package, id: number, check: Check, guard: string, block: NearBlock): Promise<Line[]> {
  const messages = (JSON.parse(p.request) as { messages?: { role: string; content: string | null }[] }).messages ?? [];
  const m = (messages.find((x) => x.role === "system")?.content ?? "").match(BINDING);
  if (!m) return [line(false, "the signed request names no guard, agent and NEAR block: it could be anchored on any check")];
  const [, g, a, hash, height] = m;
  const who = g === guard && a === check.agent;
  const out = [line(who, `the signed request names guard ${g} and agent ${a}${who ? `: the guard checked and check #${id}'s agent` : `, not ${guard} and ${check.agent}`}`)];
  try {
    const b = await block(hash);
    const requested = BigInt(check.requested_ns);
    const age = (requested - b.timestamp_ns) / 1_000_000_000n;
    const fresh = b.height === Number(height) && b.timestamp_ns <= requested && age <= FRESH_S;
    out.push(line(fresh, `the signed request cites NEAR block ${hash.slice(0, 8)}... (height ${b.height}${b.height === Number(height) ? "" : `, not ${height}`}), ${age} s before check #${id} was requested (at most ${FRESH_S} s, never after)`));
  } catch (e) {
    out.push(line(false, `NEAR block ${hash} cited by the signed request not found: ${why(e)}`));
  }
  return out;
}

export function summary(lines: Line[]): string {
  const bad = lines.filter((l) => !l.ok).length;
  const skipped = lines.filter((l) => l.skipped).length;
  return bad ? `ATTEST FAILED: ${bad} check(s) not confirmed` : `ATTEST OK: ${lines.length - skipped} checks hold${skipped ? ` (${skipped} not verified, see SKIPPED)` : ""}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--check");
  const id = at >= 0 ? Number(args.splice(at, 2)[1]) : null;
  const [file] = args;
  if (!file || (at >= 0 && !Number.isInteger(id))) {
    console.error("usage: bun [--env-file=.env] app/attest.ts <package.json> [--check <id>]");
    process.exit(2);
  }
  const raw = await Bun.file(file).bytes();
  const sha = digest(raw);
  const pkg = JSON.parse(new TextDecoder().decode(raw)) as Package;
  console.log(`decision package ${file}: sha256 ${sha}, model ${pkg.model}, nonce ${pkg.nonce.slice(0, 12)}...`);
  const lines = await attest(pkg);
  if (id !== null) {
    const { env, view } = await import("./near");
    const check = await view<Check | null>("get_check", { id }).catch((e) => (lines.push(line(false, `get_check(${id}) on ${env("GUARD")} failed: ${why(e)}`)), null));
    const anchored = check ? await view<string | null>("decision_of", { decision_sha256: sha }).catch((e) => (lines.push(line(false, `decision_of on ${env("GUARD")} failed: ${why(e)}`)), null)) : null;
    if (lines.at(-1)?.ok !== false || check) lines.push(...onChain(pkg, sha, id, check, anchored).map((l) => ({ ...l, line: l.line.replace("the guard", env("GUARD")) })));
    if (check) {
      const { provider } = await import("./near");
      const nearBlock: NearBlock = async (hash) => {
        const { header } = await provider.viewBlock({ blockId: hash });
        return { timestamp_ns: BigInt(header.timestamp_nanosec), height: header.height };
      };
      lines.push(...(await bound(pkg, id, check, env("GUARD"), nearBlock)));
    }
  }
  for (const l of lines) console.log(l.line);
  console.log(summary(lines));
  process.exit(lines.every((l) => l.ok) ? 0 : 1);
}
