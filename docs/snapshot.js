'use strict';
// Pure helpers for docs/snapshot.json (written by app/snapshot.ts), shared by the landing page and the journal;
// tested by app/snapshot.test.ts. A snapshot is never presented as live: the pages label it and read what can have changed.
(function (root) {
  const FINAL_S = 900; // as app.js: a check judged this long ago no longer changes
  const secs = (ns) => Number(BigInt(ns) / 1000000000n);
  const takenS = (snap) => Date.parse(snap.taken_at) / 1000;
  // Can no longer change as of `atSec`: refunded (null), or judged more than FINAL_S before.
  const isFinal = (k, atSec) => !k || (!!k.verdict && atSec - secs(k.judged_ns) > FINAL_S);
  // The snapshot, if it is of this guard and well formed; else null (the page then behaves as without one).
  function usable(snap, guard) {
    const ok = snap && snap.guard === guard && Number.isInteger(Number(snap.last_check_id)) && snap.checks && Array.isArray(snap.entries)
      && snap.agents && snap.bounds && snap.evm_config && !Number.isNaN(takenS(snap));
    return ok ? snap : null;
  }
  // The ids to read from NEAR, given the live last id: the ones newer than the snapshot, and the older ones that
  // were not final when it was taken. `known`: ids already final elsewhere (this page's cache).
  function staleIds(snap, last, known = new Set()) {
    const ids = [];
    for (let id = last; id >= 1; id--) {
      if (known.has(id)) continue;
      if (id <= Number(snap.last_check_id) && isFinal(snap.checks[id] ?? null, takenS(snap))) continue;
      ids.push(id);
    }
    return ids;
  }
  // The snapshot's final checks by id (to seed a page's cache).
  function finals(snap) {
    const m = new Map();
    for (let id = 1; id <= Number(snap.last_check_id); id++) {
      const k = snap.checks[id] ?? null;
      if (isFinal(k, takenS(snap))) m.set(id, k);
    }
    return m;
  }
  // Answers a view call from the snapshot, as the contract would; throws for what it does not hold.
  function view(snap, method, args = {}) {
    switch (method) {
      case 'last_check_id': return Number(snap.last_check_id);
      case 'get_check': return snap.checks[args.id] ?? null;
      case 'list_entries': return snap.entries.slice(args.from_index, args.from_index + args.limit);
      case 'is_frozen': case 'stopped_at': {
        const a = snap.agents[args.account];
        if (!a) throw new Error('agent ' + args.account + ' is not in the snapshot');
        return method === 'is_frozen' ? a.frozen : a.stopped_at;
      }
      case 'signing_since': case 'escrow': case 'credits_total': case 'bounds': case 'evm_config': return snap[method];
      default: throw new Error('snapshot has no ' + method);
    }
  }
  const utc = (snap) => new Date(takenS(snap) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  root.Snapshot = { FINAL_S, isFinal, usable, staleIds, finals, view, utc };
})(typeof window !== 'undefined' ? window : globalThis);
