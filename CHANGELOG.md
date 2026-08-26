# Changelog

## v1.1.0

A capability release, backward compatible with v1.0.0. Three migrations
(`0060`–`0062`), no data work, no default loosened. Everything below is either a
new capability that is **off** until armed, or a gate that refuses more than it
did before.

### Native appointment booking

Hermes can now fix an appointment **inside the conversation**: propose a slot,
read the answer in plain language, reserve it, and confirm it. No Calendly, no
Google Calendar, no CRM calendar, and no link for the prospect to open.

The anti-double-booking guarantee is not application code. It is a PostgreSQL
exclusion constraint over a **generated** time range, so two connections racing
for the same half-hour cannot both win — the loser reads a typed refusal. An
ambiguous date does not reserve. A stale slot is re-checked before the write. A
reservation is idempotent, and reschedule and cancel are first-class.

Configure `config/booking.json` before enabling it. `weeklyWindows` has **no
default**: an instance that has not declared its hours is a configuration error,
never "available at all times". The shipped file is a neutral starting point
(Mon–Fri, 09:00–18:00), not anyone's real availability.

`npm run booking:agenda` shows what is proposed, reserved and confirmed. The
prospect record gains an appointments card.

### First contact has its own bounded activation

The outbound rail had no arming gesture of its own — only caps, a window and the
kill switch, which are limits on *rhythm*, never a limit on *volume* that
somebody decided.

`npm run ig:autonomous:activation` is that decision, with the same three
properties as the auto-reply activation:

- a **frontier** written by the database, which no option can backdate;
- an explicit **budget** (`--max-effects <n>` or `--unbounded`, exclusive and one
  of them mandatory, so a forgotten option cannot produce an unlimited rail);
- a named **revocation**, and an effect counter that survives the process.

Without a live row the rail looks, says so, and waits. **This is stricter than
v1.0.0**: on an existing instance, first contact stops until you arm it.

### First-touch quality

**The goal of turn 1 is a reply, not a qualification.** The prompt used to ask
for two things at once — open a conversation, and qualify the acquisition
channel — and the second killed the first. The commercial conversation now
starts at turn 2, where the conversational runtime already knows how to conduct
it. No guardrail was removed to do this; a strategy changed, in the prompt.

**Sender-role protection.** A first message can ask a perfectly natural question
that makes its author look like a *customer* — your availability, whether you
take a single piece, which towns you cover. Read cold, that is a buyer writing.
They answer as a buyer, and the conversation starts on a misunderstanding Hermes
created. `detectBuyerRole` recognises **families** of buyer posture, in
interrogative spans only, so an observation in the past tense is never mistaken
for a request. It is code, it receives only text, and it is not a template
whitelist.

**Personalisation floor.** A completely generic message could go to somebody
about whom something *had* been observed: the prompt showed the hook, the model
ignored it, and nothing refused. `MISSING_GROUNDED_HOOK` now refuses that. No
semantic whitelist — the signal is vocabulary shared with a verified fact.

**Grounding precision.** `observationClaims` counted a *question* as a factual
claim. It now matches strictly less, never more, verified clause by clause
against a frozen corpus of 210 constructions.

**Angle diversity.** Curiosity directions follow the evidence actually observed
rather than a default question, so the same opening no longer reaches everyone.

### Trade vocabulary moved out of the code

Two lists of "words that distinguish nothing" were written into `src/`. The name
of a trade describes the whole target list — but Hermes knows nothing about a
trade until you declare one. Both now read `serviceTerms` and
`coreActivityTerms` from `config/niches/<key>.json`. Without a declaration both
gates stay **active and simply looser**; a test shows this in both directions.

### Operator-controlled manifest retirement

A locked send intent had no exit. A draft written under a superseded rule, a
prospect you no longer want to contact, a campaign you stopped: the manifest
stayed locked, the job stayed claimable, and the "one live intent per business"
constraint blocked preparing a better one.

`npm run ig:manifest:retire` is that exit, and it is bounded by code:
**simulation by default** (`--apply` required to write); a job that has touched
the world is refused, `external_effect_attempted` read *before* status; nothing
is deleted — the manifest becomes superseded, the job ineligible and terminal,
and the vote, draft, message and journal stay readable; the gesture is named and
journalled with the revision that wrote the draft.

A **deferred job stays retirable**: a `not_before` in the future says *when
sending may resume*, not whether the intent touched anybody. The send path still
honours `not_before` exactly as before.

### Fixes

- **Manifest history read backwards, half the time.** Ordering was on
  `locked_at` alone; two manifests locked in the same millisecond compared equal
  and PostgreSQL returned them in whichever order suited it. The order is now
  total.
- **Session identity.** "Connected" and "connected under our name" were treated
  as one proposition. A perfectly valid session belonging to somebody else could
  read as ready.
- **Certification** located the booking migration by number. A number depends on
  the lineage a migration shipped in; it is now found by name.
- **A published migration can no longer be edited.**
  `tests/migrationChecksums.test.ts` freezes the checksum of all 62 shipped
  migrations, because editing even a comment in an applied migration breaks
  `npm run db:migrate` on every instance that has applied it.

### Distribution hygiene

- the four runtime scripts no longer carry an absolute path naming a user
  account; Node is located with `command -v node`, with `HERMES_NODE_BIN_DIR` as
  the explicit override;
- `AUTONOMOUS_POLICY_VERSION` no longer names a trade. **This closes machine
  approvals granted under the previous version.** On a fresh instance that is a
  no-op; on a running one the queue refuses rather than sends, until the batch
  is re-approved;
- a stop-word list mixed universal filler with one trade's vocabulary; it now
  holds only what distinguishes nothing in *any* trade;
- one recycled account handle and around fifty broken elisions were repaired.

### Upgrading from v1.0.0

```bash
git pull && npm ci && npm run db:migrate && npm run validate && npm run hermes:certify
```

Three migrations apply. Two things need a decision rather than a command:

1. **First contact is off** until you run `ig:autonomous:activation`. This is
   deliberate.
2. **The autonomous policy version changed**, so machine approvals from before
   no longer cover the current rules. Re-approve the batch you want to send.

---

## v1.0.0

First self-hosted edition: the outbound and conversation engine, with the
operator's identity, offer, ICP and vertical removed and made configurable.
