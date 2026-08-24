# Hermes

Hermes is a **self-hosted outbound and conversation engine**. It finds
businesses, qualifies them against an ICP you define, drafts a first message,
reads the replies that come back, and — once you have explicitly told it to —
answers them.

It is built around one idea: **nothing is sent until a human says so, by name.**
The resting state is silence. Installing Hermes, connecting an account, starting
the services and importing prospects are, together, still not enough to make it
message anybody.

## This is your instance, and only yours

Hermes is not a service you sign into. You run it, on your machine or your
server, against your own database, your own accounts, your own model provider.

**Never reuse another operator's credentials, cookies, browser profile,
database or prospect data.** They are theirs, the people in them did not consent
to you, and a shared session is how an account gets banned. Every account below
must be one you own or have been given explicit permission to use.

This edition ships with **no ICP, no vertical, no prospects, no offer and no
message examples**. Those are yours to write. There is a guided workflow for it.

## Getting started

The setup is written for an AI coding agent to run with you, because most of it
is detection and verification rather than typing.

```
git clone <your-copy-of-this-repo> hermes
cd hermes
claude
```

Then tell it:

> Set this project up for me and follow CLAUDE_SETUP.md.

It will audit your machine, install what is genuinely missing, walk you through
the accounts only you can create, help you define your ICP, and stop at every
point that needs a human decision. It ends with a **zero-effect smoke test**:
proof that the engine runs and that nothing left the building.

Doing it by hand is possible — `CLAUDE_SETUP.md` is readable — but it is long,
and the order matters.

## What you will need

- Node.js 22+, git, and roughly 3 GB of free disk (a browser engine is
  downloaded).
- A PostgreSQL database you control (local, or a managed one). A file-backed
  fallback exists for trying things out.
- An account for whatever channel you intend to use, logged in interactively by
  you.
- A model provider you have access to.

None of these are checked at install time by faith: the setup probes each one
and tells you which are actually working.

## Before you send anything

Read `SECURITY.md`. It is short, and it covers the parts that can affect other
people: what the safety gates are, what they do not cover, and the legal
obligations that are yours and not the software's.

## Licence

See `LICENSE`. This edition is **not** open source and comes with no warranty.
