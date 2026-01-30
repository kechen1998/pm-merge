import CryptoJS from 'crypto-js';
import { CONFIG } from './config';
import { fetchMarkets, closeRedis } from './redis';
import { CTF_ABI, CTF_ADDRESS, PARTITION, PARENT_COLLECTION_ID, USDC_ADDRESS } from './ctf';
import { createPublicClient, createWalletClient, encodeFunctionData, Hex, http, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { BuilderApiKeyCreds, BuilderConfig } from '@polymarket/builder-signing-sdk';
import { RelayClient, RelayerTxType, Transaction } from '@polymarket/builder-relayer-client';
import { MarketMetadata } from './types';

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
      const markets = await fetchMarkets(asset);
      console.log(`\nFound ${markets.length} markets in Redis`);

      let mergedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        if (i > 0) {
          await sleep(CONFIG.REQUEST_DELAY_MS);
        }

        try {
          const balances = await getTokenBalances(publicClient, CONFIG.PROXY_ADDRESS as Hex, market);
          const minBalance = balances.yesBalance < balances.noBalance ? balances.yesBalance : balances.noBalance;
          if (minBalance === 0n) {
            skippedCount++;
            continue;
          }

          console.log(`\nMarket: ${market.marketSlug || market.conditionId}`);
          console.log(`  YES: ${balances.yesBalance.toString()}, NO: ${balances.noBalance.toString()}`);
          console.log(`  Merging ${minBalance.toString()} tokens via relayer...`);

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

          const tx: Transaction = {
            to: CTF_ADDRESS,
            data,
            value: '0',
          };

          const response = await relayer.execute([tx], `merge ${market.marketSlug || market.conditionId}`);
          const result = await response.wait();
          console.log(`  Relayer status: ${result.state}`);
          if (result.transactionHash) {
            console.log(`  Tx: ${result.transactionHash}`);
          }
          if (result.proxyAddress && result.proxyAddress.toLowerCase() !== CONFIG.PROXY_ADDRESS.toLowerCase()) {
            console.warn(`  Warning: relayer used proxy ${result.proxyAddress}, expected ${CONFIG.PROXY_ADDRESS}`);
          }
          mergedCount++;
        } catch (error) {
          console.error(`  Error merging ${market.marketSlug || market.conditionId}:`, error instanceof Error ? error.message : error);
          errorCount++;
        }
      }

      console.log(`\nMerge cycle complete: ${mergedCount} merged, ${skippedCount} skipped, ${errorCount} errors`);
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
