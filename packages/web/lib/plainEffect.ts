// One plain sentence for each effect kaap-core can name (packages/core/src/types.rs, `Effect`).
// This is wording only: what the request does was decided by the engine, and every account, key
// and amount in a sentence is the engine's own value. An effect in a shape this file does not
// expect gets no sentence, and the page then shows its fields as they are.

type Fields = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const YOCTO_PER_NEAR = 24;

// The three tokens NEAR treasuries pay in most, by the contract that issues each. Any other token
// is shown by its contract's account, which is its only certain name.
const TOKEN_NAMES: Record<string, string> = {
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 'USDC',
  'usdt.tether-token.near': 'USDT',
  'wrap.near': 'wrapped NEAR',
};

/** A whole-number amount in a token's smallest unit, written with its decimal point. */
export function withDecimals(amount: string, decimals: number): string {
  const digits = amount.padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction.slice(0, 6)}${fraction.length > 6 ? '…' : ''}` : whole;
}

/** "12.5 NEAR", "3 USDC" where the decimals are known, else the raw count and the token's name. */
function sum(amount: unknown, token: unknown, decimals: Record<string, number>): string | null {
  const count = text(amount);
  if (count === null || !/^\d{1,60}$/.test(count)) return null;
  if (token === 'near') return `${withDecimals(count, YOCTO_PER_NEAR)} NEAR`;
  const name = text(token);
  if (name === null) return null;
  const places = decimals[name];
  const known = TOKEN_NAMES[name];
  if (places === undefined) return `${count} of the smallest unit of ${known ?? name}`;
  return known ? `${withDecimals(count, places)} ${known}` : `${withDecimals(count, places)} of ${name}`;
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const listed = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function policyChange(effect: Fields): string {
  const parts: string[] = [];
  const added = names(effect.roles_added);
  const removed = names(effect.roles_removed);
  if (added.length) parts.push(`adds the ${added.length === 1 ? 'role' : 'roles'} ${listed(added)}`);
  if (removed.length) parts.push(`removes the ${removed.length === 1 ? 'role' : 'roles'} ${listed(removed)}`);
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  const membersIn = count(effect.members_added);
  const membersOut = count(effect.members_removed);
  if (membersIn) parts.push(`puts ${membersIn} ${membersIn === 1 ? 'account' : 'accounts'} into roles`);
  if (membersOut) parts.push(`takes ${membersOut} ${membersOut === 1 ? 'account' : 'accounts'} out of roles`);
  if (count(effect.permissions_changed)) parts.push('changes what roles are allowed to do');
  if (count(effect.vote_policy_changed)) parts.push('changes how many votes pass a request');
  if (effect.bond_or_period_changed === true) parts.push('changes the bond or the voting period');
  if (parts.length === 0) {
    return effect.before_unknown === true
      ? "Changes who decides in this treasury. Kaap could not read the rules before it, so it cannot say what changes."
      : 'Rewrites the rules of who decides in this treasury, with no change Kaap can name.';
  }
  return `Changes who decides in this treasury: ${listed(parts)}.`;
}

/** The sentence for one effect, or null where there is none to give. */
export function plainEffect(effect: Fields, decimals: Record<string, number> = {}): string | null {
  const to = text(effect.to);
  switch (effect.type) {
    case 'transfer': {
      const amount = sum(effect.amount, effect.token, decimals);
      return amount && to ? `Pays ${amount} to ${to}.` : null;
    }
    case 'token_call_transfer': {
      const amount = sum(effect.amount, effect.token, decimals);
      if (!amount || !to) return null;
      if (effect.msg_kind === 'empty') return `Sends ${amount} to the contract ${to}.`;
      if (effect.msg_kind === 'intents_deposit') return `Deposits ${amount} into NEAR Intents through ${to}.`;
      return `Sends ${amount} to the contract ${to}, with a message telling that contract what to do with it.`;
    }
    case 'intents_withdraw': {
      const amount = sum(effect.amount, effect.token, decimals);
      const address = text(effect.address);
      const chain = text(effect.chain);
      return amount && address && chain
        ? `Withdraws ${amount} from the treasury's NEAR Intents balance to ${address}${chain === 'near' ? '' : ` on ${chain}`}.`
        : null;
    }
    case 'intents_transfer': {
      const amount = sum(effect.amount, effect.token, decimals);
      return amount && to ? `Moves ${amount} inside NEAR Intents to ${to}.` : null;
    }
    case 'intents_swap':
      return "Swaps tokens inside the treasury's NEAR Intents balance.";
    case 'intents_key_change': {
      const key = text(effect.public_key);
      if (!key) return null;
      return effect.op === 'add'
        ? `Adds the key ${key} to the treasury's NEAR Intents account. Whoever holds that key controls the funds there.`
        : `Removes the key ${key} from the treasury's NEAR Intents account.`;
    }
    case 'wrap': {
      const amount = sum(effect.amount, 'near', decimals);
      if (!amount) return null;
      return effect.op === 'unwrap' ? `Turns ${amount.replace(' NEAR', ' wrapped NEAR')} back into NEAR.` : `Wraps ${amount} into wrapped NEAR.`;
    }
    case 'staking': {
      const amount = sum(effect.amount, 'near', decimals);
      const pool = text(effect.pool);
      const op = text(effect.op);
      return amount && pool && op ? `Staking at ${pool}: ${op.replaceAll('_', ' ')}, ${amount}.` : null;
    }
    case 'storage_deposit': {
      const amount = sum(effect.amount, 'near', decimals);
      const contract = text(effect.contract);
      const account = text(effect.for_account);
      return amount && contract && account ? `Pays ${amount} for ${account}'s storage on ${contract}.` : null;
    }
    case 'guard_enrol': {
      const guard = text(effect.guard);
      const amount = sum(effect.deposit, 'near', decimals);
      return guard && amount ? `Enrols this treasury in Kaap's guard ${guard}, attaching ${amount} for storage.` : null;
    }
    case 'defi_call': {
      const protocol = text(effect.protocol);
      const summary = text(effect.summary);
      return protocol && summary ? `Calls ${protocol}: ${summary}` : null;
    }
    case 'bulk_payment': {
      const total = sum(effect.total, 'near', decimals);
      const contract = text(effect.contract);
      const list = text(effect.list_id);
      return total && contract && list ? `Pays out the list ${list} through ${contract}: ${total} in all.` : null;
    }
    case 'sign_request': {
      const signer = text(effect.mpc);
      if (!signer) return null;
      const opening = `Asks NEAR's signing service (${signer}) to sign a hash in the treasury's name.`;
      return effect.text_supplied === true
        ? `${opening} The text behind the hash was given and matches it.`
        : `${opening} The request shows only the hash, so nothing here says what the signature will do.`;
    }
    case 'policy_change':
      return policyChange(effect);
    case 'config_change': {
      const name = text(effect.name);
      return name ? `Changes the treasury's own settings. Its name will be "${name}".` : null;
    }
    case 'code_upgrade': {
      const target = text(effect.target);
      const hash = text(effect.code_hash);
      if (!target || !hash) return null;
      return `Replaces the code of ${target === 'self' ? 'the treasury itself' : target} with code whose hash is ${hash}.`;
    }
    case 'other_kind': {
      const summary = text(effect.summary);
      return summary ?? null;
    }
    case 'unknown_call': {
      const receiver = text(effect.receiver);
      const method = text(effect.method);
      if (!receiver || !method) return null;
      const attached = text(effect.deposit) && effect.deposit !== '0' ? sum(effect.deposit, 'near', decimals) : null;
      return `Calls "${method}" on ${receiver}${attached ? `, attaching ${attached}` : ''}. Kaap does not know what this call does.`;
    }
    default:
      return null;
  }
}
