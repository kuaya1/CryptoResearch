# Conversations: titles, handoffs and where to work

Eric's title system, 2026-10-25. It covers Claude conversations about this desk: desktop and cloud sessions, Cowork and claude.ai chats.

**The repository is the record.** Approved goals and the backlog are in `DESK_STATE.md` and `audits/2026-10-24-30-day-blueprint/README.md`. The evidence is in commits, PRs, CI runs, audit write-ups and the desk's own receipts. A conversation is a place to work. It shares no history with any other conversation, and nothing said in one counts as decided until it is written here.

## Titles

Write `PREFIX — Short name`: an em dash and a few plain words. Name a PR only by its real number, once it exists. A title says what the conversation is for, never that the work is done.

| Prefix | Use it for | Example |
|---|---|---|
| PLAN | Goals, roadmap, priorities, architecture and Eric's decisions | PLAN — Desk roadmap |
| BUILD | Implementing one bounded outcome | BUILD — Autonomy audit remediation |
| REVIEW | Independent verification of one implementation or PR | REVIEW — Autonomous builder PR #&lt;actual number&gt; |
| DESIGN | Exploring one interface or experience | DESIGN — Prop desk backlog visualizer |
| LEARN | Questions, explanations and experiments | LEARN — Coding and autonomous systems |

- **PLAN:** keep one ongoing.
- **BUILD and DESIGN:** one per outcome or experience. When a second outcome turns up mid-build, it gets its own BUILD.
- **LEARN:** one general conversation until a topic needs its own.
- **No placeholders:** open a conversation when there is work for it, never an empty one for a category.
- **Scheduled runs:** a scheduled task's runs keep the task's own title, such as "CryptoResearch @6 watchlist refresh". They are runs, not conversations. Archive them once the schedule has ended and nothing in them is still open.

## The primary PLAN conversation

**PLAN — Desk roadmap** ([open in the app](claude://claude.ai/epitaxy/local_ed825c57-ef14-4c6b-a245-7f66f5ba5c53)). It wrote the 30-day blueprint, ran the day-1 launch and set up the `cr-at6-surge` scheduled task.

Take roadmap and priority questions there. Decisions it reaches go into `DESK_STATE.md` or the blueprint in Eric's words.

When it gets too long:
1. Start a fresh "PLAN — Desk roadmap" with the handoff below.
2. Archive the old one.

There is still only one.

## BUILD: start and close

**Start**
- Open a fresh conversation titled `BUILD — <outcome>`.
- Make the handoff below the first message. Its approved scope is Eric's own words or `DESK_STATE.md` item numbers.

**Work**
- Follow `CLAUDE.md`: edit in this folder and run the tests.
- Commit and push only when Eric asks.

**Close**
- The last message gives:
  - the revision or PR;
  - the tests run, with their counts;
  - what is live;
  - what is still open.
- Anything that must outlive the conversation goes into the repo: a backlog item Eric adds, an audit write-up, or a rule in `CLAUDE.md`.
- Then archive it.

## REVIEW: start and close

**Start**
- Use a fresh conversation, never the one that built the work. Renaming a builder conversation does not make it independent.
- Title it after what it checks, e.g. `REVIEW — <thing> PR #<n>` or the commit.
- Give it the revision and the scope, not the builder's conclusions.

**Work**
- It reports findings with their evidence.
- Fixes go to a BUILD, not into the review.

**Close**
- Findings that matter are saved under `audits/<date>-<name>/`.
- Then archive it.

## Handoff template

```
Goal:
Approved scope:      Eric's words or DESK_STATE.md item numbers, nothing else
Revision / PR:
Verified evidence:   commands run and their results, CI runs, desk receipts
Unresolved:
Next action:
```

## What counts as approved

**Eric's decisions** are any of these:
- his own words in a conversation;
- an item he added to or ticked in `DESK_STATE.md`;
- a choice the desk records as his: settings labeled as his choices, `decisions.jsonl`, his reviews.

**Agent suggestions** are everything a model proposes, in chat or in an audit. A suggestion becomes a decision only when Eric says yes. It is then written into the repo with his name and the date.

Old chat text never becomes buildable backlog by itself (blueprint invariant 2: only Eric's words become backlog). A BUILD works from `DESK_STATE.md` or Eric's message, never from another conversation's transcript.

## Archive, don't delete

- **When to archive:** once a conversation's outcome is in the repo, or it has been superseded.
- **Before archiving:** move anything unique into the repo or the PLAN conversation (a decision, an open question, evidence).
- **Never while busy:** don't archive a conversation that is still working, or one tied to a schedule, until what depends on it is understood.
- **Deleting:** archiving can be undone; deleting can't. Delete only conversations on a list Eric has approved.
