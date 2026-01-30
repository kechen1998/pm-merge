// ============================================================================
// Polymarket Merge System - Redis Client
// ============================================================================

import Redis from 'ioredis';
import { CONFIG } from './config';
import { MarketMetadata } from './types';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(CONFIG.REDIS_URL);
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Fetch all market metadata from Redis
 * Key format: pm:metadata:{asset}, fields are condition IDs, values are JSON metadata
 */
export async function fetchMarkets(asset: string): Promise<MarketMetadata[]> {
  const redis = getRedisClient();
  const key = `${CONFIG.METADATA_KEY_PREFIX}${asset}`;

  // HGETALL returns all fields and values
  const data = await redis.hgetall(key);

  const markets: MarketMetadata[] = [];
  for (const [conditionId, jsonValue] of Object.entries(data)) {
    try {
      const metadata = JSON.parse(jsonValue) as MarketMetadata;
      if (!metadata?.yesTokenId || !metadata?.noTokenId || !metadata?.conditionId) {
        console.error(`Invalid metadata for ${conditionId}: missing token IDs or condition ID`);
        continue;
      }
      markets.push(metadata);
    } catch (e) {
      console.error(`Failed to parse metadata for ${conditionId}:`, e);
    }
  }

  return markets;
}
