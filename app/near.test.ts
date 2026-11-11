// Un RPC qui accepte la connexion et ne repond jamais ne doit pas suspendre un role indefiniment.
import { expect, test } from "bun:test";

test("une vue NEAR sur un RPC muet echoue dans le delai", async () => {
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const saved = { ...process.env }; // bun partage process.env entre fichiers de test : on le rend intact
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

// Place apres le test precedent : celui-ci fixe NEAR_RPC avant le premier import de near.ts.
test("un fichier de cle est ecrit en 0600, neuf ou deja present en 0664", async () => {
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
