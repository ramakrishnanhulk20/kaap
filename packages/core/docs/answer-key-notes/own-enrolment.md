# Kaap reads its own enrolment, and one place for two verdict fields

## What the two enrolment drafts read as now

`kaap_core_wasm::api::enrolment_drafts` for kaap-guard-1029061211.testnet, handed to `analyze` as
the CLI hands them over (guard account set, the testnet demo DAO's policy before enrolment, no
prices):

| draft | before this change | now |
|---|---|---|
| add the guard role | GUARD_WEAKENED (high) | no finding, floor low |
| `enroll` on the guard | UNKNOWN_CALL and UNKNOWN_VALUE (high), ATTACHED_DEPOSIT | one `guard_enrol` effect, no finding, floor low |

The drafts' text is byte for byte what it was before the template moved into kaap-core (compared
on the printed JSON before and after).

## Readings the new code rests on

1. **The template is one item.** `kaap_core::enrolment` holds the role (`role`), its labels, the
   left-out label, the method, the deposit and the gas. core-wasm builds its drafts from it, and
   `policy::change` reads the role back through Sputnik's own role parser, so the drafts and their
   reading cannot drift apart.
2. **Enrolment is the exact template role and nothing else (ruling of 2 Nov).** GUARD_WEAKENED,
   with the guard account known, skips only a change where no role is called `guard` before,
   exactly the template's role is the one role called `guard` after, and the guard could cast no
   VoteReject on any of the template's labels before, through any role. A second member, any
   right more or less, any changed rule (even "2" or [1, 2], which still need one vote from a
   group of one), a `guard` role already there, or a change to another role that holds the guard
   all still fire. The test that the guard loses no reject right still runs on every change.
3. **A guard that can already reject still fires (accepted, fail closed).** A DAO with an Everyone
   or token role that may VoteReject gives the guard reject rights before enrolment, so its
   enrolment is not "only rights it did not have" and GUARD_WEAKENED fires.
4. **No policy before still fires.** Without the policy before, the guard's roles are not known,
   so a role named `guard` keeps firing GUARD_WEAKENED, as before this change.
5. **`guard_enrol` is read only in the template's shape (accepted).** The receiver is exactly
   `ProposalInput::guard_account`, the method exactly `enroll`, the arguments `{}` or empty (empty
   arguments are no arguments, ruling 2), and the deposit at most 0.01 NEAR, the template's own
   deposit (packages/contracts/GAS.md line 31). A larger deposit, any argument, any other method on
   the guard, `enroll` on any other account, or no guard account leaves the call as it was: an
   unknown call. A guard account that is one of the exact known accounts (`intents.near` and the
   rest) is not read as a guard. The deposit is the effect, not a payment: no ATTACHED_DEPOSIT and
   no UNKNOWN_VALUE, since the guard keeps only its storage cost and refunds the rest to the DAO.
6. **`receivers_hash` takes the pairs and sorts them (ruling of 2 Nov).** It is the sealed job's
   function (packages/sealed/src/reads.rs lines 191 to 219) with the sort moved inside, so it
   gives the same bytes on the sealed job's already sorted list and the right hash on any order.
   Pinned on the receivers list of the sealed job's transfer-ft fixture:
   `3e45bc50874d22357a5da82e3a5721c951a8d36dd0b8f16d0f6946978c9ccefb`, printed by
   `kaap_sealed::reads::receivers_hash`. `DECODER_VERSION` is kaap-core's version, the same
   workspace version kaap-sealed wrote ("0.1.0", packages/sealed/src/verdict.rs line 18).

## Guide lines to add (v2.4)

Section 3, the effects table, after `storage_deposit`:

| `guard_enrol` | `guard`, `deposit` | `enroll` on the enrolled guard account, with no arguments and at most 0.01 NEAR attached: the DAO enrolling in Kaap's guard. The attached NEAR is this effect; the guard keeps its storage cost and refunds the rest |

Section 4, `ATTACHED_DEPOSIT`: add `guard_enrol` to the effects whose deposit does not fire it.

Section 4, `GUARD_WEAKENED`: add "Adding exactly Kaap's enrolment role (the role named `guard`,
the guard account its only member, VoteReject on every label but `remove_member_from_role`, one
vote deciding on each) to a policy with no `guard` role, where the guard could not reject before,
arms the guard and does not fire it."

Rulings: "`enroll` on any account other than the enrolled guard account, or with arguments or more
than 0.01 NEAR attached, is an `unknown_call`."

## Not covered

No answer-key record holds an enrolment, and the evaluation runner leaves the guard account unset,
so the scoreboards do not exercise this code; the tests in `tests/enrol_*.rs` and core-wasm's
`api::tests` do.
