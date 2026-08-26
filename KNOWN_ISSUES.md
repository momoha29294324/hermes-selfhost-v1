# Known issues

What is known, reproducible, and **not** fixed in this release. Each entry says
what it costs and what a fix would have to be careful about.

If you hit something that is not here, it is not known — please report it (see
`SECURITY.md` for anything with a safety dimension).

---

## Vertical vocabulary survives in published migration comments

**What.** A few `db/migrations/*.sql` files carry, in `--` comments, the name of
the vertical this engine was originally built for.

**Why it is still there.** The migration runner refuses a migration whose
checksum has changed since it was applied. Editing a comment in an already
published migration therefore **breaks `npm run db:migrate` on every instance
that has already applied it.** That happened during the preparation of this
release and was caught by `tests/migrationChecksums.test.ts`; the files were
restored byte for byte.

**Cost.** Cosmetic only. No behaviour, no data, no default is affected.

**A fix would have to** be a new migration that rewrites nothing, or a
coordinated release that accepts a documented re-baseline. Do not edit the files.

---

## The reserved-vertical guard is a lexical gate, not a semantic one

**What.** `src/lib/config/verticalPolicy.ts` refuses a niche declaration that
names a reserved family of trades. It matches on whole words and word pairs.

**Cost.** It can be worked around by someone determined to describe the same
trade in other words, and it can in principle refuse a legitimate niche whose
vocabulary collides. The second case is the one to report.

**A fix would have to** not become a model call: this gate runs inside the
configuration loader, before a campaign exists, and a gate that decides whether
a campaign may exist cannot depend on a model's mood.

---

## The personalisation floor is looser when a niche declares no vocabulary

**What.** `checkFirstTouch` refuses a first message that reprises nothing when a
grounded hook was available (`MISSING_GROUNDED_HOOK`). To tell "this message
repeats something observed about *this* business" from "this message names the
trade of the entire target list", it needs to know the trade's vocabulary — and
it reads it from your niche (`serviceTerms`, `coreActivityTerms`).

**Cost.** A niche that declares neither still gets the floor, but a message can
satisfy it with the trade's own name. That is weaker than intended.

**The fix is yours, not the code's:** describe your niche. This is deliberate —
no vocabulary is written into `src/`.

---

## PGlite cannot prove the anti-double-booking guarantee

**What.** The exclusion constraint that prevents two prospects being booked into
the same half-hour is a PostgreSQL feature. PGlite (the file-backed fallback) is
real PostgreSQL and does enforce it — but a single process may open it, so it
cannot exercise two connections racing for the same slot.

**Cost.** On PGlite the constraint is enforced; the *race* is untested.
`tests/nativeBookingStorePostgres.test.ts` covers it and skips unless
`OUTBOUND_TEST_DATABASE_URL` points at a disposable PostgreSQL.

**Run it before you rely on booking in production:** `scripts/pg17-local.sh init`
provisions one.

---

## One calendar, all calendars

**What.** `config/booking.json` has a `calendarKey`, and the schema accepts any
value — but the exclusion constraint refuses overlaps **across all calendars**,
not per calendar.

**Cost.** Two calendars cannot hold concurrent appointments. This refuses more
than it needs to, which is the safe direction.

**A fix would have to** enable the `btree_gist` extension and reformulate the
constraint, in a deliberate migration.

---

## Long-running workers hold the code they started with

**What.** Node loads code once. A `--loop` worker keeps the constants it started
with, including policy and prompt versions.

**Cost.** After changing a policy version or a classifier, a still-running worker
can write a conclusion under yesterday's rules.

**Partly mitigated:** the inbound loop and the autonomous worker read the repo
revision and stop before a turn if it has moved (`CODE_REVISION_CHANGED`). This
is a *stop*, never a hot reload, and it fails open outside a Git checkout.

**The operating rule beats the tool: restart the loops after a policy change.**

---

## Not verified in this release

Stated so it is not mistaken for coverage:

- **no live send of any kind was exercised** while preparing this release. The
  kill switch stayed engaged, no activation row was created, and no browser was
  opened against a real account;
- the **Instagram browser rail** is exercised by injected doubles and by
  read-only inspection, never against a live session in CI;
- **upgrade** is verified from **v1.0.0** only. Older or hand-modified schemas
  are not covered.
