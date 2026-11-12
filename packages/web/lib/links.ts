import proof from '@/data/proof.json';

/** The check page, opened on the disguised payment the guard rejected on testnet. */
export const STOPPED_THEFT = `/check?dao=${proof.treasury.account}&network=${proof.network}&id=${proof.stopped.proposalId}`;

/** The check page, opened on the demo treasury's request that shows only a hash. */
export const HASH_ONLY = `/check?dao=${proof.demoText.dao}&network=${proof.network}&id=${proof.demoText.proposalId}`;

const EXPLORER = 'https://testnet.nearblocks.io';

export const accountLink = (id: string) => `${EXPLORER}/address/${id}`;
export const transactionLink = (hash: string) => `${EXPLORER}/txns/${hash}`;
