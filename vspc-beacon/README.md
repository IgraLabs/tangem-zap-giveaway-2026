# vspc-beacon

Resolves the **canonical, publicly verifiable entropy beacon** for the Igra × Tangem ZAP draw: the
**first confirmed virtual-selected-parent-chain (VSPC) block with
`daaScore ≥ target`**, read directly from a kaspad node via the
`getVirtualChainFromBlock` gRPC RPC.

The confirmed VSPC provides the deterministic, consensus-selected chain used by this
rule — so it does **not** depend on a convenient REST endpoint (those lag the tip and
have gaps) or any hash tie-break a miner could grind.

## What it does

1. `getBlockDagInfo` → the current sink (chain tip, authoritative for the depth gate)
   and pruning point.
2. `getVirtualChainFromBlock(start = …)` walked **in pages** — the node caps each
   response at ~2,480 (10 bps) / ~1,800 (mainnet) added chain blocks, so a single
   call is **not** the whole chain. The resolver advances the start to the last
   returned hash each page, accumulating from the pruning point until the target
   daaScore is bracketed (or the sink is reached).
3. Binary-search the accumulated (ascending, monotonic-daaScore) prefix for the
   **first block with `daaScore ≥ target`**.
4. Report its hash, `daaScore`, `blueScore`, the sink `daaScore`, and whether it
   is **confirmed**: `sink.daaScore ≥ beacon.daaScore + depth`. A stale/lagging
   node therefore yields "not confirmed / wait" rather than an unconfirmed result;
   a post-condition guard bails loudly if a mid-walk reorg breaks monotonicity, and
   the walk restarts from scratch if a page reports removed (reorged) chain blocks.
   The `target` is checked against the authoritative sink, so a many-page walk
   cannot be mistaken for "not mined yet".

## Build

Needs a Rust toolchain (`rustup`, stable). The kaspa RPC crates are pinned by git
revision in `Cargo.toml`, so the build is reproducible:

```bash
cd vspc-beacon
cargo build --release
# binary: target/release/vspc-beacon
```

## Run

```bash
# The announced target for the draw is daaScore 514,900,000; depth 4320.
vspc-beacon --rpc grpc://<KASPAD_HOST>:16110 --target 514900000 --depth 4320

# machine-readable, for cross-node diffing:
vspc-beacon --rpc grpc://<KASPAD_HOST>:16110 --target 514900000 --depth 4320 --json
```

Run it against **two independently operated kaspad nodes** and confirm the
`beacon_hash` is identical. Example output (`--json`):

```json
{"rpc":"grpc://...","target":514900000,"beacon_hash":"<64-hex>",
 "beacon_daa_score":5149000xx,"beacon_blue_score":...,"sink_daa_score":...,
 "confirmation_gap":...,"depth":4320,"confirmed":true,"chain_len":...}
```

## Feeding the draw

The draw script (`../draw.mjs`) does **not** talk to kaspad. Take the confirmed
beacon fields from this tool and pass them to the draw:

```bash
BEACON_HASH=<beacon_hash> \
BEACON_DAASCORE=<beacon_daa_score> \
BEACON_BLUESCORE=<beacon_blue_score> \
SINK_DAASCORE=<sink_daa_score> \
DRAW_SCRIPT_COMMIT=<git commit of draw.mjs at release> \
node ../draw.mjs
```

`draw.mjs` re-checks `daaScore ≥ target` and the confirmation depth before it will
emit any winners. See `../REPRODUCE.md` for the full reproduction procedure.
