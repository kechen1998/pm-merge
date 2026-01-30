export interface ContractConfig {
  negRiskAdapter: string;
  conditionalTokens: string;
  collateral: string;
}

export interface MarketMetadata {
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  marketSlug?: string;
  eventSlug?: string;
  eventId?: string;
  underlying?: string;
  strike?: number;
  expiry?: string;
  tickSize?: number;
}

export interface TokenBalance {
  yesBalance: bigint;
  noBalance: bigint;
}

export interface Config {
  // Redis
  REDIS_URL: string;
  METADATA_KEY_PREFIX: string;

  // Blockchain
  RPC_URL: string;
  CHAIN_ID: number;

  // Encrypted private key
  ENCRYPT_PRIVATE_KEY: string;

  // Asset
  ASSET: string;

  // Polymarket proxy wallet (where positions are held)
  PROXY_ADDRESS: string;

  // Relayer configuration
  RELAYER_URL: string;
  RELAYER_TX_TYPE: string;

  // Merge settings
  MERGE_INTERVAL_MS: number;
  REQUEST_DELAY_MS: number;
}
