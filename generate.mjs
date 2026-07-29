#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Reproducible generation of the ZAP-auction eligibility list for the
// Tangem × Igra ZAP giveaway (2026).
//
// Eligibility: an address qualifies if the GROSS sum of all its bids in the
// IGRA ZAP auction is >= 500 iKAS. Amounts are summed in exact wei and the 500
// cutoff is applied on exact wei (no rounding at the boundary).
//
// Data source: on-chain bid events read directly from the PUBLIC Igra RPC via
// eth_getLogs (paginated). No private tooling, no API keys — only `node` (v18+,
// built-in fetch).
//
// Snapshot: block 12,936,503 (2026-07-29). The auction is closed, so the bid
// set is final and independent of the snapshot block; the block is recorded for
// provenance. Only the address list is written to disk; per-address bid totals
// are computed internally but intentionally not published.
//
// Usage: node generate.mjs        (override endpoint with RPC_URL=...)

import { writeFileSync } from 'node:fs';

const RPC = process.env.RPC_URL || 'https://rpc.igralabs.com:8545';

const AUCTION   = '0xa1ae5e85551f0093696f32be6952c2bb23d3068b';
// Bid event. topic2 = bidder address; data word1 = bid amount in iKAS (18 dec).
const BID_EVENT = '0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540';
const THRESHOLD_WEI = 500n * 10n ** 18n; // 500 iKAS

// Auction bid window (from the auction contract lifecycle). Scanning a superset
// is safe: filtering is by contract address + event topic, so out-of-window
// blocks simply contribute nothing.
const FROM_BLOCK = 2_400_000;
const TO_BLOCK   = 3_020_000;
const PAGE       = 90_000; // Igra RPC eth_getLogs range cap is 100k

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getBids() {
  const logs = [];
  for (let from = FROM_BLOCK; from <= TO_BLOCK; from += PAGE + 1) {
    const to = Math.min(from + PAGE, TO_BLOCK);
    const page = await rpc('eth_getLogs', [{
      address: AUCTION,
      topics: [BID_EVENT],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }]);
    logs.push(...page);
  }
  return logs;
}

const logs = await getBids();
const byAddr = {};
let count = 0;
for (const log of logs) {
  const bidder = '0x' + log.topics[2].slice(26).toLowerCase();
  const amountWei = BigInt('0x' + log.data.slice(2).slice(64, 128)); // data word1
  byAddr[bidder] = (byAddr[bidder] || 0n) + amountWei;
  count++;
}

const eligible = Object.keys(byAddr)
  .filter((a) => byAddr[a] >= THRESHOLD_WEI)
  .sort(); // lexicographic

writeFileSync('eligible_wallets.csv', 'address\n' + eligible.join('\n') + '\n');

console.error(
  `bids=${count} bidders=${Object.keys(byAddr).length} eligible=${eligible.length} (>= 500 iKAS)`
);
