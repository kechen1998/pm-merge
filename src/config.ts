// ============================================================================
// Polymarket Merge System - Configuration
// ============================================================================

import dotenv from 'dotenv';
import path from 'path';
import { Config } from './types';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// USDC has 6 decimals, so 10 USDC = 10_000_000
const parseMinMergeAmount = (): bigint => {
  const envValue = process.env.MIN_MERGE_AMOUNT;
  if (envValue) {
    return BigInt(envValue);
  }
  return 10_000_000n; // Default: 10 USDC
};

export const CONFIG: Config = {
  // Redis
  REDIS_URL: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}/${process.env.REDIS_DB || '0'}`,
  METADATA_KEY_PREFIX: 'pm:metadata:',

  // Blockchain
  RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
  CHAIN_ID: Number(process.env.CHAIN_ID) || 137,

  // Encrypted private key
  ENCRYPT_PRIVATE_KEY: process.env.ENCRYPT_PRIVATE_KEY || '',

  // Asset
  ASSET: process.env.ASSET || 'bitcoin',

  // Polymarket proxy wallet (where positions are held)
  PROXY_ADDRESS: process.env.PROXY_ADDRESS || '',

  // Relayer configuration
  RELAYER_URL: process.env.RELAYER_URL || '',
  RELAYER_TX_TYPE: process.env.RELAYER_TX_TYPE || 'SAFE',

  // Merge settings
  MERGE_INTERVAL_MS: Number(process.env.MERGE_INTERVAL_MS) || 30 * 60 * 1000, // 30 minutes
  REQUEST_DELAY_MS: Number(process.env.REQUEST_DELAY_MS) || 5000, // 5s delay between batches
  MIN_MERGE_AMOUNT: parseMinMergeAmount(), // Minimum balance to merge (default: 10 USDC)
  BATCH_SIZE: Number(process.env.BATCH_SIZE) || 10, // Max transactions per batch
  HOURLY_QUOTA_LIMIT: Number(process.env.HOURLY_QUOTA_LIMIT) || 20, // Max API calls per hour
};
