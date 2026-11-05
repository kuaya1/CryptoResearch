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

**These stay open:** every read, and decisions. A decision made while held is recorded, sends nothing, and is on the list for the release.

**Reads say it.** `GET /api/paper/trader` carries `restore_hold`, with what is waiting in `rulings_needed`. `waits` opens with the hold. A request that would act reads "On hold, nothing is sent", and never `ready`. A marker that does not read holds.

## What sets a hold

| Route | Hold | Tested |
|---|---|---|
| `backup restore <name> --to <empty folder>` | Written by the restore | Yes |
| `offsite drill`, and a package restored into a new folder | Written by the restore | Yes |
| `backup restore <name> --overlay --confirm` | Written first and last. A marker in the backup never replaces it. A restore that dies part way leaves it | Yes |
| `backup restore <name> --point-in-time --confirm` | Written first. A marker in the backup never replaces it. A restore that dies part way leaves it | Yes |
| **A Render disk restore, or files copied by hand** | **None.** The on-disk marker cannot survive a restore of the disk it sits on. See below | No: procedure only |

An overlay leaves later files in place, so a venue file newer than the backup refuses as INTEGRITY until it is dealt with. Prefer point-in-time.

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

`node dashboard/cli.js restored-copy status` lists every ruling. The release refuses until each is made, reading the records again under the workspace lock. So a decision recorded a moment earlier is caught, and nothing can land between the check and the release.

| On the list | What it is | Your ruling | Can `--accept` it? |
|---|---|---|---|
| `opening` | A grant in force with no opening order in this book, including one recorded during the hold, and a queued one waiting on a condition. It may never have gone, or may have gone after the cutoff and been lost | **Undo it.** To trade it, decide again after the release | **No** |
| `order` | A live buy or sell in the book, or one caught mid-send | Check it, then accept it, or Undo | Yes |
| `position` | A position open at the cutoff, with its stop and target | Check it against the gap, below, then accept it | Yes |
| `cancel`, `close` | The next thing the book would do under a decision already on record | Check it, then accept it | Yes |
| `mandate` | A paper mandate still armed, which would grant again at once | **Turn it off** (`arm-desk --mandate-off`, or the desk control). Arm it again after the release if you want it | **No** |
| `unmatched_order`, `broken_project` | The records do not match | Put back a matched set, or repair the project | **No** |

A grant that can never pass (a mandate grant whose authority is revoked, a horizon that has ended) is not listed. A history or a book that does not read refuses the release: unknown is not none.

```
node dashboard/cli.js restored-copy release --confirm --accept <decision_id> --accept <decision_id>
```

A release that fails or dies leaves the hold. The marker is written once, whole, at the end.

### What `--accept` means

**Accepting is a record that you looked. It gives no authority.**

- It writes only the marker. The journal and the decisions keep the same bytes.
- It never makes or changes an intent, and it extends no validity. An accepted order expires at its own time.
- It does not approve anything. The engine reads the accepted work again, through every gate it always applies.
- It checks the decision's basis. A basis that does not read, or reads as `unverified` or `unavailable`, refuses the release until the record is restored. A decision from before the digest ledger, or one standing on a report with no recorded SHA-256, can read `unverified` for good. If such a decision holds work in the book, the release stays blocked. There is no override, and getting past it needs a separate ruling.
- A name that is not on the list refuses the whole release.

**An opening cannot be accepted.** Sending it would carry the old intent ID with a new `created_at`, a new reference price and a new `valid_until`. If an order under that ID went after the cutoff, that is a second, different order under one immutable ID. So the only way on is the existing one: **Undo it, release, and decide again.** That is a new decision, with its own Decision Basis frozen in the same operation and a new intent ID. A live mandate is the same: arming it again is `arm-desk`, Eric's own act.

**One limit to accept.** A `close` is a new sell, numbered by the sells the restored book holds. If `close-1` went after the cutoff and was lost, the next sell reuses that ID. The book holds only the new one, and it only reduces risk, so this is allowed. Check for it when you accept a close.

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

**The PM Cohort paper book (`core/paper.js`) is a separate book, and this hold does not reach it.** `paper.js` is protected. A decision recorded during the hold can still open its position, and a test records that it does. It has no orders, no venue and no market effect, and it is restored from the same copy. Reconcile it by hand. Changing this needs a protected-file exception, which has not been proposed.
