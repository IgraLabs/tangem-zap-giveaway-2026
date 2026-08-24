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
# NB: blake2b256 here = BLAKE2b-512(x)[0:32] — the 512-bit digest truncated to 32
# bytes, NOT parameterized BLAKE2b-256. Reproduce with BLAKE2b(x, 64B)[0:32].
seed     = BLAKE2b-512( DOMAIN ‖ beacon_hash ‖ csv_sha256 ‖ draw_script_commit )[0:32]
ranking  = Fisher–Yates(eligible_wallets.csv, seed)   # rejection-sampled, unbiased
winners  = ranking[0..10]        # the 10 winners
reserve  = ranking[10..]         # complete reserve order, in rank sequence
```

## The beacon (announced in advance)

| | |
|---|---|
| **Target** | **`daaScore ≥ 518,150,000`** on **Kaspa mainnet** |
| **Rule** | the **first confirmed block on the virtual selected-parent chain (VSPC)** whose `daaScore` is **≥ 518,150,000** (resolver walks the VSPC in pages) |
| **Confirmation depth** | **4,320 DAA** — the beacon is used only once the chain sink is `≥ beacon.daaScore + 4320` (~7 min at 10 bps): this depth plus independent-node comparison materially reduces stale-chain and reorganization risk (PoW confirmation is probabilistic, not absolute) |
| **Estimated time** | ~20 Aug 2026, ~14:00 UTC (approximate — the **score**, not the clock, is authoritative) |

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
./target/release/vspc-beacon --rpc grpc://<NODE_A>:16110 --target 518150000 --depth 4320 --json
./target/release/vspc-beacon --rpc grpc://<NODE_B>:16110 --target 518150000 --depth 4320 --json
```

Both must print the **same** `beacon_hash` and `"confirmed": true`. (A capacity-capped
public node may need a retry; that is a liveness hiccup, not a correctness issue.)
You may also spot-check the block on any explorer — it must be a chain block with the
reported `daaScore`/`blueScore`.

**Save each node's JSON to a file** — these are the *attestations* the draw checks:

```bash
vspc-beacon --rpc grpc://<NODE_A>:16110 --target 518150000 --depth 4320 --json > att_a.json
vspc-beacon --rpc grpc://<NODE_B>:16110 --target 518150000 --depth 4320 --json > att_b.json
```

### Once the beacon is behind the pruning point

Kaspa nodes prune. Some time after the draw the beacon target drops below the
consensus pruning point, and the command above exits with *"target is below the
earliest retained chain block"* on every node. The pruning point is a **consensus**
value, identical on archival and pruned nodes alike, so trying more endpoints does
not help.

Two ways to confirm the beacon after that point:

**A — any archival kaspad.** Pass `--from-block` with a chain block whose `daaScore`
is below the target; the walk then starts there instead of at the pruning point. The
resolver rejects a start that is not a chain block, or whose `daaScore` is at or
above the target, since the "first block at or above target" result could not
otherwise be proven.

```bash
vspc-beacon --rpc grpc://<ARCHIVAL_NODE>:16110 --target 518150000 --depth 4320 \
  --from-block <CHAIN_BLOCK_BELOW_TARGET> --json > att_a.json
```

For this draw, `9c6affde6d223540365b865481e2746fcefb98e7cf8384b19601ddc0ae0898f9`
(daaScore 518,146,595) is a suitable start block.

**B — an archival explorer, no build.** Fetch the beacon and its selected parent:

```bash
curl -s "https://api.kaspa.org/blocks/<BEACON_HASH>?includeColor=false"
curl -s "https://api.kaspa.org/blocks/<SELECTED_PARENT_HASH>?includeColor=false"
```

The beacon must be a chain block with `daaScore` at or above the target; its selected
parent must be a chain block with `daaScore` below it. The virtual selected-parent
chain is a linked list by selected parent, so the beacon's chain predecessor is
exactly its selected parent — a parent below the target and the beacon at or above it
means no chain block sits between them, which is what makes the beacon the first
qualifying block.

Route B confirms the beacon but produces no attestation file. Use the published
attestations for Step 3 in that case.

## Step 2 — verify the candidate list

```bash
shasum -a 256 -c sha256.txt        # eligible_wallets.csv (+ scripts) must all say OK
```

`draw.mjs` also re-verifies this internally and refuses to run on a tampered or
malformed list.

## Step 3 — run the draw (two-endpoint agreement gate)

Point the draw at **both** result files. It **checks agreement between the two
distinct endpoints** on the beacon (hash + daaScore + blueScore), that both are
`confirmed`, and that they came from *different* RPCs — then derives the beacon from
that agreement, not from a single trusted input. (This is an agreement check across
endpoints, **not** a cryptographic attestation — the JSON/endpoint strings are
unauthenticated; its value is that any honest, independent re-run detects a
substituted beacon.)

```bash
BEACON_ATTESTATIONS="att_a.json,att_b.json" \
DRAW_SCRIPT_COMMIT=<announced full commit hash of draw.mjs> \
node draw.mjs
```

`draw.mjs` cross-checks the attestations, re-checks `beacon_daa_score ≥ 518,150,000`
and the 4,320-DAA confirmation gate (against the **smallest** sink across nodes),
derives the seed, and prints JSON with `winners` (10), `reserve_order`, and
`beacon.provenance: "attested"`. Run by anyone with the same attestations + list, it
yields the **identical** winners and reserve order.

> **Single-node fallback (not for the official draw):** the older
> `BEACON_HASH=… BEACON_DAASCORE=… BEACON_BLUESCORE=… SINK_DAASCORE=…` env form still
> works for a quick local check, but it is **un-attested** — the script prints a
> warning and marks `provenance: "unattested"`, because a single supplied hash is not
> proof it is the real first-qualifying VSPC block. The official result uses the
> two-node attested path above.

## Step 4 (optional) — check the algorithm

```bash
node --test        # 41 offline tests: determinism, unbiased selection (chi-square),
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
