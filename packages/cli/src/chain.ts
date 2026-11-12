// The two-provider read (C22), as the sealed job does it (`packages/sealed/src/reads.rs`): the
// first provider's final block fixes one height, every read that decides the answer is made at that
// height on both providers, and any disagreement stops the check with no result. Two honest
// providers run the same contract on the same state at the same block and return the same bytes,
// so a difference is a lie or a fault, never a race.
//
// Covered: the block, the code hash of the DAO and of the contracts a verdict pinned (callers pass
// only ids kaap-core accepts, so the id is safe to print), the code and the access keys of Kaap's
// guard and registry (named by the repository's deployment record), the factory's list of Sputnik
// versions, the proposal counter, the proposal and the policy. Not covered: both providers lying the
// same way (a named non-goal), and the history pages, which come from the first provider alone.
// They add the medium findings NEW_RECIPIENT and LARGE_AMOUNT, and for a proposal that is no longer
// open the policy in force before it is worked out, or rebuilt, from them, so in the advisory
// `kaap check` one provider's pages can lead to DESC_CONTRADICTS, a critical finding, through that
// policy.

import type { Core, ProposalRead } from './core.js';
import { MAX_VIEW_BODY_BYTES } from './caps.js';
import { type AccessKey, type AccountState, type Block, type Provider, RpcError, type View } from './rpc.js';

export class Held extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Held';
  }
}

/** Held because the second provider did not answer at all, so nothing was compared: a read that
 *  could not be made, which `kaap verify` shows as unread rather than as a failed check. */
export class Unanswered extends Held {
  constructor(message: string) {
    super(message);
    this.name = 'Unanswered';
  }
}

export class Reader {
  readonly primary: Provider;
  readonly secondary: Provider;
  readonly #core: Core;

  constructor(primary: Provider, secondary: Provider, core: Core) {
    this.primary = primary;
    this.secondary = secondary;
    this.#core = core;
  }

  get providers(): string[] {
    return [this.primary.name, this.secondary.name];
  }

  /** The first provider's final block, then the same height from the second. */
  async head(): Promise<Block> {
    const head = await this.primary.block('final');
    const other = await this.#second(`block ${head.height}`, () => this.secondary.block(head.height));
    if (other.hash !== head.hash || other.timestampNs !== head.timestampNs) throw new Held(`the two providers disagree on block ${head.height}`);
    return head;
  }

  /** Both providers' view of `account` at `block`; refuses unless they agree on its code. */
  async account(account: string, block: Block): Promise<AccountState> {
    const [a, b] = await this.#pair('the account', () => this.primary.account(account, block.height), () => this.secondary.account(account, block.height));
    this.#pinned('the account', a, block);
    this.#pinned('the account', b, block);
    if (a.codeHash !== b.codeHash || a.globalContractHash !== b.globalContractHash || a.globalContractAccount !== b.globalContractAccount) {
      throw new Held(`the two providers disagree on the code of ${account}`);
    }
    return a;
  }

  /** Both providers' access keys of `account` at `block`; refuses unless they name the same keys
   *  with the same permissions. */
  async accessKeys(account: string, block: Block): Promise<AccessKey[]> {
    const what = 'the access keys';
    const [a, b] = await this.#pair(what, () => this.primary.accessKeys(account, block.height), () => this.secondary.accessKeys(account, block.height));
    this.#pinned(what, a, block);
    this.#pinned(what, b, block);
    const listed = (keys: AccessKey[]) => JSON.stringify(keys.map((k) => [k.publicKey, k.permission]).sort());
    if (listed(a.keys) !== listed(b.keys)) throw new Held(`the two providers disagree on the access keys of ${account}`);
    return a.keys;
  }

  /** A view both providers must return byte for byte. */
  async sameView(what: string, account: string, method: string, args: object, block: Block): Promise<View> {
    const [a, b] = await this.#pair(what, () => this.primary.view(account, method, args, block.height), () => this.secondary.view(account, method, args, block.height));
    this.#pinned(what, a, block);
    this.#pinned(what, b, block);
    if (a.text !== b.text) throw new Held(`the two providers disagree on ${what}`);
    return a;
  }

  /** `sameView`, read as JSON. A view both providers return but that is not JSON holds. */
  async sameJson(what: string, account: string, method: string, args: object, block: Block): Promise<unknown> {
    const view = await this.sameView(what, account, method, args, block);
    try {
      return JSON.parse(view.text);
    } catch {
      throw new Held(`${what} is not JSON`);
    }
  }

  /** `sameJson` for a view an earlier build of the contract may not have. `absent` only when both
   *  providers say the contract has no such method at `block`; one saying so alone is a
   *  disagreement, and any other refusal is thrown as it comes. */
  async optionalJson(what: string, account: string, method: string, args: object, block: Block): Promise<{ value: unknown } | { absent: true }> {
    try {
      return { value: await this.sameJson(what, account, method, args, block) };
    } catch (e) {
      if (!(e instanceof RpcError) || !e.noMethod) throw e;
    }
    // Only the first provider's own refusal reaches here: one from the second, after the first
    // answered, is already a disagreement inside `sameJson`.
    try {
      await this.secondary.view(account, method, args, block.height);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      if (e.noMethod) return { absent: true };
      if (e.failure === 'unavailable' || e.failure === 'shape' || e.failure === 'too_large') {
        const why = `the second provider (${this.secondary.name}) could not be read for ${what}, so nothing can be compared`;
        throw e.failure === 'unavailable' ? new Unanswered(why) : new Held(why);
      }
    }
    throw new Held(`the two providers disagree on ${what}`);
  }

  /** The proposal from both providers, read by kaap-core's strict reader, with the kind compared
   *  in canonical form (Sputnik's sets can come back in another order) and every other field
   *  exactly. */
  async proposal(dao: string, id: number, block: Block): Promise<{ view: View; read: ProposalRead }> {
    const what = `proposal ${id}`;
    const [a, b] = await this.#pair(what, () => this.primary.view(dao, 'get_proposal', { id }, block.height, MAX_VIEW_BODY_BYTES), () => this.secondary.view(dao, 'get_proposal', { id }, block.height, MAX_VIEW_BODY_BYTES));
    this.#pinned(what, a, block);
    this.#pinned(what, b, block);
    const [ra, rb] = [this.#core.readProposal(a.text), this.#core.readProposal(b.text)];
    if (ra.id !== id) throw new Held(`the DAO answered with proposal ${ra.id} when asked for ${id}`);
    const sameKind = this.#core.canonicalKind(ra.kind_json) === this.#core.canonicalKind(rb.kind_json);
    const sameRest = ra.id === rb.id && ra.description === rb.description && ra.status === rb.status && ra.proposer === rb.proposer && ra.submission_time === rb.submission_time;
    if (!sameKind || !sameRest) throw new Held(`the two providers disagree on ${what}`);
    return { view: a, read: ra };
  }

  /** The policy from both providers, compared in canonical form. Returns the canonical text. */
  async policy(dao: string, block: Block): Promise<string> {
    const [a, b] = await this.#pair('the policy', () => this.primary.view(dao, 'get_policy', {}, block.height), () => this.secondary.view(dao, 'get_policy', {}, block.height));
    this.#pinned('the policy', a, block);
    this.#pinned('the policy', b, block);
    let canonical: string;
    try {
      canonical = this.#core.canonicalPolicy(a.text);
    } catch {
      throw new Held('the policy cannot be read by kaap-core');
    }
    let other: string | null = null;
    try {
      other = this.#core.canonicalPolicy(b.text);
    } catch {
      other = null;
    }
    if (other !== canonical) throw new Held('the two providers disagree on the policy');
    return canonical;
  }

  async #pair<T>(what: string, first: () => Promise<T>, second: () => Promise<T>): Promise<[T, T]> {
    const a = await first();
    const b = await this.#second(what, second);
    return [a, b];
  }

  async #second<T>(what: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      if (e.failure === 'unavailable' || e.failure === 'shape' || e.failure === 'too_large') {
        const why = `the second provider (${this.secondary.name}) could not be read for ${what}, so nothing can be compared`;
        throw e.failure === 'unavailable' ? new Unanswered(why) : new Held(why);
      }
      // The first provider answered this same read, so a refusal here is a disagreement.
      throw new Held(`the two providers disagree on ${what}`);
    }
  }

  #pinned(what: string, answer: { blockHeight: number; blockHash: string }, block: Block): void {
    if (answer.blockHeight !== block.height || answer.blockHash !== block.hash) throw new Held(`${what} was not read at block ${block.height}`);
  }
}
