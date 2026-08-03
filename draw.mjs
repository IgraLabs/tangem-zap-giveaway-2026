#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Reproducible winner draw for the Igra × Tangem ZAP giveaway (2026).
//
// Picks 10 winners + the complete reserve order from the frozen
// `eligible_wallets.csv` (346 addresses) using a PUBLIC, VERIFIABLE source of
// randomness: a FUTURE Kaspa L1 block hash, selected by the canonical
// virtual-selected-parent-chain (VSPC) rule.
//
// ── Fairness model (commit → reveal) ────────────────────────────────────────
//   1. Freeze + commit. The eligibility list is frozen and its SHA-256 is
//      committed in `sha256.txt`, published BEFORE the beacon block exists. This
//      script re-verifies that hash and refuses to run on a tampered/malformed list.
//   2. Announce the beacon by DAA SCORE. The beacon is the FIRST confirmed VSPC
//      (virtual selected-parent chain) block with `daaScore >= BEACON_DAASCORE`.
//      - VSPC = GHOSTDAG's single canonical chain (one block per position), so the
//        selection is consensus-defined, not a convenient tie-break. It is resolved
//        by kaspad's `getVirtualChainFromBlock` RPC (see the `vspc-beacon` tool),
//        NOT by any REST endpoint (those lag the tip and have gaps).
//      - "First with daaScore >= target" (not "== target") because DAA scores skip.
//      - CONFIRMED = the block sits at least CONFIRMATION_DEPTH DAA below the sink
//        at read time. This depth plus independent-node comparison materially
//        reduces stale-chain and reorganization risk; a stale/lagging read fails to
//        "wait" and is caught by comparing two independent nodes.
//      The block hash is a proof-of-work output, unknown until mined. Igra cannot
//      choose the hash after committing to the target; miner influence would require
//      mining power and potentially sacrificing block rewards.
//   3. Seed (binds FOUR independent public inputs). "blake2b256" here means
//      BLAKE2b-512(x)[0:32] — the 512-bit digest truncated to 32 bytes, NOT
//      parameterized BLAKE2b-256 (see the helper note below):
//        seed = BLAKE2b-512(x)[0:32] where x = ( DOMAIN
//                         ‖ beacon_block_hash            (Kaspa PoW entropy)
//                         ‖ sha256(eligible_wallets.csv) (the exact frozen list)
//                         ‖ draw_script_git_commit )     (the exact algorithm)
//   4. Deterministic Fisher–Yates shuffle (seeded CSPRNG, rejection-sampled to
//      remove modulo bias) → ranks ALL 346 addresses. The first 10 are the winners;
//      ranks 11..346 are the complete reserve order (used, in rank order, if a winner does not claim).
//
// ── How the beacon is supplied to this script ───────────────────────────────
// This script does NOT resolve the Kaspa chain itself (Node cannot speak kaspad
// gRPC; the canonical resolver is the `vspc-beacon` Rust tool run against two
// independent kaspad nodes). Instead you pass it the RESOLVED, CONFIRMED beacon
// as verified inputs, and it re-checks the confirmation invariant before drawing:
//
//   BEACON_HASH=<64-hex>            # the VSPC beacon block hash (required)
//   BEACON_DAASCORE=<int>           # that block's daaScore  (must be >= target)
//   BEACON_BLUESCORE=<int>          # that block's blueScore (recorded in output)
//   SINK_DAASCORE=<int>             # sink daaScore at read time (for the depth gate)
//   DRAW_SCRIPT_COMMIT=<40-hex>     # git commit of this file at release (seed input)
//
//   node draw.mjs                   # prints winners + reserve order as JSON
//
// Reproduce: anyone re-resolves the beacon from BEACON_DAASCORE on their own
// kaspad (per REPRODUCE.md), then runs this script with the same inputs and the
// committed CSV — the full ranking is fixed by (DOMAIN, beacon hash, csv, commit).

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve data files relative to THIS script, not the current working directory,
// so `node /path/to/draw.mjs` from any CWD reads the committed CSV that ships
// beside it — never a same-named file that happens to sit in the caller's CWD.
const HERE = dirname(fileURLToPath(import.meta.url));

// ── Announced constants (fixed BEFORE the beacon block is mined) ────────────
export const DOMAIN            = 'tangem-igra-zap-2026-draw-v1'; // seed domain separator
export const BEACON_DAASCORE   = 514_900_000;   // announced target; beacon = first confirmed VSPC block with daaScore >= this
export const CONFIRMATION_DEPTH = 4_320;        // DAA the beacon must sit below the sink (~7 min @ 10 bps) to be usable
const WINNERS      = 10;
const CSV_PATH     = 'eligible_wallets.csv';
const SHA256_PATH  = 'sha256.txt';              // committed hashes (list-freeze)
const CSV_HEADER   = 'address';                 // required first line of the CSV
const HEX64        = /^[0-9a-f]{64}$/;          // 32-byte hex (block hash / sha256)
const HEX40        = /^[0-9a-f]{40}$/;          // 20-byte hex (git commit / EVM addr body)
const EVM_ADDR     = /^0x[0-9a-f]{40}$/;        // lowercased 20-byte address

// ── helpers (pure fns exported for offline tests; importing this module runs no draw) ──
export const sha256hex  = (buf) => createHash('sha256').update(buf).digest('hex');
// IMPORTANT: this is BLAKE2b-512 truncated to its first 32 bytes — written
// `BLAKE2b-512(x)[0:32]` — NOT parameterized BLAKE2b-256. The two differ:
// parameterized BLAKE2b-256 encodes the 32-byte output length in the IV, yielding
// a different digest. Node's built-in crypto only exposes blake2b512, so the
// committed operation is the truncation, and every published formula says so.
// To reproduce in another language, use BLAKE2b with 64-byte output and take the
// first 32 bytes (do NOT set digest_size=32).
export const blake2b512trunc32 = (buf) => createHash('blake2b512').update(buf).digest().subarray(0, 32);
// Back-compat alias (same bytes); prefer the explicit name above.
export const blake2b256 = blake2b512trunc32;

// Parse the "<hash>  <file>" commitment text → the committed hash for `file`.
// Matches on the EXACT path token, not a substring, so `draw.mjs` never
// accidentally matches `draw.test.mjs`/`x.draw.mjs`.
export function committedHashFor(sha256txt, file) {
  for (const line of sha256txt.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/); // shasum uses ' ' or ' *'
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return undefined;
}

// Verify a CSV buffer against its committed hash and parse the address list.
// Pure (no I/O). Throws on tamper OR any deviation from the expected shape
// (header, address format, dupes, sort) — never draw on a list we don't fully grok.
export function parseEligible(rawCsv, sha256txt, csvPath = CSV_PATH) {
  const actual = sha256hex(rawCsv);
  const committed = committedHashFor(sha256txt, csvPath);
  if (!committed) throw new Error(`no committed hash for ${csvPath} in commitment file`);
  if (actual !== committed) {
    throw new Error(`LIST TAMPERED: ${csvPath} sha256 ${actual} != committed ${committed}`);
  }
  const lines = rawCsv.toString('utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 2) throw new Error(`${csvPath}: expected a header + at least one address`);
  if (lines[0].trim().toLowerCase() !== CSV_HEADER) {
    throw new Error(`${csvPath}: first line must be the '${CSV_HEADER}' header, got '${lines[0]}'`);
  }
  const addrs = lines.slice(1).map((s) => s.trim().toLowerCase());
  addrs.forEach((a, i) => {
    if (!EVM_ADDR.test(a)) throw new Error(`${csvPath}: line ${i + 2} is not a 0x+40hex address: '${a}'`);
  });
  if (new Set(addrs).size !== addrs.length) throw new Error(`${csvPath}: contains duplicate addresses`);
  const sorted = [...addrs].sort();
  if (addrs.some((a, i) => a !== sorted[i])) {
    throw new Error(`${csvPath}: addresses are not lexicographically sorted (the committed canonical order)`);
  }
  return { addrs, csvHash: actual };
}

// Load + verify the frozen list from disk (from the script's own directory).
function loadEligible() {
  return parseEligible(readFileSync(join(HERE, CSV_PATH)), readFileSync(join(HERE, SHA256_PATH), 'utf8'), CSV_PATH);
}

// Derive the draw seed from the FOUR bound inputs. STRICT hex validation: a
// short/typo'd hex would be silently truncated by Buffer.from(...,'hex') → wrong
// seed with no error, which is fatal on the verification path.
//   seed = BLAKE2b-512( utf8(DOMAIN) ‖ beacon_hash ‖ csv_sha256 ‖ script_commit )[0:32]
export function deriveSeed(beaconHashHex, csvHashHex, scriptCommitHex, domain = DOMAIN) {
  const bh = String(beaconHashHex).toLowerCase();
  const ch = String(csvHashHex).toLowerCase();
  const gc = String(scriptCommitHex).toLowerCase();
  if (!HEX64.test(bh)) throw new Error(`beacon hash must be 64 hex chars, got '${beaconHashHex}'`);
  if (!HEX64.test(ch)) throw new Error(`csv sha256 must be 64 hex chars, got '${csvHashHex}'`);
  if (!HEX40.test(gc)) throw new Error(`draw script commit must be 40 hex chars (git sha1), got '${scriptCommitHex}'`);
  return blake2b256(Buffer.concat([
    Buffer.from(domain, 'utf8'),
    Buffer.from(bh, 'hex'),
    Buffer.from(ch, 'hex'),
    Buffer.from(gc, 'hex'),
  ]));
}

// Full deterministic ranking of ALL addresses (Fisher–Yates over the seeded RNG).
export function rankAll(addrs, seed32) {
  return shuffle(addrs, makeRng(seed32));
}
// Convenience: the first N of the ranking are the winners.
export function computeWinners(addrs, seed32, n = WINNERS) {
  return rankAll(addrs, seed32).slice(0, n);
}

// Validate the supplied beacon against the announced target + confirmation depth.
// Returns a normalized, confirmed beacon object; throws with a precise reason if
// the target isn't reached or the block isn't yet buried CONFIRMATION_DEPTH deep.
export function validateBeacon(
  { hash, daaScore, blueScore, sinkDaaScore },
  { target = BEACON_DAASCORE, depth = CONFIRMATION_DEPTH } = {},
) {
  const h = String(hash).toLowerCase();
  if (!HEX64.test(h)) throw new Error(`beacon hash must be 64 hex chars, got '${hash}'`);
  const daa = Number(daaScore), blue = Number(blueScore), sink = Number(sinkDaaScore);
  if (!Number.isSafeInteger(daa) || daa < 0) throw new Error(`BEACON_DAASCORE(block) must be a non-negative integer, got '${daaScore}'`);
  if (!Number.isSafeInteger(blue) || blue < 0) throw new Error(`BEACON_BLUESCORE must be a non-negative integer, got '${blueScore}'`);
  if (!Number.isSafeInteger(sink) || sink < 0) throw new Error(`SINK_DAASCORE must be a non-negative integer, got '${sinkDaaScore}'`);
  if (daa < target) {
    throw new Error(`beacon daaScore ${daa} < announced target ${target} — this is not the announced beacon`);
  }
  const gap = sink - daa;
  if (gap < depth) {
    throw new Error(`beacon NOT confirmed: sink ${sink} is only ${gap} DAA above the beacon (need >= ${depth}); wait for more depth`);
  }
  return { hash: h, daaScore: daa, blueScore: blue, sinkDaaScore: sink, confirmationGap: gap, depth, confirmed: true };
}

// PROVENANCE GATE (P2): prove the beacon is the real first-qualifying VSPC block by
// requiring >= 2 INDEPENDENT `vspc-beacon --json` attestations that AGREE. This
// closes the honor-system gap where a single supplied hash is trusted blindly.
// `atts` is an array of parsed vspc-beacon JSON objects. Throws unless:
//   - at least `minNodes` attestations are present,
//   - they come from DISTINCT rpc endpoints (independent nodes),
//   - every one is `confirmed:true` and targets the announced daaScore,
//   - they all agree on beacon_hash AND beacon_daa_score AND beacon_blue_score.
// Returns the agreed beacon (validated via validateBeacon against the min sink seen,
// so the depth gate uses the most conservative node).
export function crossCheckAttestations(atts, { target = BEACON_DAASCORE, depth = CONFIRMATION_DEPTH, minNodes = 2 } = {}) {
  if (!Array.isArray(atts) || atts.length < minNodes) {
    throw new Error(`beacon provenance: need >= ${minNodes} independent vspc-beacon attestations, got ${Array.isArray(atts) ? atts.length : 0}`);
  }
  const rpcs = new Set();
  for (const [i, a] of atts.entries()) {
    for (const k of ['rpc', 'beacon_hash', 'beacon_daa_score', 'beacon_blue_score', 'sink_daa_score', 'target', 'confirmed']) {
      if (a == null || a[k] === undefined) throw new Error(`attestation[${i}] missing field '${k}' (not a vspc-beacon --json output?)`);
    }
    if (a.confirmed !== true) throw new Error(`attestation[${i}] (rpc ${a.rpc}) is not confirmed`);
    if (Number(a.target) !== target) throw new Error(`attestation[${i}] target ${a.target} != announced ${target}`);
    if (rpcs.has(a.rpc)) throw new Error(`attestations not independent: duplicate rpc '${a.rpc}' — use two DIFFERENT nodes`);
    rpcs.add(a.rpc);
  }
  const h0 = String(atts[0].beacon_hash).toLowerCase();
  const daa0 = Number(atts[0].beacon_daa_score), blue0 = Number(atts[0].beacon_blue_score);
  for (const [i, a] of atts.entries()) {
    if (String(a.beacon_hash).toLowerCase() !== h0) throw new Error(`attestation[${i}] beacon_hash ${a.beacon_hash} disagrees with node 0 (${h0}) — nodes do not agree on the beacon`);
    if (Number(a.beacon_daa_score) !== daa0) throw new Error(`attestation[${i}] beacon_daa_score disagrees`);
    if (Number(a.beacon_blue_score) !== blue0) throw new Error(`attestation[${i}] beacon_blue_score disagrees`);
  }
  // Use the SMALLEST sink across nodes for the depth gate (most conservative).
  const minSink = Math.min(...atts.map((a) => Number(a.sink_daa_score)));
  const beacon = validateBeacon({ hash: h0, daaScore: daa0, blueScore: blue0, sinkDaaScore: minSink }, { target, depth });
  return { ...beacon, nodes: atts.length, rpcs: [...rpcs] };
}

// ── Seeded CSPRNG: hash-chain blake2b(seed ‖ counter) → uniform u32 stream ───
export function makeRng(seed32) {
  let ctr = 0n, pool = Buffer.alloc(0), off = 0;
  const refill = () => {
    const c = Buffer.alloc(8); c.writeBigUInt64BE(ctr++);
    pool = blake2b256(Buffer.concat([seed32, c])); off = 0;
  };
  return () => { // uniform 32-bit unsigned int
    if (off + 4 > pool.length) refill();
    const v = pool.readUInt32BE(off); off += 4; return v >>> 0;
  };
}
// Unbiased index in [0, n): rejection sampling on the u32 stream.
export function randBelow(rng, n) {
  const limit = Math.floor(0x1_0000_0000 / n) * n; // largest multiple of n <= 2^32
  let x; do { x = rng(); } while (x >= limit);
  return x % n;
}
// Deterministic Fisher–Yates (non-mutating).
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randBelow(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Read + validate a required env var against a regex; clear error if missing/bad.
function reqEnv(name, re, hint) {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`missing required env ${name} (${hint})`);
  if (re && !re.test(v.toLowerCase()) && !(re === INT && /^\d+$/.test(v))) {
    throw new Error(`env ${name}='${v}' is invalid (${hint})`);
  }
  return v;
}
const INT = /^\d+$/;

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const { addrs, csvHash } = loadEligible();

  // Resolve the beacon. PREFERRED (provenance-gated): BEACON_ATTESTATIONS points at
  // >= 2 independent `vspc-beacon --json` files; the draw proves they agree before
  // using them. FALLBACK: raw BEACON_* env vars (un-attested — honor-system; prints
  // a warning). The attested path makes two-node agreement the SOURCE of the beacon.
  let beacon, provenance;
  const attEnv = (process.env.BEACON_ATTESTATIONS ?? '').trim();
  if (attEnv) {
    const paths = attEnv.split(/[,\s]+/).filter(Boolean);
    const atts = paths.map((p) => {
      let raw;
      try { raw = readFileSync(p, 'utf8'); } catch (e) { throw new Error(`cannot read attestation '${p}': ${e.message}`); }
      try { return JSON.parse(raw); } catch (e) { throw new Error(`attestation '${p}' is not valid JSON (expect one line of vspc-beacon --json): ${e.message}`); }
    });
    const cc = crossCheckAttestations(atts, { target: BEACON_DAASCORE, depth: CONFIRMATION_DEPTH });
    beacon = cc;
    provenance = { mode: 'attested', nodes: cc.nodes, rpcs: cc.rpcs };
  } else {
    beacon = validateBeacon({
      hash:         reqEnv('BEACON_HASH', HEX64, '64-hex VSPC beacon block hash'),
      daaScore:     reqEnv('BEACON_DAASCORE', INT, "beacon block's daaScore, integer"),
      blueScore:    reqEnv('BEACON_BLUESCORE', INT, "beacon block's blueScore, integer"),
      sinkDaaScore: reqEnv('SINK_DAASCORE', INT, 'sink daaScore at read time, integer'),
    });
    provenance = { mode: 'unattested', nodes: 1, rpcs: [] };
    console.error('WARNING: beacon provenance is UN-ATTESTED (single supplied hash). For the real draw, set BEACON_ATTESTATIONS to >= 2 independent vspc-beacon --json outputs so the draw proves they agree.');
  }
  const scriptCommit = reqEnv('DRAW_SCRIPT_COMMIT', HEX40, '40-hex git commit of this script at release').toLowerCase();

  const seed = deriveSeed(beacon.hash, csvHash, scriptCommit);
  const ranking = rankAll(addrs, seed);
  const winners = ranking.slice(0, WINNERS);
  const reserve = ranking.slice(WINNERS); // complete reserve order, ranks 11..N

  const out = {
    event: 'Igra x Tangem ZAP Giveaway 2026 — winner draw',
    domain: DOMAIN,
    eligible_count: addrs.length,
    eligible_csv_sha256: csvHash,
    draw_script_commit: scriptCommit,
    beacon: {
      chain: 'kaspa-mainnet',
      rule: 'first confirmed VSPC block with daaScore >= announced_daascore (getVirtualChainFromBlock)',
      announced_daascore: BEACON_DAASCORE,
      block_hash: beacon.hash,
      block_daascore: beacon.daaScore,
      block_bluescore: beacon.blueScore,
      sink_daascore_at_read: beacon.sinkDaaScore,
      confirmation_depth: beacon.depth,
      confirmation_gap: beacon.confirmationGap,
      confirmed: beacon.confirmed,
      provenance: provenance.mode,          // 'attested' (>=2 agreeing nodes) or 'unattested'
      attesting_nodes: provenance.nodes,
      attesting_rpcs: provenance.rpcs,
    },
    seed_hex: seed.toString('hex'),
    method: 'seed = BLAKE2b-512(DOMAIN ‖ beacon_block_hash ‖ sha256(csv) ‖ draw_script_commit)[0:32] (512-bit digest truncated to 32 bytes, NOT parameterized BLAKE2b-256); Fisher-Yates (rejection-sampled); winners = first 10, reserve = ranks 11..N',
    winners_count: winners.length,
    winners,
    reserve_count: reserve.length,
    reserve_order: reserve,
  };
  console.log(JSON.stringify(out, null, 2));
  console.error(
    `\neligible=${addrs.length}  target_daa=${BEACON_DAASCORE}  beacon_daa=${beacon.daaScore}  gap=${beacon.confirmationGap}(>=${beacon.depth})  confirmed=${beacon.confirmed}  seed=${seed.toString('hex').slice(0,16)}…  winners=${winners.length}  reserve=${reserve.length}`
  );
}

// Run the draw only when executed directly, NOT when imported by the test file.
// realpath both sides: import.meta.url is realpath'd; on macOS/BSD /tmp,/var are
// symlinks, so a naive compare would silently skip main() (worst failure mode).
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (isDirectRun()) {
  try {
    await main();
  } catch (e) {
    console.error(`draw failed: ${e.message}`);
    process.exit(1);
  }
}

export { BEACON_DAASCORE as ANNOUNCED_DAASCORE, WINNERS };
