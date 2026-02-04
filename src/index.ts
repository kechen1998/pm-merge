import CryptoJS from 'crypto-js';
import { CONFIG } from './config';
import { fetchMarkets, closeRedis } from './redis';
import { CTF_ABI, CTF_ADDRESS, PARTITION, PARENT_COLLECTION_ID, USDC_ADDRESS } from './ctf';
import { createPublicClient, createWalletClient, encodeFunctionData, Hex, http, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { BuilderApiKeyCreds, BuilderConfig } from '@polymarket/builder-signing-sdk';
import { RelayClient, RelayerTxType, Transaction } from '@polymarket/builder-relayer-client';
import { MarketMetadata, QuotaTracker, MergeCandidate } from './types';

function decryptPrivateKey(password: string): Hex {
  const privateKey = CryptoJS.AES.decrypt(CONFIG.ENCRYPT_PRIVATE_KEY, password).toString(CryptoJS.enc.Utf8);
  if (!privateKey) {
    throw new Error('Failed to decrypt private key. Ensure ENCRYPT_PRIVATE_KEY and password are correct.');
  }
  let trimmedKey = privateKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmedKey)) {
    trimmedKey = `0x${trimmedKey}`;
  }
  if (!isHex(trimmedKey) || trimmedKey.length !== 66) {
    throw new Error('Decrypted key is not a valid 32-byte hex private key.');
  }
  return trimmedKey as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRelayerBackoffMs(error: unknown): number | null {
  const err = error as {
    status?: number;
    data?: { error?: string };
    error?: string;
    message?: string;
  };
  if (err?.status !== 429) return null;

  const message = err?.data?.error || err?.error || err?.message || '';
  const match = /resets in (\d+) seconds/i.exec(message);
  if (match && match[1]) {
    const seconds = Number(match[1]);
    if (!Number.isNaN(seconds)) {
      return (seconds + 5) * 1000;
    }
  }

  return 60_000;
}

function getBuilderCreds(): BuilderApiKeyCreds {
  const key = process.env.POLY_BUILDER_API_KEY || process.env.BUILDER_API_KEY;
  const secret = process.env.POLY_BUILDER_API_SECRET || process.env.BUILDER_API_SECRET;
  const passphrase = process.env.POLY_BUILDER_API_PASSPHRASE || process.env.BUILDER_API_PASSPHRASE;
  if (!key || !secret || !passphrase) {
    throw new Error('Missing builder API credentials. Set POLY_BUILDER_API_KEY/SECRET/PASSPHRASE.');
  }
  return { key, secret, passphrase };
}

async function getTokenBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  proxyAddress: Hex,
  market: MarketMetadata
): Promise<{ yesBalance: bigint; noBalance: bigint }> {
  const yesTokenId = BigInt(market.yesTokenId);
  const noTokenId = BigInt(market.noTokenId);
  const [yesBalance, noBalance] = await Promise.all([
    publicClient.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: 'balanceOf',
      args: [proxyAddress, yesTokenId],
    }),
    publicClient.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: 'balanceOf',
      args: [proxyAddress, noTokenId],
    }),
  ]);
  return { yesBalance, noBalance };
}

// Quota tracking
const quotaTracker: QuotaTracker = {
  callsThisHour: 0,
  hourStartTime: Date.now(),
};

function checkAndUpdateQuota(): boolean {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;

  // Reset quota if hour has passed
  if (now - quotaTracker.hourStartTime >= hourMs) {
    quotaTracker.callsThisHour = 0;
    quotaTracker.hourStartTime = now;
    console.log('Quota reset for new hour');
  }

  // Check if we have quota remaining
  if (quotaTracker.callsThisHour >= CONFIG.HOURLY_QUOTA_LIMIT) {
    const resetInMs = hourMs - (now - quotaTracker.hourStartTime);
    console.log(`Quota exhausted (${quotaTracker.callsThisHour}/${CONFIG.HOURLY_QUOTA_LIMIT}). Resets in ${(resetInMs / 1000 / 60).toFixed(1)} minutes`);
    return false;
  }

  return true;
}

function incrementQuota(): void {
  quotaTracker.callsThisHour++;
  console.log(`Quota used: ${quotaTracker.callsThisHour}/${CONFIG.HOURLY_QUOTA_LIMIT}`);
}

function formatTokenAmount(amount: bigint): string {
  // USDC has 6 decimals
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(6, '0').slice(0, 2)} USDC`;
}

async function main(): Promise<void> {
  const password = process.argv[2] || process.env.DECRYPT_PASSWORD;
  if (!password) {
    console.error('Password is required. Usage: npm start <password> [asset]');
    console.error('Or set DECRYPT_PASSWORD environment variable');
    process.exit(1);
  }

  const asset = process.argv[3] || CONFIG.ASSET;
  if (!CONFIG.PROXY_ADDRESS) {
    console.error('PROXY_ADDRESS is required (your Polymarket proxy wallet address).');
    process.exit(1);
  }

  console.log('Decrypting private key...');
  const privateKey = decryptPrivateKey(password);
  console.log('Private key decrypted successfully');

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(CONFIG.RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(CONFIG.RPC_URL),
  });

  const builderConfig = new BuilderConfig({ localBuilderCreds: getBuilderCreds() });
  const relayerUrl = CONFIG.RELAYER_URL || 'https://relayer-v2.polymarket.com/';
  const relayerType = CONFIG.RELAYER_TX_TYPE === 'PROXY' ? RelayerTxType.PROXY : RelayerTxType.SAFE;
  const relayer = new RelayClient(relayerUrl, CONFIG.CHAIN_ID, walletClient, builderConfig, relayerType);

  console.log(`EOA address: ${account.address}`);
  console.log(`Proxy address: ${CONFIG.PROXY_ADDRESS}`);
  console.log(`Relayer URL: ${relayerUrl}`);
  console.log(`Relayer type: ${relayerType}`);
  console.log(`Asset: ${asset}`);
  console.log(`Merge interval: ${CONFIG.MERGE_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`Min merge amount: ${formatTokenAmount(CONFIG.MIN_MERGE_AMOUNT)}`);
  console.log(`Batch size: ${CONFIG.BATCH_SIZE}`);
  console.log(`Hourly quota limit: ${CONFIG.HOURLY_QUOTA_LIMIT}`);

  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    await closeRedis();
    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('\nStarting merge loop...');

  while (!isShuttingDown) {
    try {
      // Check quota before starting cycle
      if (!checkAndUpdateQuota()) {
        console.log('Waiting for quota reset...');
        await sleep(CONFIG.MERGE_INTERVAL_MS);
        continue;
      }

      const markets = await fetchMarkets(asset);
      console.log(`\nFound ${markets.length} markets in Redis`);

      // Phase 1: Collect eligible merge candidates
      console.log('\nPhase 1: Scanning balances...');
      const candidates: MergeCandidate[] = [];
      let skippedZero = 0;
      let skippedBelowMin = 0;

      for (const market of markets) {
        try {
          const balances = await getTokenBalances(publicClient, CONFIG.PROXY_ADDRESS as Hex, market);
          const minBalance = balances.yesBalance < balances.noBalance ? balances.yesBalance : balances.noBalance;

          if (minBalance === 0n) {
            skippedZero++;
            continue;
          }

          if (minBalance < CONFIG.MIN_MERGE_AMOUNT) {
            skippedBelowMin++;
            continue;
          }

          candidates.push({ market, minBalance });
          console.log(`  [Eligible] ${market.marketSlug || market.conditionId}: ${formatTokenAmount(minBalance)}`);
        } catch (error) {
          console.error(`  Error checking ${market.marketSlug || market.conditionId}:`, error instanceof Error ? error.message : error);
        }
      }

      console.log(`\nScan complete: ${candidates.length} eligible, ${skippedZero} zero balance, ${skippedBelowMin} below minimum`);

      if (candidates.length === 0) {
        console.log('No eligible markets to merge');
        await sleep(CONFIG.MERGE_INTERVAL_MS);
        continue;
      }

      // Phase 2: Batch and execute merges
      console.log('\nPhase 2: Executing batched merges...');
      let mergedCount = 0;
      let errorCount = 0;

      // Process in batches
      for (let i = 0; i < candidates.length; i += CONFIG.BATCH_SIZE) {
        // Check quota before each batch
        if (!checkAndUpdateQuota()) {
          console.log('Quota exhausted mid-cycle. Stopping merges.');
          break;
        }

        const batch = candidates.slice(i, i + CONFIG.BATCH_SIZE);
        const batchNum = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(candidates.length / CONFIG.BATCH_SIZE);

        console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} transactions):`);

        // Build transactions for batch
        const transactions: Transaction[] = [];
        const batchMarketNames: string[] = [];

        for (const { market, minBalance } of batch) {
          const data = encodeFunctionData({
            abi: CTF_ABI,
            functionName: 'mergePositions',
            args: [
              USDC_ADDRESS,
              PARENT_COLLECTION_ID,
              market.conditionId as Hex,
              PARTITION,
              minBalance,
            ],
          });

          transactions.push({
            to: CTF_ADDRESS,
            data,
            value: '0',
          });

          const name = market.marketSlug || market.conditionId.slice(0, 10);
          batchMarketNames.push(name);
          console.log(`  - ${name}: ${formatTokenAmount(minBalance)}`);
        }

        // Execute batch with retry
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          try {
            const response = await relayer.execute(transactions, `merge batch ${batchNum}: ${batchMarketNames.join(', ')}`);
            incrementQuota();

            const result = await response.wait();
            if (!result) {
              throw new Error('Relayer returned no result.');
            }

            console.log(`  Status: ${result.state}`);
            if (result.transactionHash) {
              console.log(`  Tx: ${result.transactionHash}`);
            }

            mergedCount += batch.length;
            break;
          } catch (error) {
            attempts++;
            const backoffMs = getRelayerBackoffMs(error);

            if (backoffMs !== null) {
              // Check if quota is fully exhausted
              const errData = error as { data?: { error?: string } };
              const isQuotaExhausted = errData?.data?.error?.includes('0 units remaining');

              if (isQuotaExhausted) {
                console.error(`  Quota fully exhausted. Stopping all merges.`);
                // Mark quota as exhausted
                quotaTracker.callsThisHour = CONFIG.HOURLY_QUOTA_LIMIT;
                errorCount += batch.length;
                break;
              }

              if (attempts < maxAttempts) {
                console.warn(`  Rate limited (attempt ${attempts}/${maxAttempts}). Backing off for ${(backoffMs / 1000).toFixed(0)}s...`);
                await sleep(backoffMs);
                continue;
              }
            }

            console.error(`  Batch ${batchNum} failed:`, error instanceof Error ? error.message : JSON.stringify(error));
            errorCount += batch.length;
            break;
          }
        }

        // Delay between batches
        if (i + CONFIG.BATCH_SIZE < candidates.length) {
          await sleep(CONFIG.REQUEST_DELAY_MS);
        }
      }

      console.log(`\nMerge cycle complete: ${mergedCount} merged, ${errorCount} errors`);
    } catch (error) {
      console.error('Error in merge cycle:', error instanceof Error ? error.message : error);
    }

    console.log(`\nSleeping for ${CONFIG.MERGE_INTERVAL_MS / 1000 / 60} minutes...`);
    await sleep(CONFIG.MERGE_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
