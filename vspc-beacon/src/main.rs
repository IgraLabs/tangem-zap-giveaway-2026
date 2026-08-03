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

    // 2. Full selected-parent chain from the pruning point up to the sink.
    //    added_chain_block_hashes is ascending along the VSPC.
    let chain = client
        .get_virtual_chain_from_block(pruning_point, false, None)
        .await?;
    let hashes = chain.added_chain_block_hashes;
    if hashes.is_empty() {
        eyre::bail!("empty virtual chain from pruning point {pruning_point}");
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

    // Sanity: confirm the target is within [chain.first.daa, chain.last.daa].
    let (first_daa, _, _) = daa_blue_at(&client, &hashes, 0).await?;
    let (last_daa, _, _) = daa_blue_at(&client, &hashes, hashes.len() - 1).await?;
    if args.target < first_daa {
        eyre::bail!(
            "target {} is below the earliest retained chain block daaScore {} (pruned); pick a higher target",
            args.target, first_daa
        );
    }
    if args.target > last_daa {
        eyre::bail!(
            "target {} is above the current sink daaScore {} — the beacon block is NOT mined yet; wait",
            args.target, last_daa
        );
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

    // 4. Confirmation.
    let confirmed = sink_daa >= beacon_daa.saturating_add(args.depth);
    let gap = sink_daa.saturating_sub(beacon_daa);

    if args.json {
        println!(
            "{{\"rpc\":\"{}\",\"target\":{},\"beacon_hash\":\"{}\",\"beacon_daa_score\":{},\"beacon_blue_score\":{},\"sink_daa_score\":{},\"virtual_daa_score\":{},\"confirmation_gap\":{},\"depth\":{},\"confirmed\":{},\"chain_len\":{}}}",
            args.rpc, args.target, beacon_hash, beacon_daa, beacon_blue,
            sink_daa, virtual_daa, gap, args.depth, confirmed, hashes.len()
        );
    } else {
        println!("node                : {}", args.rpc);
        println!("target daaScore     : {}", args.target);
        println!("VSPC chain length   : {} (pruning_point -> sink)", hashes.len());
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
