# Igra × Tangem — ZAP Giveaway 2026 · Eligibility Snapshot

Eligible-wallet list for the Igra ZAP giveaway, derived from the
[IGRA ZAP public auction](https://auctions.zealousswap.com/auctions/igra) on Igra
Network. Every address is reproducible from on-chain data with the included
script.

## Snapshot

| | |
|---|---|
| **Snapshot block** | [12,936,503](https://explorer.igralabs.com/block/12936503) |
| **Snapshot time** | 29 July 2026, 17:18 UTC |
| **Network** | Igra Mainnet (chain ID 38833) |
| **Data source** | On-chain bid events read directly from the public Igra RPC (`eth_getLogs`) |

The ZAP auction is **closed** — it ran 26 March 2026 to **2 April 2026**, so the
bid set is final and does not change with the snapshot block. The block is
recorded for provenance.

## Eligibility rule

An address is **eligible** if the **gross sum of all its bids** in the ZAP
auction is **≥ 500 iKAS**.

- **Basis:** gross bids *placed* — the total iKAS an address bid across all of
  its bids, regardless of how much cleared into IGRA at the clearing price.
  (Not "iKAS actually spent/won".)
- **Threshold:** `≥ 500 iKAS`, **inclusive**. Applied on **exact wei** — no
  rounding at the boundary, so an address at exactly 500.0 iKAS qualifies and
  one at 499.999… does not.
- **Aggregation:** one entry per address = the sum of all its bids.

## Queried contracts / events

| Item | Value |
|---|---|
| Auction contract | [`0xa1ae5e85551f0093696f32be6952c2bb23d3068b`](https://explorer.igralabs.com/address/0xa1ae5e85551f0093696f32be6952c2bb23d3068b) |
| Bid event topic0 | `0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540` |
| Event decoding | `topic2` = bidder address; `data` word1 = bid amount in iKAS (18 decimals) |

## Results

| Metric | Value |
|---|---|
| Total bid events | 1,915 |
| Distinct bidders | 528 |
| **Eligible (≥ 500 iKAS)** | **346** |
| Excluded (< 500 iKAS) | 182 |

## Exclusions

- **182 addresses** whose gross bids summed to **< 500 iKAS** are excluded.
- **No address-type filtering was applied.** Each address is deduplicated by
  summing all of its bids; contracts and any other address types are neither
  identified nor removed. If a downstream process needs to exclude specific
  addresses, do so as a separate, documented step.

## The draw

10 provisional winners (plus the complete reserve order) are drawn from
`eligible_wallets.csv` using a **public, verifiable entropy source**: a future
Kaspa L1 block hash, selected by Kaspa's canonical chain rule. **Igra cannot choose
the hash after commitment; miner influence would require mining power and
potentially sacrificing block rewards.** Anyone can reproduce the result. Full
procedure: [`REPRODUCE.md`](./REPRODUCE.md).

**All 346 wallets enter automatically. Email is optional, notify-only, and never
affects eligibility or odds.**

**Commit → reveal.**

1. **Commit (this repo, now).** The eligibility list is frozen and its SHA-256 is
   committed in `sha256.txt`. The **draw-script commit** (below) and the beacon are
   both published **before** the Kaspa beacon block exists.
2. **The beacon — a future Kaspa mainnet block, announced by DAA score:**

   | | |
   |---|---|
   | **Target** | **`daaScore ≥ 514,900,000`** (Kaspa mainnet) |
   | **Rule** | the **first confirmed block on the virtual selected-parent chain (VSPC)** with `daaScore ≥ 514,900,000` |
   | **Confirmation depth** | **4,320 DAA** (~7 min) below the chain tip before the hash is used |
   | **Est. time** | ~16 Aug 2026 ~20:00 UTC — *approximate; the score, not the clock, is authoritative* |

   The **confirmed VSPC provides the deterministic, consensus-selected chain used by
   this rule**, resolved via a kaspad node's `getVirtualChainFromBlock` RPC —
   **not** a REST endpoint (those lag and have gaps). `daaScore ≥` (not `=`) because
   DAA scores skip. **The 4,320-DAA depth plus independent-node comparison
   materially reduces stale-chain and reorganization risk.** The block hash is
   proof-of-work, unknown until mined.
3. **Seed — binds four public inputs:**
   `seed = BLAKE2b-512( "tangem-igra-zap-2026-draw-v1" ‖ beacon_block_hash ‖ sha256(eligible_wallets.csv) ‖ draw_script_git_commit )[0:32]`
   — **note:** this is the 512-bit BLAKE2b digest **truncated to its first 32 bytes**, *not* parameterized BLAKE2b-256 (they produce different output). To reproduce in another language, compute `BLAKE2b(x, 64-byte output)[0:32]`.
   The `draw-script commit` is published as a **full immutable hash** below (in *Versioning*), not only the movable `draw-v1.0` tag.
4. **Selection.** A deterministic Fisher–Yates shuffle (seeded CSPRNG,
   rejection-sampled to remove modulo bias) ranks all 346 addresses; ranks **1–10**
   are the **provisional winners**, and ranks **11…346** are the complete reserve
   order. (Winners are *provisional* pending claim-time checks — see the claim
   policy.)

Reproduce with `vspc-beacon` (resolves the beacon on two independent kaspad nodes)
and `node draw.mjs` (re-verifies the list + confirmation depth, then draws). The
result is fixed by the four inputs above, so every run by anyone yields the same
winners and reserve. The **draw-script commit is published now**; the winning set
and the resolved beacon hash are published after the draw. See
[`REPRODUCE.md`](./REPRODUCE.md).

## Versioning

The eligibility snapshot is tagged **`eligibility-v1.0`** — the immutable
reference for who is eligible.

The draw script is tagged **`draw-v1.1`** (it supersedes `draw-v1.0`, which had a
resolver bug — see the tag/release notes). The commit that `draw-v1.1` points to is
the **`draw_script_commit`** bound into the seed. Its **full immutable hash is
published in the `draw-v1.1` git tag annotation and the GitHub release** (a commit
cannot contain its own hash, so it is announced there, not inside this file).
Resolve and verify it yourself:

```bash
git rev-list -n1 draw-v1.1     # prints the full 40-hex draw_script_commit
```

Use exactly that hash as `DRAW_SCRIPT_COMMIT`. **Do not use `draw-v1.0`** — its
commit `d13c057…` contains the pre-fix resolver.

**After public commitment, corrections are not silent re-tags.** Once the list
SHA-256, the draw-script commit, and the beacon target are published, an
eligibility correction requires a **documented restart**: a new list commitment
**and** a new *future* beacon target (a fresh commit → reveal), announced as such —
not merely bumping a tag. This prevents any post-commitment change to who is in or
which entropy is used.

## Files

| File | Contents |
|---|---|
| `eligible_wallets.csv` | Eligible addresses only, **lexicographically sorted**, one per line (header `address`). This is the canonical list — 346 addresses. |
| `generate.mjs` | Standalone eligibility-reproduction script (public RPC only). |
| `draw.mjs` | Standalone winner-draw script — verifies the frozen list + beacon confirmation depth, derives the 4-input seed, and prints the 10 winners **and the complete reserve order**. Node v18+ only, no network (the beacon is supplied as verified inputs). |
| `draw.test.mjs` | Test suite for `draw.mjs` (Node's built-in test runner, zero deps, fully offline). Covers determinism, unbiased selection, tamper/shape rejection, the 4-input seed, the confirmation-depth gate, and a known-answer vector. |
| `vspc-beacon/` | The **canonical beacon resolver** (Rust) — reads the first confirmed VSPC block with `daaScore ≥ target` from a kaspad node via `getVirtualChainFromBlock`. Builds standalone (git-pinned kaspa deps). |
| `REPRODUCE.md` | Step-by-step third-party reproduction (resolve beacon on two independent nodes → verify list → run draw). |
| `sha256.txt` | SHA-256 checksums of `eligible_wallets.csv`, `generate.mjs`, `draw.mjs`, `draw.test.mjs`, the `vspc-beacon` sources, and `LICENSE`. |
| `LICENSE` | MIT license (covers `generate.mjs`, `draw.mjs`, and `vspc-beacon`). |

Only the address list is published. Per-address bid totals are computed
internally but intentionally **not** included, to avoid disclosing bid-size
rankings.

## License

`generate.mjs`, `draw.mjs`, and `vspc-beacon` are released under the
[MIT License](LICENSE). The eligibility data (`eligible_wallets.csv`) consists of
on-chain facts and is provided for verification.

## Reproduce / verify

Full procedure in [`REPRODUCE.md`](./REPRODUCE.md). In short:

```bash
node generate.mjs               # (eligibility) regenerate eligible_wallets.csv from public RPC
shasum -c sha256.txt            # verify file integrity
node --test                     # run the draw test suite (41 tests, offline, zero deps)

# (draw) resolve the beacon on two DISTINCT kaspad endpoints, save each JSON,
# then draw against both — the draw checks the two endpoints agree before running:
cd vspc-beacon && cargo build --release && cd ..
vspc-beacon/target/release/vspc-beacon --rpc grpc://<NODE_A>:16110 --target 514900000 --depth 4320 --json > att_a.json
vspc-beacon/target/release/vspc-beacon --rpc grpc://<NODE_B>:16110 --target 514900000 --depth 4320 --json > att_b.json
BEACON_ATTESTATIONS="att_a.json,att_b.json" DRAW_SCRIPT_COMMIT=<full commit hash of draw-v1.1> node draw.mjs
```

The draw's fairness-critical logic is tested in `draw.test.mjs` (41 tests): seed
derivation and shuffle are deterministic, index selection is unbiased
(chi-square), a tampered or malformed list is rejected (wrong header, bad
address, duplicate, or unsorted all throw), the commitment lookup matches the
exact filename (no substring collisions), the **4-input seed** rejects
short/typo'd hex rather than silently mis-seeding, the **confirmation-depth gate**
refuses a beacon that is below target or not buried deep enough, and a
known-answer vector pins the whole pipeline against regression. Data files are
read relative to the script (never a same-named file in the caller's directory),
and importing `draw.mjs` is side-effect-free, so the tests run offline.

`generate.mjs` reads the ZAP bid events directly from the public Igra RPC
(`eth_getLogs`, paginated), sums each address's bids in exact wei, filters
`≥ 500e18`, sorts lexicographically, and writes `eligible_wallets.csv`. It needs
only `node` (v18+, uses built-in `fetch`) — no external services, no API keys.
Set `RPC_URL` to override the endpoint.

Eligibility is computed on **exact wei**, so the 500 iKAS cutoff is never
affected by rounding; the published list is addresses only.
