# Security and safe operation

Hermes contacts real people. This document is about the parts that can affect
someone other than you.

## The resting state is silence

Nothing here sends by default. Installing Hermes, connecting an account,
starting the workers and importing prospects are, together, still not enough to
message anybody.

Three separate things must be true before a real message leaves:

1. **The global kill switch is released** — a persisted, named human gesture.
2. **An authorisation exists for that channel** — first contact and auto-reply
   are distinct authorisations. Neither implies the other.
3. **The pre-effect gate passes, immediately before the effect** — not at the
   start of the cycle. Re-engaging the kill switch while a browser is open stops
   *that* message, not merely the next one.

## What the gates actually guarantee

| Guarantee | What it means |
|---|---|
| No auto-reply to unknown senders | A reply requires a proven prior outbound to that business, on that transport. Receiving a DM has never been enough to authorise answering it. |
| No auto-reply to the backlog | Activation records a frontier at `now()`, written by the database. Messages received before it can never trigger an autonomous reply — not at start-up, not after a crash. It cannot be backdated. |
| Fail-closed | A missing, unreadable or ambiguous fact refuses. Absence of proof is never proof of absence. |
| Exclusive browser lease | One profile, one owner at a time, released after every turn. |
| Destination identity checks | The thread, the account and the recipient are re-read on the page before an effect, not trusted from the plan. |
| Idempotency | A trigger that already carries an attempted effect is never replayed — including when the outcome was ambiguous. An ambiguous attempt is terminal. |
| Caps and window | Daily cap, hourly cap, minimum spacing, and a send window. Shared by every rail; there is no second counter and no second scheduler. |
| Bounded activation | An activation can carry a maximum number of effects and stop by itself. |
| First contact is separable | Auto-reply and cold outreach are authorised independently. |

## What the gates do **not** cover

Be honest with yourself about these:

- **They do not judge whether your message is appropriate.** Guards catch
  fabricated numbers, unfounded promises, missing disclosures and jargon. They
  cannot tell you that contacting a particular business is a bad idea.
- **They do not make you compliant.** See below.
- **They are not tamper-proof against you.** You have the source. Every gate is
  code you could edit. They protect against mistakes, drift and forgetfulness —
  not against a determined operator overriding their own safety rails. If you
  disable one, you own what follows.
- **They do not cover a platform's own rules.** Caps and spacing are chosen to
  be conservative, not to guarantee an account survives.

## Your legal obligations are yours

This software does not make you compliant with anything, and nothing in it
should be read as legal advice.

Cold outreach to businesses and individuals is regulated, and the rules differ
by jurisdiction, by channel and by whether the recipient is a company or a
person. Depending on where you and your recipients are, you may need a lawful
basis for processing personal data, a way to identify yourself in every message,
a working opt-out that you honour promptly, a retention limit, and a record of
where each contact detail came from.

Hermes gives you the *mechanics* to do these things — evidence provenance on
every field, a suppression list honoured before any send, an audit trail of who
authorised what and when. Using them is your responsibility. **Find out what
applies to you before your first send, not after your first complaint.**

## Handling other people's data

The prospect database contains information about real businesses and real
people, much of it personal data.

- Do not import another instance's prospects. Their contact history and their
  opt-outs do not travel with a CSV, and neither does their consent.
- Honour suppression immediately. When someone asks not to be contacted, that is
  a permanent fact about them, not a campaign setting.
- Keep the database off shared hosts, out of backups you do not control, and out
  of screenshots.

## Credentials

- Everything lives locally: `.env` (gitignored, `chmod 600`), the browser
  profile under `var/`, and provider tokens wherever the provider puts them.
- **Never use another operator's credentials, cookies, browser profile or
  `auth.json`.** Not to "test", not to "get started faster".
- Prefer interactive login over pasted secrets. Never paste an account password
  into an AI chat window — log in through the browser window the tool opens.
- Rotate anything that has ever been in a log, a terminal recording, a chat
  transcript or a screenshot. Treat it as public.

Before any commit, the repo ships a deterministic scan:

```bash
scripts/check-secrets.sh
```

## If something goes wrong

```bash
npm run ig:kill-switch -- --engage --as "<your name>" --reason "<what you saw>"
```

That is the first thing to type, before diagnosing. It is global, it is
persisted, it survives a restart, and it is re-read immediately before every
effect. Then stop the workers, read `npm run autoreply:status`, and look at what
was actually sent before deciding anything.

## Reporting a vulnerability

This is self-hosted software with no vendor behind it. If you find a flaw in a
safety gate, report it to whoever gave you this copy, and describe the path
concretely — which gate, which input, which effect it let through.
