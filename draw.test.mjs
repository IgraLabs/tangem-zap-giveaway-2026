#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Tests for draw.mjs — the winner-draw mechanism (VSPC-daaScore beacon).
//
// Zero dependencies: Node's built-in test runner + assert (node v18+).
//   node --test              # runs *.test.mjs (all offline & deterministic)
//   node --test draw.test.mjs
//
// draw.mjs is side-effect-free on import (the draw runs only under an isMain
// guard), and it no longer resolves the Kaspa chain itself — the beacon is
// supplied as verified inputs — so the whole suite is offline: no network at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  sha256hex, blake2b256, blake2b512trunc32, committedHashFor, parseEligible,
  deriveSeed, rankAll, computeWinners, makeRng, randBelow, shuffle,
  validateBeacon, crossCheckAttestations,
  DOMAIN, BEACON_DAASCORE, CONFIRMATION_DEPTH, ANNOUNCED_DAASCORE, WINNERS,
} from './draw.mjs';

// Fixed test vector: the real Kaspa mainnet VSPC block resolved in the
// vspc-beacon test (daaScore 501,752,006, blueScore 499,833,675). Past block →
// hash is public; fine for tests. The real draw uses the future announced beacon.
const VEC_HASH = '413b3d83f204f3e36024592f707a4a8bf29ab7371a79379e5d885a6da7654154';
const VEC_DAA  = 501_752_006;
const VEC_BLUE = 499_833_675;
const VEC_SINK = 502_833_219;              // sink at read time (>> daa+depth → confirmed)
const COMMIT   = 'a'.repeat(40);           // stand-in 40-hex git commit
const CSV  = readFileSync(new URL('./eligible_wallets.csv', import.meta.url));
const SHA  = readFileSync(new URL('./sha256.txt', import.meta.url), 'utf8');

// ── hash primitives ─────────────────────────────────────────────────────────
test('sha256hex matches a known vector', () => {
  assert.equal(sha256hex(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('blake2b256 is BLAKE2b-512 truncated to 32 bytes', () => {
  const d = blake2b256(Buffer.from('abc'));
  assert.equal(d.length, 32);
  assert.deepEqual(d, createHash('blake2b512').update(Buffer.from('abc')).digest().subarray(0, 32));
});

// ── commitment parsing + tamper detection ────────────────────────────────────
test('committedHashFor extracts the hash for a file from sha256.txt', () => {
  const h = committedHashFor(SHA, 'eligible_wallets.csv');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, sha256hex(CSV));
});

test('committedHashFor matches the EXACT path token, not a substring', () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64);
  const txt = `${A}  xdraw.mjs.orig\n${B}  draw.mjs`;
  assert.equal(committedHashFor(txt, 'draw.mjs'), B);
  assert.equal(committedHashFor(txt, 'nope.txt'), undefined);
});

test('committedHashFor accepts the shasum binary-mode " *" separator', () => {
  const A = 'a'.repeat(64);
  assert.equal(committedHashFor(`${A} *eligible_wallets.csv`, 'eligible_wallets.csv'), A);
});

test('parseEligible accepts the committed CSV and returns lowercase addresses', () => {
  const { addrs, csvHash } = parseEligible(CSV, SHA);
  assert.equal(csvHash, sha256hex(CSV));
  assert.equal(addrs.length, 346);
  assert.ok(addrs.every((a) => /^0x[0-9a-f]{40}$/.test(a)));
  assert.ok(!addrs.includes('address'));
  assert.equal(new Set(addrs).size, addrs.length);
});

test('parseEligible REFUSES a tampered CSV (one byte flipped)', () => {
  const bad = Buffer.from(CSV); bad[bad.length - 1] ^= 0x01;
  assert.throws(() => parseEligible(bad, SHA), /LIST TAMPERED/);
});

test('parseEligible throws when the file has no committed hash', () => {
  assert.throws(() => parseEligible(CSV, 'deadbeef  some_other_file\n'), /no committed hash/);
});

// CSV shape checks (hash always matches here → isolates the shape validation).
const csvBuf = (body) => Buffer.from(body);
const shaFor = (buf, name = 'eligible_wallets.csv') => `${sha256hex(buf)}  ${name}\n`;

test('parseEligible rejects a missing/wrong header', () => {
  const b = csvBuf('0x' + '1'.repeat(40) + '\n' + '0x' + '2'.repeat(40) + '\n');
  assert.throws(() => parseEligible(b, shaFor(b)), /header/);
});

test('parseEligible rejects a malformed address line', () => {
  const b = csvBuf('address\n0x' + '1'.repeat(40) + '\nnot-an-address\n');
  assert.throws(() => parseEligible(b, shaFor(b)), /not a 0x\+40hex address/);
});

test('parseEligible rejects duplicate addresses', () => {
  const a = '0x' + 'a'.repeat(40);
  const b = csvBuf(`address\n${a}\n${a}\n`);
  assert.throws(() => parseEligible(b, shaFor(b)), /duplicate/);
});

test('parseEligible rejects an unsorted list', () => {
  const hi = '0x' + 'f'.repeat(40), lo = '0x' + '1'.repeat(40);
  const b = csvBuf(`address\n${hi}\n${lo}\n`);
  assert.throws(() => parseEligible(b, shaFor(b)), /not lexicographically sorted/);
});

test('parseEligible accepts a clean sorted CRLF list and normalizes case', () => {
  const a1 = '0x' + '1'.repeat(40), a2 = '0x' + '2'.repeat(40);
  const b = csvBuf(`address\r\n${a1.toUpperCase()}\r\n${a2}\r\n`);
  const { addrs } = parseEligible(b, shaFor(b));
  assert.deepEqual(addrs, [a1, a2]);
});

// ── deriveSeed: FOUR-input binding + strict hex validation ────────────────────
test('deriveSeed binds domain + beacon + csv + commit (all four matter)', () => {
  const base = deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT);
  assert.equal(base.length, 32);
  // changing ANY input changes the seed
  assert.notDeepEqual(base, deriveSeed(VEC_HASH.slice(0, -1) + (VEC_HASH.endsWith('4') ? '5' : '4'), sha256hex(CSV), COMMIT));
  assert.notDeepEqual(base, deriveSeed(VEC_HASH, sha256hex(Buffer.concat([CSV, Buffer.from('x')])), COMMIT));
  assert.notDeepEqual(base, deriveSeed(VEC_HASH, sha256hex(CSV), 'b'.repeat(40)));
  assert.notDeepEqual(base, deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT, 'different-domain'));
});

test('deriveSeed rejects a non-64-hex beacon hash (no silent truncation)', () => {
  const ch = sha256hex(CSV);
  assert.throws(() => deriveSeed('deadbeef', ch, COMMIT), /beacon hash must be 64 hex/);
  assert.throws(() => deriveSeed(VEC_HASH.slice(0, 63), ch, COMMIT), /beacon hash must be 64 hex/);
  assert.throws(() => deriveSeed('Z'.repeat(64), ch, COMMIT), /beacon hash must be 64 hex/);
});

test('deriveSeed rejects a non-64-hex csv hash and a non-40-hex commit', () => {
  assert.throws(() => deriveSeed(VEC_HASH, 'nope', COMMIT), /csv sha256 must be 64 hex/);
  assert.throws(() => deriveSeed(VEC_HASH, sha256hex(CSV), 'short'), /draw script commit must be 40 hex/);
  assert.throws(() => deriveSeed(VEC_HASH, sha256hex(CSV), 'g'.repeat(40)), /draw script commit must be 40 hex/);
});

test('deriveSeed normalizes UPPERCASE hex and is stable', () => {
  assert.deepEqual(
    deriveSeed(VEC_HASH.toUpperCase(), sha256hex(CSV).toUpperCase(), COMMIT.toUpperCase()),
    deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT));
});

// ── validateBeacon: target + confirmation-depth gate ──────────────────────────
const beac = (over = {}) => ({ hash: VEC_HASH, daaScore: VEC_DAA, blueScore: VEC_BLUE, sinkDaaScore: VEC_SINK, ...over });

test('validateBeacon accepts a confirmed beacon at/above target', () => {
  const v = validateBeacon(beac(), { target: VEC_DAA, depth: CONFIRMATION_DEPTH });
  assert.equal(v.confirmed, true);
  assert.equal(v.hash, VEC_HASH);
  assert.equal(v.confirmationGap, VEC_SINK - VEC_DAA);
});

test('validateBeacon REFUSES when beacon daaScore < target', () => {
  assert.throws(() => validateBeacon(beac({ daaScore: VEC_DAA - 1 }), { target: VEC_DAA }),
    /< announced target/);
});

test('validateBeacon REFUSES when not buried deep enough (gap < depth)', () => {
  assert.throws(() => validateBeacon(beac({ sinkDaaScore: VEC_DAA + 100 }), { target: VEC_DAA, depth: 4320 }),
    /NOT confirmed/);
});

test('validateBeacon boundary: gap exactly == depth is CONFIRMED', () => {
  const v = validateBeacon(beac({ sinkDaaScore: VEC_DAA + 4320 }), { target: VEC_DAA, depth: 4320 });
  assert.equal(v.confirmed, true);
  assert.equal(v.confirmationGap, 4320);
});

test('validateBeacon rejects malformed hash / non-integer scores', () => {
  assert.throws(() => validateBeacon(beac({ hash: 'xyz' }), { target: VEC_DAA }), /beacon hash must be 64 hex/);
  assert.throws(() => validateBeacon(beac({ daaScore: 'NaN' }), { target: VEC_DAA }), /must be a non-negative integer/);
  assert.throws(() => validateBeacon(beac({ sinkDaaScore: -5 }), { target: VEC_DAA }), /must be a non-negative integer/);
});

// ── crossCheckAttestations: the two-node PROVENANCE gate (P2) ──────────────────
// A vspc-beacon --json output shape, all agreeing by default.
const att = (over = {}) => ({
  rpc: 'grpc://node-a:16110', target: VEC_DAA,
  beacon_hash: VEC_HASH, beacon_daa_score: VEC_DAA, beacon_blue_score: VEC_BLUE,
  sink_daa_score: VEC_SINK, confirmed: true, ...over,
});
const OPT = { target: VEC_DAA, depth: CONFIRMATION_DEPTH };

test('crossCheckAttestations accepts >=2 INDEPENDENT agreeing confirmed nodes', () => {
  const r = crossCheckAttestations([att(), att({ rpc: 'grpc://node-b:16110', sink_daa_score: VEC_SINK - 500 })], OPT);
  assert.equal(r.confirmed, true);
  assert.equal(r.hash, VEC_HASH);
  assert.equal(r.nodes, 2);
  assert.equal(r.sinkDaaScore, VEC_SINK - 500); // uses the SMALLEST sink (most conservative)
});

test('crossCheckAttestations rejects fewer than 2 attestations', () => {
  assert.throws(() => crossCheckAttestations([att()], OPT), /need >= 2 independent/);
  assert.throws(() => crossCheckAttestations([], OPT), /need >= 2 independent/);
});

test('crossCheckAttestations rejects two attestations from the SAME rpc', () => {
  assert.throws(() => crossCheckAttestations([att(), att()], OPT), /not independent: duplicate rpc/);
});

test('crossCheckAttestations rejects a beacon-hash disagreement', () => {
  const bad = att({ rpc: 'grpc://node-b:16110', beacon_hash: 'f'.repeat(64) });
  assert.throws(() => crossCheckAttestations([att(), bad], OPT), /do not agree on the beacon/);
});

test('crossCheckAttestations rejects daa/blue disagreement even if hash matches', () => {
  const b1 = att({ rpc: 'grpc://node-b:16110', beacon_daa_score: VEC_DAA + 1 });
  assert.throws(() => crossCheckAttestations([att(), b1], OPT), /beacon_daa_score disagrees/);
  const b2 = att({ rpc: 'grpc://node-b:16110', beacon_blue_score: VEC_BLUE + 1 });
  assert.throws(() => crossCheckAttestations([att(), b2], OPT), /beacon_blue_score disagrees/);
});

test('crossCheckAttestations rejects an unconfirmed attestation', () => {
  const un = att({ rpc: 'grpc://node-b:16110', confirmed: false });
  assert.throws(() => crossCheckAttestations([att(), un], OPT), /is not confirmed/);
});

test('crossCheckAttestations rejects a target mismatch vs announced', () => {
  const wrong = att({ rpc: 'grpc://node-b:16110', target: VEC_DAA + 1 });
  assert.throws(() => crossCheckAttestations([att(), wrong], OPT), /target .* != announced/);
});

test('crossCheckAttestations rejects a malformed attestation (missing field)', () => {
  const { beacon_hash, ...missing } = att({ rpc: 'grpc://node-b:16110' });
  assert.throws(() => crossCheckAttestations([att(), missing], OPT), /missing field 'beacon_hash'/);
});

test('crossCheckAttestations still enforces the depth gate on the min sink', () => {
  // both agree but the min sink is too close → NOT confirmed
  const near = att({ rpc: 'grpc://node-b:16110', sink_daa_score: VEC_DAA + 10 });
  assert.throws(() => crossCheckAttestations([att(), near], { target: VEC_DAA, depth: 4320 }), /NOT confirmed/);
});

test('blake2b512trunc32 is the same bytes as the blake2b256 alias', () => {
  assert.deepEqual(blake2b512trunc32(Buffer.from('abc')), blake2b256(Buffer.from('abc')));
});

// ── RNG: determinism + unbiasedness ──────────────────────────────────────────
test('makeRng is a pure function of its seed', () => {
  const s = blake2b256(Buffer.from('seed'));
  const a = makeRng(s), b = makeRng(s);
  const sa = Array.from({ length: 100 }, () => a());
  const sb = Array.from({ length: 100 }, () => b());
  assert.deepEqual(sa, sb);
  assert.ok(sa.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff));
});

test('randBelow stays in range and is ~uniform (chi-square, no modulo bias)', () => {
  const rng = makeRng(blake2b256(Buffer.from('uniform')));
  const N = 7, DRAWS = 70000, counts = new Array(N).fill(0);
  for (let i = 0; i < DRAWS; i++) { const v = randBelow(rng, N); assert.ok(v >= 0 && v < N); counts[v]++; }
  const exp = DRAWS / N;
  const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 22.46, `chi-square ${chi.toFixed(2)} too high`); // df=6, 0.1% ≈ 22.46
});

test('randBelow(rng, 1) is always 0', () => {
  const rng = makeRng(blake2b256(Buffer.from('one')));
  for (let i = 0; i < 50; i++) assert.equal(randBelow(rng, 1), 0);
});

test('shuffle returns a non-mutating permutation, deterministic per seed', () => {
  const src = Array.from({ length: 200 }, (_, i) => i);
  const s = blake2b256(Buffer.from('perm'));
  const out = shuffle(src, makeRng(s));
  assert.deepEqual([...out].sort((a, b) => a - b), src);
  assert.deepEqual(src, Array.from({ length: 200 }, (_, i) => i)); // input untouched
  assert.deepEqual(shuffle(src, makeRng(s)), out);                 // deterministic
});

// ── end-to-end ranking (winners + full reserve order) ─────────────────────────
test('rankAll ranks EVERY address exactly once (winners ∪ reserve = the list)', () => {
  const { addrs } = parseEligible(CSV, SHA);
  const seed = deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT);
  const ranking = rankAll(addrs, seed);
  assert.equal(ranking.length, addrs.length);
  assert.deepEqual([...ranking].sort(), [...addrs].sort()); // same multiset
  assert.equal(new Set(ranking).size, addrs.length);        // all distinct
});

test('winners are the first 10 of the ranking; reserve is the rest, disjoint', () => {
  const { addrs } = parseEligible(CSV, SHA);
  const seed = deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT);
  const ranking = rankAll(addrs, seed);
  const winners = computeWinners(addrs, seed, WINNERS);
  const reserve = ranking.slice(WINNERS);
  assert.deepEqual(winners, ranking.slice(0, WINNERS));
  assert.equal(winners.length, 10);
  assert.equal(reserve.length, addrs.length - 10);
  assert.equal(new Set([...winners, ...reserve]).size, addrs.length); // disjoint + complete
});

test('full draw is reproducible for fixed (beacon, csv, commit)', () => {
  const { addrs } = parseEligible(CSV, SHA);
  const seed = deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT);
  assert.deepEqual(rankAll(addrs, seed), rankAll(addrs, seed));
});

// KNOWN-ANSWER vector: pins the whole pipeline (DOMAIN + 4-input seed + FY) so any
// algorithm change breaks this on purpose. Values from the smoke test on VEC_*.
test('KNOWN-ANSWER: fixed vector → pinned seed + winners[0]', () => {
  const { addrs } = parseEligible(CSV, SHA);
  const seed = deriveSeed(VEC_HASH, sha256hex(CSV), COMMIT);
  assert.equal(seed.toString('hex'),
    '2e5e5e4da2a6a3ddc273c90844d432d3bb5f9fc9640c12ee86a6ce493520df13');
  assert.equal(computeWinners(addrs, seed, WINNERS)[0],
    '0x0baca56767b80b325096699d06551a4d79ae7074');
});

// ── config sanity ─────────────────────────────────────────────────────────────
test('announced constants are sane', () => {
  assert.equal(WINNERS, 10);
  assert.equal(DOMAIN, 'tangem-igra-zap-2026-draw-v1');
  assert.equal(ANNOUNCED_DAASCORE, BEACON_DAASCORE);
  assert.ok(Number.isSafeInteger(BEACON_DAASCORE) && BEACON_DAASCORE > 0);
  assert.ok(Number.isSafeInteger(CONFIRMATION_DEPTH) && CONFIRMATION_DEPTH > 0);
});
