/** The Sputnik proposal kinds that change the DAO's policy (guide section 7). */
export const POLICY_KINDS = ["ChangePolicy", "ChangePolicyAddOrUpdateRole", "ChangePolicyRemoveRole", "ChangePolicyUpdateDefaultVotePolicy", "ChangePolicyUpdateParameters", "AddMemberToRole", "RemoveMemberFromRole"];

/** The kind's name: a kind is either a bare string ("Vote") or an object with one key. */
export const kindOf = (k) => (typeof k === "string" ? k : Object.keys(k)[0]);

/**
 * The policy after a policy kind runs on `before`, applied the way the Sputnik 3.2 contract
 * applies it: add_or_update_role replaces the first role of that name or appends it, adding a
 * member to a role that does not exist changes nothing (guide section 7), and a full ChangePolicy
 * is simply the new policy. `before` is never modified.
 */
export function policyAfter(kind, body, before) {
  const p = JSON.parse(JSON.stringify(before));
  switch (kind) {
    case "ChangePolicy": return body.policy;
    case "AddMemberToRole": for (const r of p.roles) if (r.name === body.role && r.kind.Group && !r.kind.Group.includes(body.member_id)) r.kind.Group.push(body.member_id); return p;
    case "RemoveMemberFromRole": for (const r of p.roles) if (r.name === body.role && r.kind.Group) r.kind.Group = r.kind.Group.filter((m) => m !== body.member_id); return p;
    case "ChangePolicyAddOrUpdateRole": { const i = p.roles.findIndex((r) => r.name === body.role.name); if (i < 0) p.roles.push(body.role); else p.roles[i] = body.role; return p; }
    case "ChangePolicyRemoveRole": p.roles = p.roles.filter((r) => r.name !== body.role); return p;
    case "ChangePolicyUpdateDefaultVotePolicy": p.default_vote_policy = body.vote_policy; return p;
    case "ChangePolicyUpdateParameters": for (const k of ["proposal_bond", "proposal_period", "bounty_bond", "bounty_forgiveness_period"]) if (body.parameters[k] != null) p[k] = body.parameters[k]; return p;
    default: throw new Error(`${kind} is not a policy kind`);
  }
}
