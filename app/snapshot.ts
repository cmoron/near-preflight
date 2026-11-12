// Snapshot of what the public pages read from the demo guard (docs/snapshot.json): public view results only.
// Usage: bun app/snapshot.ts > docs/snapshot.json   or   bun app/snapshot.ts docs/snapshot.json
// The pages render from it at once, then read only what changed since. Nothing is written unless every read worked.
import { writeFile } from "node:fs/promises";
import { env, type Check, type Entry, viewAt } from "./near";

const PAGE = 50, BATCH = 5;
let height = Infinity; // the oldest block any read came from: the snapshot is at least that fresh
async function v<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await viewAt<T>(method, args); // app/near.ts: timeout, and a 429 waited out then retried
  height = Math.min(height, r.height);
  return r.value;
}

export async function takeSnapshot() {
  const guard = env("GUARD");
  const taken_at = new Date().toISOString();
  const last = Number(await v("last_check_id"));
  const ids = Array.from({ length: last }, (_, i) => i + 1);
  const checks: Record<string, Check | null> = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map(async (id) => { checks[id] = await v<Check | null>("get_check", { id }); }));
  }
  const entries: [string, Entry][] = [];
  for (let n = PAGE; n === PAGE; ) {
    const page = await v<[string, Entry][]>("list_entries", { from_index: entries.length, limit: PAGE });
    entries.push(...page);
    n = page.length;
  }
  const agents: Record<string, { frozen: boolean; stopped_at: string | null }> = {};
  for (const a of [...new Set(Object.values(checks).flatMap((k) => (k ? [k.agent] : [])))].sort()) {
    agents[a] = { frozen: await v("is_frozen", { account: a }), stopped_at: await v("stopped_at", { account: a }) };
  }
  const snap = {
    guard, taken_at, block_height: height, last_check_id: last, checks, entries, agents,
    signing_since: await v("signing_since"), escrow: await v("escrow"), credits_total: await v("credits_total"),
    bounds: await v("bounds"), evm_config: await v("evm_config"),
  };
  // Checks are requested while we read: a snapshot that straddles two states would mislabel itself.
  if (Number(await v("last_check_id")) !== last) throw new Error("a check was requested while reading: run again");
  return { ...snap, block_height: height };
}

if (import.meta.main) {
  try {
    const text = JSON.stringify(await takeSnapshot(), null, 1) + "\n";
    if (process.argv[2]) await writeFile(process.argv[2], text);
    else process.stdout.write(text);
  } catch (e) {
    console.error("snapshot failed, nothing written:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
