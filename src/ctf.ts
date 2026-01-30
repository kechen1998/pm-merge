// ============================================================================
// Polymarket CTF constants (Polygon)
// ============================================================================

export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const PARENT_COLLECTION_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const PARTITION = [1n, 2n];

export const CTF_ABI = [
  {
    type: 'function',
    name: 'mergePositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'partition', type: 'uint256[]' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
