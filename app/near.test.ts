// An RPC that accepts the connection and never answers must not hang a role indefinitely.
import { expect, test } from "bun:test";

test("a NEAR view on a silent RPC fails within the timeout", async () => {
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const saved = { ...process.env }; // bun shares process.env between test files: leave it intact
  try {
    process.env.NEAR_RPC = `http://127.0.0.1:${silent.port}`;
    process.env.RPC_TIMEOUT_MS = "300";
    process.env.GUARD = "guard.test";
    const { view } = await import("./near");
    const started = Date.now();
    await expect(view("last_check_id")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    for (const k of ["NEAR_RPC", "RPC_TIMEOUT_MS", "GUARD"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    silent.stop(true);
  }
}, 10_000);

// Judge pass 9: replay --check, the armer and the agent's wrapper failed on the NEAR RPC's rate limit.
// Every role's NEAR calls go through the process's fetch, which near.ts makes wait out a 429.
test("a NEAR RPC call through a rate limit (HTTP 429 twice): waited out, the same request resent", async () => {
  await import("./near");
  const bodies: string[] = [];
  const node = Bun.serve({ port: 0, fetch: async (req) => (bodies.push(await req.text()), bodies.length <= 2 ? new Response("", { status: 429 }) : Response.json({ jsonrpc: "2.0", id: 1, result: 1 })) });
  try {
    const res = await fetch(`http://127.0.0.1:${node.port}`, { method: "POST", body: '{"method":"send_tx"}' });
    expect(res.status).toBe(200);
    expect(bodies).toEqual(Array(3).fill('{"method":"send_tx"}')); // a transaction keeps its bytes, hence its hash
  } finally {
    node.stop(true);
  }
}, 10_000);

// Placed after the first test: that one sets NEAR_RPC before the first import of near.ts.
test("a key file is written as 0600, new or already present as 0664", async () => {
  const { mkdtemp, rm, stat, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { writeSecret } = await import("./near");
  const dir = await mkdtemp(`${tmpdir()}/goblin-`);
  try {
    await writeSecret(`${dir}/new`, "k");
    expect((await stat(`${dir}/new`)).mode & 0o777).toBe(0o600);
    await writeFile(`${dir}/old`, "x", { mode: 0o664 });
    await writeSecret(`${dir}/old`, "k");
    expect((await stat(`${dir}/old`)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true });
  }
});
