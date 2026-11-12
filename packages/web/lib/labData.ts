import fixture from '@/lab-fixtures/hash-proposal.json';

export interface Effect {
  type: string;
  [field: string]: unknown;
}

export interface Reading {
  riskFloor: string;
  findingCodes: string[];
}

// Effect kinds from the one a reader should hear about first to the last. A kind not listed here
// ranks below all of these and is reported by the engine's own name.
const SEVERITY_ORDER = ['intents_key_change', 'sign_request'];

const word = (value: unknown) => (typeof value === 'string' ? value : '');

/** One plain sentence about the most severe effect, with the engine's own values in fixed words. */
export function effectSentence(effects: Effect[]): string {
  const rank = (effect: Effect) => {
    const place = SEVERITY_ORDER.indexOf(effect.type);
    return place === -1 ? SEVERITY_ORDER.length : place;
  };
  const worst = [...effects].sort((a, b) => rank(a) - rank(b))[0];
  if (!worst) return '';

  if (worst.type === 'intents_key_change') {
    const key = word(worst.public_key);
    const treasury = word(effects.find((effect) => effect.type === 'sign_request')?.path);
    const account = treasury ? `the Intents account of ${treasury}` : 'an Intents account';
    if (key && worst.op === 'add') return `Adds the key ${key} to ${account}.`;
    if (key && worst.op === 'remove') return `Removes the key ${key} from ${account}.`;
  }
  if (worst.type === 'sign_request') {
    const signer = word(worst.mpc);
    const path = word(worst.path);
    if (signer && path) return `Asks ${signer} to sign a hash for ${path}.`;
  }
  return worst.type;
}

const analyses = {
  withoutText: fixture.analysis_without_text.analysis,
  withText: fixture.analysis_with_text.analysis,
};

const reading = (analysis: { risk_floor: string; findings: { code: string }[] }): Reading => ({
  riskFloor: analysis.risk_floor,
  findingCodes: analysis.findings.map((finding) => finding.code),
});

export const hashHex: string = fixture.payload_hash_hex;
if (hashHex.length !== 64) throw new Error('the saved payload hash is not 64 characters');

export const proposalId: number = fixture.proposal.id;
export const description: string = fixture.proposal.description;
export const withoutText = reading(analyses.withoutText);
export const withText = reading(analyses.withText);
export const effects: Effect[] = analyses.withText.effects;
export const sentence = effectSentence(effects);
