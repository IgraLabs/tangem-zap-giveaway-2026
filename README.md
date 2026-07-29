# Tangem × Igra — ZAP Giveaway 2026 · Eligibility Snapshot

Eligible-wallet list for the Tangem ZAP giveaway, derived from the
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

## Scope and versioning

This repository currently covers **eligibility only**. The draw rules, the
committed Kaspa randomness point (block/hash used as the random seed), the
selection algorithm, and the results will be published later.

This snapshot is tagged **`eligibility-v1.0`**. It is the immutable reference for
who is eligible. Any correction requires a **documented new version** (a new tag,
e.g. `eligibility-v1.1`, with the reason recorded) — the tagged snapshot is not
edited in place.

## Files

| File | Contents |
|---|---|
| `eligible_wallets.csv` | Eligible addresses only, **lexicographically sorted**, one per line (header `address`). This is the canonical list — 346 addresses. |
| `generate.mjs` | Standalone reproduction script (public RPC only). |
| `sha256.txt` | SHA-256 checksums of `eligible_wallets.csv`, `generate.mjs`, and `LICENSE`. |
| `LICENSE` | MIT license (covers `generate.mjs`). |

Only the address list is published. Per-address bid totals are computed
internally but intentionally **not** included, to avoid disclosing bid-size
rankings.

## License

`generate.mjs` is released under the [MIT License](LICENSE). The eligibility
data (`eligible_wallets.csv`) consists of on-chain facts and is provided for
verification.

## Reproduce / verify

```bash
node generate.mjs               # regenerates eligible_wallets.csv from public RPC
shasum -c sha256.txt            # verify file integrity
```

`generate.mjs` reads the ZAP bid events directly from the public Igra RPC
(`eth_getLogs`, paginated), sums each address's bids in exact wei, filters
`≥ 500e18`, sorts lexicographically, and writes `eligible_wallets.csv`. It needs
only `node` (v18+, uses built-in `fetch`) — no external services, no API keys.
Set `RPC_URL` to override the endpoint.

Eligibility is computed on **exact wei**, so the 500 iKAS cutoff is never
affected by rounding; the published list is addresses only.
