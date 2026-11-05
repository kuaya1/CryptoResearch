# Restoring the Paper Book

**Eric runs every step. No agent does.** A restored book returns to its cutoff, and the book's records cannot say what happened after it. So a restored copy holds until Eric has ruled on what would run.

Everything here is tested on fictional records only (`dashboard/tests/restore-hold.test.js`). **Nothing in this document has run against the Render disk.** The Render steps, the Shell's availability and the `--workspace "$CR_DATA_DIR"` line are unverified.

## The hold

It is the restored-copy marker, `config/restored-copy.json`, and its one release. Research already held on it. The Paper Book now holds on it too.

**While held, these refuse with `RESTORE_HELD`:**

- funding, including `trader bootstrap` and the fictional-workspace exemption
- every order, opening or closing, and every cancel
- recovery and reconciliation of an order caught mid-send
- every hour applied to the book, so **stops and targets pause**

**A decision made while held adds nothing to either book.** It is recorded and on the list for the release. It sends no order and opens no PM Cohort position; the PM Cohort answer reads `held`, and so does the repair (`tickets reconcile`).

**These stay open:** every read, and decisions, including Undo. Undo voids a PM Cohort position while held, because it takes exposure off and it is the ruling a release asks for.

**Reads say it.** `GET /api/paper/trader` carries `restore_hold`, with what is waiting in `rulings_needed`. `waits` opens with the hold. A request that would act reads "On hold, nothing is sent", and never `ready`. A marker that does not read holds.

## What sets a hold

| Route | Hold | Tested |
|---|---|---|
| `backup restore <name> --to <empty folder>` | Written first, before any file. A marker in the backup is never copied | Yes, including a killed process |
| `offsite drill`, and a package restored into a new folder | Written first, before any file. A marker in the package is never copied | Yes: the drill itself, and `restorePackage`, including a killed process |
| `backup restore <name> --overlay --confirm`, sealed or an older unsealed backup | Written first. A marker in the backup is never copied, so there is no last step to reach. A restore that dies part way leaves it | Yes, including a killed process at each stage of an unsealed copy |
| `backup restore <name> --point-in-time --confirm` | Written first. A marker in the backup is never copied. A restore that dies part way leaves it | Yes, including a killed process |
| **A Render disk restore, or files copied by hand** | **None.** The on-disk marker cannot survive a restore of the disk it sits on. See below | No: procedure only |

A restore into a new folder that dies leaves a held, partial folder. Delete it and restore again. An overlay leaves later files in place, so a venue file newer than the backup refuses as INTEGRITY until it is dealt with. Prefer point-in-time. An older unsealed backup cannot be checked file by file, and only an overlay takes one.

These are tested by killing a real process on fictional records, on this PC, on Node 24.21.0 (the pinned version) and on Node 20.20.2, which spells long Windows paths differently to an older copy's filter. No restore has been killed on the Render disk.

## Not detected

**The desk does not detect a Render snapshot rollback, and nothing here claims to.** A disk put back with no marker has the same first line, so it passes the anchor, and it looks like an ordinary restart. If it is restored without the external refusal below, a grant from before the cutoff can send its order again. A test records this as the limit (`EXCLUDED`). Render's `disk_snapshot_restored` event tells you afterward. It stops nothing.

## A direct Render restore: the refusal comes first

The order is the protection. Each step must be done and checked before the next.

1. **Capture what survives.** If the disk still reads, pull a copy into a new folder, because a restore destroys it: `node dashboard/cli.js offsite pull --to "<new empty folder>" --workspace "<a named workspace>"`.
2. **Set the external refusal.** In Render > CryptoResearch > Environment, change `CR_TRADER_BOOK_ANCHOR` from the book's hash to `restore-hold`. Keep the hash somewhere you can read it. Any value that is not a hash refuses everything, and it lives off the disk, so a restore cannot undo it. Saving restarts the service.
3. **Verify the refusal before touching the disk.** Wait for the deploy to finish. Signed in, `GET /api/paper/trader` must refuse as INTEGRITY. **If it still answers with the book, stop.** Do not restore.
4. **Restore the disk**: Render's snapshot, or files copied in the Shell with the journal last.
5. **Put the hold down, while the anchor still refuses.** In Render's Shell: `node dashboard/cli.js restored-copy hold --confirm --from "<what was restored>" --workspace "$CR_DATA_DIR"`
6. **Put the real hash back** in `CR_TRADER_BOOK_ANCHOR`. It must equal `book_identity.genesis_sha256` from the offsite copies. After the restart the book reads, and the marker still stops every write.
7. **Verify.** Signed in, `GET /api/paper/trader` must show `restore_hold.held: true` and `book_identity.anchor: established`. **If `restore_hold` is missing, set the anchor back to `restore-hold` at once and go back to step 5.**
8. **Reconcile**, below. Then release.

A release cannot be made during step 2 to 5: `rulingsNeeded` refuses under a non-hash anchor.

## Reconcile, then release

`node dashboard/cli.js restored-copy status` lists every ruling. The release refuses until each is made, reading the records again under the workspace lock. So a decision recorded a moment earlier is caught, and nothing can land between the check and the release. `status` itself is a read outside that lock. With the anchor established it is read again if the book changes under it, and refused if the book keeps changing. **With no anchor set it reads once,** so read it again before you rely on it. The release is not affected.

| On the list | What it is | Your ruling | Can `--accept` it? |
|---|---|---|---|
| `opening` | A grant in force with no opening order in this book, including one recorded during the hold, and a queued one waiting on a condition. It may never have gone, or may have gone after the cutoff and been lost | **Undo it.** To trade it, decide again after the release | **No** |
| `order` | A live buy or sell in the book, or one caught mid-send | Check it, then accept it, or Undo | Yes |
| `position` | A position open at the cutoff, with its stop and target | Check it against the gap, below, then accept it | Yes |
| `cancel`, `close` | The next thing the book would do under a decision already on record | Check it, then accept it | Yes |
| `mandate` | A paper mandate still armed, which would grant again at once | **Turn it off** (`arm-desk --mandate-off`, or the desk control). Arm it again after the release if you want it | **No** |
| `pm_cohort` | A grant in force with nothing else waiting, whose PM Cohort position is not on record. The repair would open it after the release, priced at the decision | Accept it, or Undo it | Yes |
| `unmatched_order`, `broken_project` | The records do not match | Put back a matched set, or repair the project | **No** |

A grant that can never pass (a mandate grant whose authority is revoked, a horizon that has ended) is not listed, unless its PM Cohort position is what waits. An item with `pm_cohort_missing` has the same gap beside other work. A history, a book or a PM Cohort book that does not read refuses the release: unknown is not none.

```
node dashboard/cli.js restored-copy release --confirm --accept <decision_id> --accept <decision_id>
```

A release that fails or dies leaves the hold. The marker is written once, whole, at the end.

### What `--accept` means

**Accepting is a record that you looked. It gives no authority.**

- It writes only the marker. The journal and the decisions keep the same bytes.
- It never makes or changes an intent, and it extends no validity. An accepted order expires at its own time.
- It does not approve anything. The engine reads the accepted work again, through every gate it always applies.
- It checks the decision's basis. A basis that does not read, or reads as `unavailable`, refuses the release until the record is restored. One that reads `unverified` refuses it until you rule on it, below.
- A name that is not on the list refuses the whole release.

**An opening cannot be accepted.** Sending it would carry the old intent ID with a new `created_at`, a new reference price and a new `valid_until`. If an order under that ID went after the cutoff, that is a second, different order under one immutable ID. So the only way on is the existing one: **Undo it, release, and decide again.** That is a new decision, with its own Decision Basis frozen in the same operation and a new intent ID. A live mandate is the same: arming it again is `arm-desk`, Eric's own act.

**A sell after a release has its own ID.** A sell is a new order made now, so it may differ from whatever went in the lost timeline: a different price, a different time, a different quantity. Its ID comes from the decision, the attempt and this release's marker, so no sell reuses an ID the lost timeline may have sent. A workspace never restored keeps the plain numbering.

Each release starts its own count of sell attempts, so the limit of attempts is per release. A sell from an earlier release that is still live stays that position's sell, and no second one goes.

Within one book the engine holds the rest: the same body again changes nothing, another body under an ID is refused as CONFLICT, a second live sell is refused, a sell of a closed position is refused, and a sell fills whole, for what the position holds. A venue record surviving from the lost timeline refuses the book as INTEGRITY.

### A basis that cannot be verified

A decision from before the digest ledger, or one standing on a report with no recorded SHA-256, can read `unverified` for good, and no record can be restored to fix it. You can rule on it. **The ruling does not verify anything.**

`restored-copy status` shows each item's `basis`, with a `ruling_token` when a ruling can be taken. Then:

```
node dashboard/cli.js restored-copy release --confirm --accept <decision_id> --basis-ruling <decision_id>:<ruling_token> --because "<why you stand behind this work without it>"
```

- **One decision at a time.** There is no wildcard and no way to rule on everything. Each needs its own `--accept`, its own `--basis-ruling` and a reason.
- **These exact records.** The token is taken from the decision and its basis as read. If either changes, the ruling refuses.
- **Only work that can no longer add to a position:** an open position whose buy has ended, a cancel, a close. A live buy, an opening or a missing PM Cohort position takes no ruling. Undo the decision, then rule on what is left. An opening with nothing behind it needs no ruling once undone.
- **Only `unverified`.** A basis that does not match its records is INTEGRITY, ruling or no ruling. Restore it. `unavailable` is refused too, and a basis that stands has nothing to rule on.
- **Nothing is rewritten.** The decision, the basis and the journal keep their bytes, no digest is made, and the basis still reads `unverified` afterward. The ruling is kept in the marker, as `basis_rulings`, with your reason. Copy it into your record outside the desk, because a later hold replaces the marker.
- **On the command line only.** No route takes it.

## Stop-losses pause while held

**This is the cost of the hold.** No hour is applied, so a position whose stop was crossed still reads open. NAV, cash and drawdown are the last recorded balances, not a settled account. The release does not settle them. The next hourly read does, applying the held hours in order, from the candle source. A stop crossed during the hold settles from the hour that crossed it.

If the source no longer serves an hour, the pair holds at the gap and does not guess.

**Before you release, reconcile:**

1. **The cutoff.** Which copy, and what time. Write it, and every ruling, into a record kept outside the desk.
2. **Each open position.** Its stop and target, and whether the market crossed them since the cutoff. Expect it to close on the first hours after the release.
3. **Each live order.** Whether its validity has passed, and whether the market reached it. It may fill or expire on those same hours.
4. **The gap.** How long, and whether GeckoTerminal still serves those hours. A gap it cannot serve holds the pair.
5. **Each grant from before the cutoff with no order.** Whether you believe it went. Undo it either way, and decide again if you still want it.
6. **What survived from after the cutoff.** On a partial loss, compare the surviving records with the copy, using `reconcile-after-cutoff.js` in `Documents\CryptoResearch-evidence\book-continuity-20261105T011105Z\`. On a whole-disk loss the records cannot list what was lost. It is whatever you and the daily brief remember.
7. **The mandate.** Off, and what it held.
8. **Research.** The release also lets queued research jobs go to their paid providers, within the limits.
9. **The PM Cohort book**, below.

Orders and fills after the cutoff are gone from the book and are not rebuilt. Do not invent them.

## Not covered: the PM Cohort book

The PM Cohort paper book (`core/paper.js`) is a separate book and `paper.js` is protected, so the guard is in its one caller, `tickets.js` `paperBook`, under the workspace lock. **No position opens while held, and none opens across a marker that changed after the decision began.** No protected file changed.

**What the hold still does not do for it:**

- Undo voids while held, by design. Everything else this book records is its own, written only here.
- It has no anchor or chain of its own. It is restored from the same copy, and whatever it held after the cutoff is gone. A decision on record whose position was lost is listed for the release, and the repair opens it afterward, priced at the decision. It opens nothing a decision does not name, and rebuilds no void it never saw.
- Like the rest of the hold, the guard reads the marker. A disk put back with no marker is not held here either.

Reconcile it by hand against your record of the cutoff.
