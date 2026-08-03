//! Resolve the Igra×Tangem draw beacon: the FIRST confirmed virtual
//! selected-parent-chain (VSPC) block with `daaScore >= target`, via kaspad's
//! `getVirtualChainFromBlock` RPC (consensus-canonical selection — NOT REST).
//!
//! Algorithm:
//!   1. get_block_dag_info -> sink (current chain tip) + pruning_point + virtual_daa_score.
//!   2. get_virtual_chain_from_block(start = pruning_point) -> added_chain_block_hashes,
//!      the ordered selected-parent chain from the pruning point up to the sink
//!      (ascending blue score / daa score). This IS the canonical VSPC.
//!   3. daaScore is monotonically increasing along that chain, so binary-search it
//!      (fetching only ~log2(N) block headers) for the first hash with daaScore >= target.
//!   4. Confirmation: the beacon is "confirmed" iff sink.daaScore >= beacon.daaScore + depth.
//!
//! Output is machine-checkable: prints the beacon hash, its daaScore & blueScore,
//! the sink daaScore, the confirmation gap, and a CONFIRMED/UNCONFIRMED verdict.
//! Run it against two independent nodes and diff the hash to prove reproducibility.

use clap::Parser;
use kaspa_grpc_client::GrpcClient;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_rpc_core::RpcHash;

#[derive(Parser)]
#[command(about = "Resolve the first confirmed VSPC block with daaScore >= target")]
struct Args {
    /// kaspad gRPC endpoint, e.g. grpc://YOUR_KASPAD_HOST:16110 (required — point
    /// this at a kaspad node you trust; use two independent nodes and compare).
    #[arg(long)]
    rpc: String,

    /// Target DAA score (the announced beacon target).
    #[arg(long)]
    target: u64,

    /// Confirmation depth in DAA: beacon is CONFIRMED iff sink.daaScore >= beacon.daaScore + depth.
    #[arg(long, default_value_t = 4320)]
    depth: u64,

    /// Emit a compact one-line JSON summary (for cross-node diffing / scripting).
    #[arg(long)]
    json: bool,
}

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let args = Args::parse();
    let client = GrpcClient::connect(args.rpc.clone()).await?;

    // 1. Chain tip (sink), pruning point, and virtual DAA.
    let dag = client.get_block_dag_info().await?;
    let sink = dag.sink;
    let pruning_point = dag.pruning_point_hash;
    let virtual_daa = dag.virtual_daa_score;

    // The sink's own daaScore (the practical "tip" for confirmation math).
    let sink_block = client.get_block(sink, false).await?;
    let sink_daa = sink_block.header.daa_score;

    // Guard: the target cannot exceed the current sink — the beacon is not mined
    // yet. sink_daa here is the AUTHORITATIVE tip from getBlockDagInfo, independent
    // of the paginated chain walk below (so this is correct even if the walk would
    // span many pages).
    if args.target > sink_daa {
        eyre::bail!(
            "target {} is above the current sink daaScore {} — the beacon block is NOT mined yet; wait",
            args.target, sink_daa
        );
    }

    // 2. Walk the selected-parent chain from the pruning point, IN PAGES.
    //    getVirtualChainFromBlock caps each response at mergeset_size_limit*10
    //    added chain blocks (~2480 at 10 bps, ~1800 on mainnet) — a SINGLE call is
    //    NOT the whole pruning-point->sink chain. We advance `walk` to the last
    //    returned hash each page and accumulate until the target daaScore is
    //    bracketed (last accumulated block's daaScore >= target) or we reach the
    //    sink. added_chain_block_hashes is ascending, and daaScore is non-decreasing
    //    along the chain, so the accumulated prefix stays sorted for the search.
    //
    //    REORG HANDLING: if any page reports non-empty `removed_chain_block_hashes`,
    //    the node's selected chain changed mid-walk and blocks we already accumulated
    //    may now be stale. Rather than splice removals into the prefix, we discard
    //    everything and RESTART the walk from the pruning point (bounded attempts).
    //    A clean full pass with zero removals yields a self-consistent chain; the
    //    two-node agreement gate is the backstop if a node is reorg-thrashing.
    async fn daa_of(client: &GrpcClient, h: RpcHash) -> eyre::Result<u64> {
        Ok(client.get_block(h, false).await?.header.daa_score)
    }
    let mut hashes: Vec<RpcHash> = Vec::new();
    let mut bracketed;
    let mut reorg_restarts = 0u32;
    'walk: loop {
        hashes.clear();
        bracketed = false;
        let mut walk = pruning_point;
        // Bound per-pass pages generously; ~2480/page over a 30-day chain < ~11k pages.
        for _page in 0..100_000u32 {
            let resp = client.get_virtual_chain_from_block(walk, false, None).await?;
            if !resp.removed_chain_block_hashes.is_empty() {
                // Reorg observed mid-walk → restart from scratch (bounded).
                reorg_restarts += 1;
                if reorg_restarts > 10 {
                    eyre::bail!(
                        "chain kept reorging across {} full-walk restarts (node unstable?); \
                         re-run later, or use a node that is settled at this depth",
                        reorg_restarts
                    );
                }
                continue 'walk;
            }
            let page = resp.added_chain_block_hashes;
            if page.is_empty() {
                break; // reached the sink (no more added chain blocks)
            }
            let last = *page.last().unwrap();
            hashes.extend(page);
            // Did we pass the target within what we've accumulated so far?
            if daa_of(&client, last).await? >= args.target {
                bracketed = true;
                break;
            }
            if last == walk {
                break; // no forward progress → sink
            }
            walk = last;
        }
        break; // completed a full pass with no reorg
    }
    if hashes.is_empty() {
        eyre::bail!("empty virtual chain from pruning point {pruning_point}");
    }

    // The earliest retained chain block: if the target is below it, it is pruned.
    let first_daa = daa_of(&client, hashes[0]).await?;
    if args.target < first_daa {
        eyre::bail!(
            "target {} is below the earliest retained chain block daaScore {} (pruned); pick a higher target",
            args.target, first_daa
        );
    }
    // If we never bracketed the target even after walking to the sink, the target
    // is between the last retained block and the sink but not yet chain-accepted —
    // treat as not-yet-available rather than silently picking the wrong block.
    if !bracketed {
        let last_daa = daa_of(&client, *hashes.last().unwrap()).await?;
        eyre::bail!(
            "target {} not found on the retained VSPC (last retained daaScore {}, sink {}); wait for it to be chain-accepted, or the node's retention is short",
            args.target, last_daa, sink_daa
        );
    }

    // Helper: fetch a chain block's daaScore & blueScore by index.
    async fn daa_blue_at(
        client: &GrpcClient,
        hashes: &[RpcHash],
        i: usize,
    ) -> eyre::Result<(u64, u64, RpcHash)> {
        let h = hashes[i];
        let b = client.get_block(h, false).await?;
        Ok((b.header.daa_score, b.header.blue_score, h))
    }

    // 3. Binary-search the first index with daaScore >= target (chain daa is monotonic).
    let (mut lo, mut hi) = (0usize, hashes.len() - 1);
    while lo < hi {
        let mid = (lo + hi) / 2;
        let (mid_daa, _, _) = daa_blue_at(&client, &hashes, mid).await?;
        if mid_daa >= args.target {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    let (beacon_daa, beacon_blue, beacon_hash) = daa_blue_at(&client, &hashes, lo).await?;

    // POST-CONDITION (correctness guard). The leftmost binary search returns the
    // chain-order-FIRST block with daaScore >= target, which is correct *iff* the
    // accumulated chain's daaScore is non-decreasing. Two facts constrain this:
    //   * daaScore(block) = daaScore(selected_parent) + (mergeset_size - non_daa),
    //     and that added term is >= 0 — so along the VSPC daaScore is NON-DECREASING
    //     (NOT strictly increasing: consecutive chain blocks CAN share a daaScore
    //     when the added term is 0). So the correct check is `prev < target` OR
    //     `prev == beacon_daa` (an equal-daaScore run straddling the boundary is
    //     fine — leftmost still picks the chain-first one).
    //   * a mid-walk reorg could splice a non-monotonic list; that we must catch.
    // Prove: (a) the pick is >= target, and (b) the immediately preceding block is
    // <= the pick (monotonic) and does not itself precede a smaller qualifying
    // block (i.e. leftmost holds). Bail loudly on violation rather than return a
    // silently-wrong beacon; the two-node agreement gate is the backstop.
    if beacon_daa < args.target {
        eyre::bail!(
            "internal: selected block daaScore {} < target {} (chain changed mid-walk / reorg?); re-run",
            beacon_daa, args.target
        );
    }
    if lo > 0 {
        let (prev_daa, _, _) = daa_blue_at(&client, &hashes, lo - 1).await?;
        // Monotonic (non-decreasing) is required; a reorg could break it.
        if prev_daa > beacon_daa {
            eyre::bail!(
                "internal: chain not monotonic at pick (prev daaScore {} > selected {}); reorg mid-walk? re-run",
                prev_daa, beacon_daa
            );
        }
        // Leftmost correctness: the block before must be strictly below target.
        // (prev may EQUAL beacon_daa only if beacon_daa < target, which (a) already
        // excluded — so at the boundary prev < target must hold.)
        if prev_daa >= args.target {
            eyre::bail!(
                "internal: block before the selected one has daaScore {} >= target {} — search did not land leftmost (reorg mid-walk?); re-run",
                prev_daa, args.target
            );
        }
    }

    // 4. Confirmation.
    let confirmed = sink_daa >= beacon_daa.saturating_add(args.depth);
    let gap = sink_daa.saturating_sub(beacon_daa);

    if args.json {
        println!(
            "{{\"rpc\":\"{}\",\"target\":{},\"beacon_hash\":\"{}\",\"beacon_daa_score\":{},\"beacon_blue_score\":{},\"sink_daa_score\":{},\"virtual_daa_score\":{},\"confirmation_gap\":{},\"depth\":{},\"confirmed\":{},\"blocks_walked\":{}}}",
            args.rpc, args.target, beacon_hash, beacon_daa, beacon_blue,
            sink_daa, virtual_daa, gap, args.depth, confirmed, hashes.len()
        );
    } else {
        println!("node                : {}", args.rpc);
        println!("target daaScore     : {}", args.target);
        println!("VSPC blocks walked  : {} (pruning_point -> first block >= target, paginated)", hashes.len());
        println!("--- beacon (first VSPC block with daaScore >= target) ---");
        println!("beacon hash         : {}", beacon_hash);
        println!("beacon daaScore     : {}", beacon_daa);
        println!("beacon blueScore    : {}", beacon_blue);
        println!("--- confirmation ---");
        println!("sink daaScore       : {}", sink_daa);
        println!("virtual daaScore    : {}", virtual_daa);
        println!("confirmation gap    : {} DAA (need >= {})", gap, args.depth);
        println!(
            "verdict             : {}",
            if confirmed { "CONFIRMED" } else { "UNCONFIRMED — wait for more depth" }
        );
    }

    Ok(())
}
