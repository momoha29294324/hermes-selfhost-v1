# Setting up Hermes — instructions for the agent

You are setting up a **fresh, isolated Hermes instance for this user.**

Treat this repository as **software only**. Do not assume that any existing
credential, database, social account, prospect corpus, ICP, model subscription
or deployment host belongs to this user. Nothing in this repo was configured for
them.

**Never reuse another operator's credentials or data.** If you find a `.env`, a
browser profile, an `auth.json`, a cookie jar or a populated database on this
machine, do not assume it is theirs to use. Ask. A shared session is how an
account gets suspended, and a borrowed prospect list is other people's personal
data.

**You cannot make this system send anything.** Every path to a real message is
gated behind a named human decision that you are not permitted to make on the
user's behalf. This is not an obstacle to work around — it is the product.
Your job ends at "ready, and proven idle".

---

## How to read this document

Each step has the same shape:

- **Detect** — find out what is already true. Never install what exists.
- **Act** — the safe, automatable part.
- **Verify** — the observable fact that says the step actually worked.
- **Stop if** — the conditions under which you must hand back to the human.

Do the steps in order. Later steps assume earlier verifications passed.

If a command differs on this machine (different path, different package
manager, different init system), adapt it — but never skip its **Verify**. A
step you could not verify is a step that did not happen; say so rather than
moving on.

---

## Step 0 — Establish what you are looking at

**Detect**

```bash
uname -srm; node -v; npm -v; git --version
git rev-parse --is-inside-work-tree 2>/dev/null && git log --oneline -1
ls -la | head -30
[ -f .env ] && echo "A .env ALREADY EXISTS" || echo "no .env"
[ -d node_modules ] && echo "node_modules present" || echo "no node_modules"
[ -d var ] && ls -la var 2>/dev/null
```

**Interpret**

- `.env` present → someone configured this before. **Do not overwrite it.** Read
  it only to list which keys are set (never echo values), and ask the user
  whether this is their own prior install or someone else's copy.
- `var/` present with content → there may be a database and a browser profile
  from a previous install. Same question.
- A clean tree with no `.env` and no `var/` → a genuine fresh install. Proceed.

**Stop if** the working tree is dirty and the user did not expect it. Show
`git status` and ask before touching anything.

---

## Step 1 — Audit the machine

**Detect** — gather all of this before installing anything:

```bash
# OS, architecture, memory, disk
uname -a
[ "$(uname)" = "Darwin" ] && sysctl -n hw.memsize hw.ncpu || (free -h; nproc)
df -h .

# Toolchain
node -v; npm -v; git --version
command -v psql && psql --version || echo "no psql"
command -v docker && docker --version || echo "no docker"
command -v codex && codex --version || echo "no codex CLI"

# Init system (Linux)
command -v systemctl >/dev/null && systemctl --version | head -1 || echo "no systemd"
# macOS
command -v launchctl >/dev/null && echo "launchd available"

# Browsers already installed (Playwright may not need to download one)
ls ~/Library/Caches/ms-playwright 2>/dev/null || ls ~/.cache/ms-playwright 2>/dev/null || echo "no playwright cache"

# Ports Hermes uses
for p in 3230 5432; do (command -v lsof >/dev/null && lsof -nP -iTCP:$p -sTCP:LISTEN) || true; done

# Is a Hermes already running here?
ps aux | grep -E "hermes|ig:inbound|autoreply:worker|ig:autonomous" | grep -v grep || echo "no Hermes processes"
command -v systemctl >/dev/null && systemctl list-units --type=service | grep -i hermes || true
```

**Requirements**

| Thing | Needed | If missing |
|---|---|---|
| Node.js | **22 or newer** | Install via the user's preferred manager (`nvm`, `fnm`, `asdf`, distro package). Ask which. |
| Disk | ~3 GB free | A browser engine gets downloaded. Stop and tell the user if short. |
| RAM | 2 GB+ free for a long-lived worker | Note it; the systemd unit caps memory at 3 GB. |
| PostgreSQL | recommended | See Step 4 — there is a fallback. |
| systemd / launchd | only for always-on operation | Optional. Foreground workers work fine. |

**Verify** — write down, in your reply to the user, the actual values you found.
Do not proceed on assumptions like "Node is probably recent enough".

**Stop if** Node is older than 22, or disk is under ~3 GB. Both produce
confusing failures much later.

---

## Step 2 — Install dependencies

**Act**

```bash
npm ci                       # use `npm install` only if there is no package-lock.json
npx playwright install chromium
```

`playwright install` downloads a browser engine (hundreds of MB). If the
Playwright cache already showed a matching Chromium in Step 1, this is a no-op —
run it anyway, it is cheap and idempotent.

On Linux you may also need OS libraries:

```bash
npx playwright install-deps chromium    # may require sudo; ask the user first
```

**Verify**

```bash
npm run typecheck && echo "TYPECHECK OK"
npx playwright --version
```

**Stop if** `npm ci` fails on native builds — report the actual compiler error
rather than retrying.

---

## Step 3 — Create the environment file

**Act**

```bash
cp .env.example .env
chmod 600 .env
```

**Rules for you, the agent:**

- Never write a real secret into a file the user can't see you writing. Show
  them what you are adding, by key name.
- Never echo a secret value back into the conversation, a log, or a commit.
- Never ask the user to paste a **password** into the chat. Passwords go into
  interactive login windows. API keys and connection strings go into `.env`,
  which is gitignored — and you should tell the user you are putting them there.
- If a secret store is available (macOS Keychain, `pass`, a cloud secret
  manager) and the user prefers it, use it and reference it from the shell
  environment instead.

**Verify**

```bash
git check-ignore -v .env && echo ".env is ignored — good"
ls -l .env                 # should be -rw-------
```

**Stop if** `.env` is **not** ignored by git. Fix `.gitignore` before writing
anything into it.

---

## Step 4 — Database

Hermes owns its schema. Give it a database nothing else writes to.

**Detect**

```bash
command -v psql && psql --version
pg_isready 2>/dev/null || echo "no local postgres responding"
grep -c "OUTBOUND_DATABASE_URL=" .env || true
```

**Choose, with the user:**

1. **Local PostgreSQL** (recommended for a server install). If it exists, create
   a dedicated database and role. If it does not, install it — or use option 3.
2. **Managed PostgreSQL** (Supabase, Neon, RDS, …). The user creates the project
   **in their own account** and gives you the connection string. Use the
   **session** connection (port 5432), not a transaction pooler — a transaction
   pooler drops session state between statements, which breaks migrations.
3. **Embedded file-backed database (PGlite)** — no server, single process. Fine
   for trying Hermes out. Not appropriate for three long-lived workers sharing
   one database.

**Act** — set in `.env` either:

```
OUTBOUND_DB_BACKEND=postgres
OUTBOUND_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME
```

or, for the embedded option:

```
OUTBOUND_DB_BACKEND=pglite
OUTBOUND_DB_DIR=./var/pgdata
```

Then apply the schema:

```bash
npm run db:migrate
```

**Verify**

```bash
npm run db:migrate          # second run must be a no-op — migrations are idempotent
npm run db:psql -- "select count(*) from prospects"          # expect 0
npm run db:psql -- "select count(*) from hermes_conversation_plans"   # expect 0
npm run db:psql -- "select count(*) from hermes_autoreply_activations" # expect 0
```

**A fresh instance starts with an empty business database.** Zero prospects,
zero conversations, zero activations. If any of those counts is non-zero on what
was supposed to be a new install, **stop** and ask the user where that data came
from. Do not import another instance's data — it is other people's personal
data, and it carries their contact history and their opt-outs.

**Stop if** migrations fail. Report the failing migration by name; do not edit
migration files to make them pass.

---

## Step 5 — Model provider

Hermes routes model calls through `config/models.json`. Nothing is hardcoded.

**Detect**

```bash
cat config/models.json
command -v codex && codex --version || echo "codex CLI absent"
```

**`codex --version` is not proof of anything.** It tells you a binary exists. It
does not tell you the user is logged in, that their account has the configured
model, or that a call would succeed. Never treat CLI presence as capability.

**Act**

- If the configured provider needs an interactive login, have the **user** run
  it themselves (`codex login`, or the provider's flow). Do not run a login that
  stores credentials under your control, and **never copy an `auth.json` or
  token file from anywhere else on the machine.**
- If the user's provider or model differs from what `config/models.json`
  declares, edit that file. Every task route (`classification`, `research`,
  `message`, `reply`, …) names a provider, a model and an effort level. Change
  the names; do not add hardcoded model names anywhere in `src/`.

**Verify** — actually probe:

```bash
npm run models:probe
npm run models:probe -- --used     # only routes a run will really use
```

Read the output per route. A route that is declared but unreachable is a
failure, not a warning: the pipeline will fail at that step later, in the middle
of a run, instead of here.

**Stop if** any route the user intends to use does not answer. Report which
route, which model, and the provider's actual error.

---

## Step 6 — Who the operator is, and who they write to

This is the step that decides whether Hermes can write a first message at all.

**Act**

```bash
cp config/operator.example.json config/operator.json
```

Fill it in **with the user's answers**, not your inferences:

| Field | What to ask |
|---|---|
| `operatorName` | The name that will appear in every audited gesture (`--as "…"`). Their real name or a name they own. |
| `senderDescription` | One sentence: what their business does, *from the point of view of the person receiving the message*. |
| `audienceDescription` | One sentence: who they are writing to — trade, size, situation. |
| `vertical` | The market they prospect. |
| `voiceExamples` | Optional. Messages **they** wrote or approved. Ship none by default. |

**Verify**

```bash
npx tsx -e "import('./src/lib/config/load.ts').then(m => {
  const p = m.loadOperatorProfile();
  console.log('operator:', p.status, '| vertical:', p.vertical);
})"
```

On a fresh instance, before you fill anything in, this prints
`operator: UNCONFIGURED | vertical: null`. That is the shipped state.

**Stop if** loading it throws. Two failures are meaningful and different:

- **A schema error** — a field is missing or too short. Fix the file with the
  user.
- **`Cette verticale n'est pas disponible dans cette édition de Hermes.`** —
  the declared vertical is not available in this edition. Report the message as
  it is. Do not paraphrase it into a workaround, do not try neighbouring
  wordings to get past it, and do not edit the policy. If the user's business is
  in that market, this edition is not the right tool for them; say so plainly
  and stop.

---

## Step 7 — ICP: who is worth contacting

This edition ships **no ICP**. `config/icp/example-icp.json` exists only so the
machinery has a valid shape to read; it describes no real market and is
calibrated on nothing. Do not ship the user with it.

**Interview the user.** You need enough to write a profile that *refuses* things:

- What they sell, and what a good customer looks like after six months.
- Business size, structure, geography.
- **Positive signals** — observable facts that make a business a good fit.
- **Negative signals** — observable facts that rule one out (chains, franchises,
  marketplaces, directories, resellers, …). Split these into `STRONG`
  (disqualifying on sight) and `WEAK` (needs corroboration).
- **Hard exclusions** — kinds of business never to contact.
- Ability to pay, maturity, the gap they'd be filling, timing.
- Which channels are acceptable, and what makes someone contactable at all.

**Act**

```bash
cp config/icp/example-icp.json config/icp/<their-key>.json
# edit it with the user's answers
echo "OUTBOUND_ICP_PROFILE=<their-key>" >> .env
```

Then define the vocabulary of their trade in a niche file:

```bash
cp config/niches/example-services.json config/niches/<their-niche>.json
```

`positiveTerms`, `coreActivityTerms`, `serviceScope.inScopeTerms`,
`serviceScope.outOfScopeFamilies` and `searchQueries` are what the discovery and
targeting gates actually read.

**On thresholds and weights:** the shipped `signalGroups` thresholds and the
weights in `config/commercial-intelligence/example-shadow-v1.json` are **flat
and arbitrary**. They are not calibrated defaults — nobody's judgment is encoded
in them. Tell the user this plainly. A useful profile is built by running
discovery, reading the results with them, and adjusting. Do not present the
shipped numbers as tuned.

**Verify**

```bash
npx tsx -e "import('./src/lib/config/load.ts').then(m => {
  console.log('ICP status:', m.icpProfileStatus());
  console.log('niche loads:', !!m.loadNiche('<their-niche>'));
})"
```

Before this step, `icpProfileStatus()` returns `UNCONFIGURED` — there is no
default ICP in this edition, and no file is silently picked up.

**Stop if** the niche or ICP is refused by the vertical policy — same rule as
Step 6.

---

## Step 8 — Sending limits, window, and the kill switch

**Read the shipped defaults with the user** (`config/instagram.json`):

| Setting | Shipped default | Meaning |
|---|---|---|
| `caps.dailySentCap` | 10 | Hard ceiling per 24 h. |
| `caps.hourlySentCap` | 3 | Hard ceiling per hour. |
| `caps.minSendIntervalMs` | 900000 (15 min) | Minimum spacing between effects. |
| `caps.maxConsecutiveFailures` | 3 | Circuit breaker. |
| `schedule.windows` | Mon–Fri, 09:00–20:00 | When outbound may act. |
| `schedule.timezone` | `Europe/Paris` | **Change this to the user's timezone.** |
| `session.locale`, `session.timezoneId` | `fr-FR`, `Europe/Paris` | Change to match the account's real locale. |

These are the numbers that bound volume. They are deliberately small. Raising
them is the user's decision, made explicitly — not a setup convenience.

**The kill switch** is a global, persisted stop. While engaged, no effect leaves
the process — the pre-effect hook re-reads it immediately before the browser
acts, so engaging it mid-flight stops *that* message, not merely the next one.

```bash
npm run ig:kill-switch                                              # read state
npm run ig:kill-switch -- --engage  --as "<name>" --reason "<why>"  # arm
npm run ig:kill-switch -- --release --as "<name>" --reason "<why>"  # release
```

**Leave it engaged.** You are not the one who releases it. Make sure the user
knows this command by heart before anything goes live — it is what they will
type if something looks wrong.

---

## Step 9 — The channel account

Fresh instance only. The browser profile Hermes uses must be created here, by
this user, logging in themselves.

**Detect**

```bash
ls -la var/instagram/profile 2>/dev/null || echo "no browser profile yet"
npm run ig:status
```

**Stop if** a profile directory already exists and the user did not create it.
Never adopt a browser profile you did not see created — it carries someone
else's session cookies.

**Act**

1. Set the account handle in `config/instagram.json`:

   ```jsonc
   "inbound": {
     "accountHandle": "their_actual_handle",   // shipped as "UNCONFIGURED"
     "formerAccountHandles": [],               // previous names of the SAME account
     "enabled": true                           // shipped as false
   }
   ```

2. Have the **user** log in, in a visible window:

   ```bash
   npm run ig:session -- --bootstrap --wait-ms 600000
   ```

   A browser opens. **They** type their username and password, and handle 2FA
   themselves. Do not ask for their password. Do not type it for them. Do not
   read it from anywhere.

3. If a challenge or CAPTCHA appears, it is theirs to solve, in that window,
   within the timeout.

**Verify**

```bash
npm run ig:session          # observe; opens nothing new
```

Handle each outcome distinctly — they are not interchangeable:

| Result | What it means | What to do |
|---|---|---|
| `SESSION_READY` | Logged in **and** the account matches the configured handle. | Proceed. |
| `SESSION_WRONG_ACCOUNT` | Logged in as **somebody else**. | **Stop.** Either the handle in config is wrong, or the wrong account is logged in. Never "proceed anyway" — every downstream identity check is built on this. |
| `LOGIN_REQUIRED` | No usable session. | Re-run the bootstrap. |
| `CHALLENGE` / `CAPTCHA` | The platform wants a human. | Hand back to the user. Do not retry in a loop — that makes it worse. |
| `UNKNOWN` | The reader could not conclude. | Treat as failure, not as success. Re-run once; if it persists, report it. |

**Cookies are not proof.** A cookie jar can be present, non-empty and stale. The
only acceptable evidence is a session check that reads the connected account and
says it equals the configured one.

**Verify the lease is released:**

```bash
ls var/instagram/*.lock 2>/dev/null || echo "no stale lock"
ps aux | grep -i chromium | grep -v grep || echo "no chromium left running"
```

The three runtimes share **one** browser profile under an exclusive lease. A
lock left behind will make the next runtime report `BROWSER_PROFILE_BUSY`.

---

## Step 10 — Secrets hygiene before any commit

**Verify** — all five must be zero:

```bash
scripts/check-secrets.sh
git status --porcelain
git ls-files | grep -E "(^|/)\.env$|auth\.json|cookies|\.pem$|\.key$|id_rsa" || echo "no credential files tracked"
git ls-files | grep -E "^var/" || echo "no runtime artifacts tracked"
```

Expected: no credentials, no cookies, no browser profile, no `auth.json`, no
private keys tracked by git.

If `gitleaks` or `trufflehog` happens to be installed, run it too. Do not
install a scanner just for this — the repo ships a deterministic one.

---

## Step 11 — Certification checkpoint

**Before any activation, all of the following must be green.** Do not skip a row
because a later one passed.

```bash
npm run validate        # typecheck + lint + full test suite
npm run build           # the web surface compiles
npm run hermes:certify  # the engine's own end-to-end certification
```

| Check | How | Required |
|---|---|---|
| dependencies installed | Step 2 | ✅ |
| build green | `npm run build` | ✅ |
| full validate green | `npm run validate` | ✅ |
| certification green | `npm run hermes:certify` | ✅ |
| DB migrations green | `npm run db:migrate` (idempotent) | ✅ |
| provider probe green | `npm run models:probe -- --used` | ✅ |
| account identity green | `npm run ig:session` → `SESSION_READY` | ✅ |
| browser lease free | no stale lock, no orphan Chromium | ✅ |
| single owner per role | one process per runtime, no duplicates | ✅ |
| kill switch understood | user can engage/release it from memory | ✅ |
| caps configured | reviewed with the user | ✅ |
| send window configured | reviewed, in **their** timezone | ✅ |
| first-touch OFF | no autonomous approvals exist | ✅ |
| auto-reply activation absent | `npm run autoreply:status` | ✅ |
| zero-effect smoke green | Step 12 | ✅ |

If this repo carries a stricter certification than this list, **the stricter one
wins.** Never relax a check to make a step pass.

---

## Step 12 — Zero-effect smoke test

Prove the engine runs and that **nothing left the building**.

```bash
npm run autoreply:status
npm run ig:status
npm run ig:kill-switch
```

`autoreply:status` separates four states you must not conflate:

- **CONFIGURED** — does a durable activation exist? On a fresh install: **no**.
- **ALIVE** — are the processes running? Possibly yes; that is fine.
- **PERMITTED** — kill switch, caps, window. A cap reached is not a broken
  runtime.
- **PENDING** — plans and escalations waiting.

Then run the worker briefly in the foreground and read what it says:

```bash
npm run autoreply:worker            # one pass, foreground; Ctrl-C to stop
```

**Expected on a fresh instance:** `RUNTIME_NOT_ACTIVATED`. Zero conversations
considered. No browser opened. That is success, not a failure to diagnose.

**Verify no effect exists:**

```bash
npm run db:psql -- "select count(*) from hermes_conversation_plans where external_effect_attempted"
npm run db:psql -- "select count(*) from outreach_events"
```

Both must be `0`.

**Stop if** either is non-zero. Something has already acted; find out what
before going further.

---

## Step 13 — First contact stays OFF

Installing Hermes, connecting the account, starting the services and importing
prospects **must never be enough to send a cold message.** Confirm it:

```bash
npm run db:psql -- "select count(*) from r6b_batch_votes where actor_kind = 'AUTONOMOUS_POLICY'"
```

Expect `0`. First contact requires a separate, explicit authorisation the user
grants deliberately. Do not create one during setup, and do not offer to.

---

## Step 14 — Long-lived runtime (optional)

Only after Step 11 is green, and only if the user wants always-on operation.

There are three runtimes, and **exactly one owner per role**:

| Role | Command | Sends? |
|---|---|---|
| inbound collection | `npm run ig:inbound:run -- --loop` | no — reads only |
| first contact | `npm run ig:autonomous:worker -- --loop` | **yes**, once authorised |
| auto-reply | `npm run autoreply:worker -- --loop` | **yes**, once activated |

They share one browser profile under an exclusive lease, and each releases it
after every turn. **Two copies of the same role do not share the work — they
fight over the lease.** Enable each once, on one machine.

**Linux (systemd):**

```bash
sudo install -m 0644 deploy/systemd/hermes-ig-inbound.service /etc/systemd/system/
sudo sed -i "s|<HERMES_USER>|$USER|; s|<HERMES_HOME>|$PWD|; s|<NODE_BIN>|$(dirname $(command -v node))|" \
    /etc/systemd/system/hermes-ig-inbound.service
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-ig-inbound
systemctl status hermes-ig-inbound
```

**macOS (launchd):** the equivalent templates are in `deploy/launchd/`; the
header of each file has the substitution command.

**No systemd and no launchd?** Run the workers in a terminal multiplexer, or
under whatever supervisor the user already has (`supervisord`, Docker restart
policy, a cron-guarded wrapper). The properties that matter are: restart on
failure, start at boot, bounded memory, a clean `SIGTERM` (so the lease is
released), and **no duplicate workers**. Nothing about Hermes requires systemd
specifically. Do not hardcode any path — the templates are parameterised for
exactly this reason.

**Verify**

```bash
systemctl list-units | grep hermes    # or launchctl list | grep hermes
npm run autoreply:status              # ALIVE should reflect what you started
```

---

## Step 15 — The user's first canary

**This step requires the user's explicit permission, asked immediately before
you act. Not earlier in the conversation, and not implied by "set it up".**

Ask, in plain words: *"Shall I create a bounded activation that allows Hermes to
send at most 3 real replies, to real people, and then stop?"*

If yes:

```bash
npm run autoreply:activation -- --activate --as "<their name>" \
    --reason "<why, in their words>" --max-effects 3
```

Then the user — not you — releases the kill switch:

```bash
npm run ig:kill-switch -- --release --as "<their name>" --reason "<why>"
```

**Bounded means bounded.** `--max-effects 3` (or fewer). Never `--unbounded` on
a first rollout, whatever the user's enthusiasm — if they ask for it, explain
that the point of the canary is to observe three real outcomes before trusting
the fourth.

**During the canary:**

- Do **not** fabricate an inbound message to consume the budget. A synthetic
  message proves the plumbing and nothing about judgment. Wait for real replies
  from real people.
- Watch: `npm run autoreply:status -- --escalations 50`
- Read every escalation with the user. An escalation is the system working.

**After the budget is spent:**

```bash
npm run autoreply:activation                 # confirm it is exhausted
npm run autoreply:status
```

Then **stop → report → human decision.** Write up what actually happened: what
was sent, what escalated, what the recipients said. There is no automatic
promotion to unbounded. Widening the rollout is a separate conversation, held
after reading real outcomes.

---

## What you must never do during setup

- Enable sending, in any form, without the explicit permission described above.
- Release the kill switch on the user's behalf.
- Create an activation "to test the flow".
- Fabricate an inbound message, a prospect, an evidence row, or a reply.
- Copy a credential, cookie, browser profile, `auth.json` or database from
  anywhere else on the machine.
- Import another instance's prospects.
- Relax a cap, widen a window, or lower a confidence threshold to make a step
  pass.
- Edit the vertical policy, or try alternative wordings to get a refused
  vertical past it.
- Commit `.env`, `var/`, or any credential.
- Report a step as done when you could not verify it.

## When you get stuck

Say precisely which **Verify** failed and what the output was. A half-configured
Hermes that reports itself as ready is worse than one that stops early — the
first one eventually messages a real person under rules nobody checked.
