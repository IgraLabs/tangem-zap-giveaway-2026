# Reproducing the draw

Anyone can independently reproduce the winner draw from **public inputs only**.
Nothing here needs organiser cooperation, API keys, or trust in a single node.

The result is fixed by four public values:

| Input | What it is |
|---|---|
| `DOMAIN` | the fixed string `tangem-igra-zap-2026-draw-v1` |
| **beacon block hash** | the Kaspa PoW block selected by the rule below |
| **candidate list SHA-256** | `sha256(eligible_wallets.csv)`, committed in `sha256.txt` |
| **draw-script commit** | the git commit of `draw.mjs` at release (announced) |

```
seed     = blake2b256( DOMAIN ‖ beacon_hash ‖ csv_sha256 ‖ draw_script_commit )
ranking  = Fisher–Yates(eligible_wallets.csv, seed)   # rejection-sampled, unbiased
winners  = ranking[0..10]        # the 10 winners
reserve  = ranking[10..]         # complete fallback order, in rank sequence
```

## The beacon (announced in advance)

| | |
|---|---|
| **Target** | **`daaScore ≥ 514,900,000`** on **Kaspa mainnet** |
| **Rule** | the **first block on the virtual selected-parent chain (VSPC)** whose `daaScore` is **≥ 514,900,000** |
| **Confirmation depth** | **4,320 DAA** — the beacon is used only once the chain sink is `≥ beacon.daaScore + 4320` (~7 min at 10 bps): this depth plus independent-node comparison materially reduces stale-chain and reorganization risk (PoW confirmation is probabilistic, not absolute) |
| **Estimated time** | ~16 Aug 2026, ~20:00 UTC (approximate — the **score**, not the clock, is authoritative) |

Why VSPC-by-daaScore, and why depth:

- The **confirmed VSPC provides the deterministic, consensus-selected chain used by
  this rule**. "First VSPC block with `daaScore ≥ target`" is therefore unambiguous.
  `daaScore ≥` (not `=`) because DAA scores skip.
- It is read from a kaspad node via **`getVirtualChainFromBlock`**, *not* a REST
  endpoint — REST chain projections lag the tip and have gaps, which would make the
  answer non-deterministic. The raw RPC does not.
- The **4,320-DAA confirmation depth plus independent-node comparison materially
  reduces stale-chain and reorganization risk**: a not-yet-buried or stale read
  fails to *"wait"* and is caught by comparing two independent nodes.

## Step 1 — resolve the beacon (two independent nodes)

Build the resolver (Rust toolchain only; kaspa deps are git-pinned):

```bash
cd vspc-beacon
cargo build --release
```

Resolve against **two independently operated kaspad nodes** and confirm the hash
matches:

```bash
./target/release/vspc-beacon --rpc grpc://<NODE_A>:16110 --target 514900000 --depth 4320 --json
./target/release/vspc-beacon --rpc grpc://<NODE_B>:16110 --target 514900000 --depth 4320 --json
```

Both must print the **same** `beacon_hash` and `"confirmed": true`. (A capacity-capped
public node may need a retry; that is a liveness hiccup, not a correctness issue.)
You may also spot-check the block on any explorer — it must be a chain block with the
reported `daaScore`/`blueScore`.

Record from the output: `beacon_hash`, `beacon_daa_score`, `beacon_blue_score`,
`sink_daa_score`.

## Step 2 — verify the candidate list

```bash
shasum -a 256 -c sha256.txt        # eligible_wallets.csv (+ scripts) must all say OK
```

`draw.mjs` also re-verifies this internally and refuses to run on a tampered or
malformed list.

## Step 3 — run the draw

```bash
BEACON_HASH=<beacon_hash> \
BEACON_DAASCORE=<beacon_daa_score> \
BEACON_BLUESCORE=<beacon_blue_score> \
SINK_DAASCORE=<sink_daa_score> \
DRAW_SCRIPT_COMMIT=<announced git commit of draw.mjs> \
node draw.mjs
```

`draw.mjs` re-checks `beacon_daa_score ≥ 514,900,000` and the 4,320-DAA confirmation
gate, derives the seed, and prints JSON with `winners` (10) and `reserve_order` (the
rest, in fallback sequence). Run by anyone with the same inputs, it yields the
**identical** winners and reserve order.

## Step 4 (optional) — check the algorithm

```bash
node --test        # 31 offline tests: determinism, unbiased selection (chi-square),
                   # tamper/shape rejection, the 4-input seed, the confirmation gate,
                   # and a known-answer vector pinning the whole pipeline.
```

## Notes on trust

- The **seed binds all four inputs** — changing the list, the beacon, the domain, or
  the script commit changes every winner. None can be swapped after the fact.
- The **beacon is PoW** — its hash is unknown until mined. Igra cannot choose the
  hash after committing to the target; miner influence would require mining power
  and potentially sacrificing block rewards.
- The **`vspc-beacon` deps are git-pinned** to a specific `rusty-kaspa` revision for a
  reproducible build; a verifier may repoint them at upstream `kaspanet/rusty-kaspa`
  at a revision with the same RPC surface — the beacon rule is independent of which
  honest node answers.
