# Frontier query

The single definition of *takeable* for this repo. `/implement-next` and `/implement-all` both read this file rather than carrying a copy each, so the definition cannot drift between them. Each states its one divergence below and nothing else.

## The query

One call. The sub-issue list is both the scope and the order — **sub-issue order is the operator's order**, dragged in GitHub's own UI, so never re-sort it.

```bash
gh api "repos/<owner>/<repo>/issues/<spec>/sub_issues?per_page=100" --paginate --jq '
  [.[] | select(
      .state == "open"
      and .issue_dependencies_summary.blocked_by == 0
      and (.assignees | length) == 0
      and ([.labels[].name] | any(. == "ready-for-agent" or . == "ready-for-human"))
  )] | .[] | "#\(.number)  [\([.labels[].name] | join(","))]  \(.title)"'
```

Four conditions, and each one is doing work:

- **`state == "open"`** — closed is done.
- **`blocked_by == 0`** — GitHub counts **open** blockers only, so this is the entire unblocked test. It relies on native dependencies being wired; if the tickets carry only prose `Blocked by` lines this returns everything and is worse than useless. Check before trusting it (see [Fallbacks](#fallbacks)).
- **`assignees == 0`** — unclaimed. A ticket assigned to *you* is not frontier; it is a resume, and belongs to `/implement` directly.
- **triage label** — a ticket carrying neither `ready-for-agent` nor `ready-for-human` is not ready. Do not pick it, and do not silently reinterpret it.

**Take the first result in list order. Never re-rank. Sub-issue order is the operator's order.** Do not score, and do not pick "the one that unblocks the most" — the harness never invents a ranking.

`--paginate` applies `--jq` per page, so any jq that aggregates across the whole set (`first`, `length`, `sort_by`) silently operates per page. This query is safe because it emits a flat line stream: take the first **line**, never jq's `first`.

## When the frontier is empty

Say which of these it is rather than reporting "nothing to do":

| Condition | What it means | What to say |
| --- | --- | --- |
| No open sub-issues | The spec is finished | Offer to close the spec issue |
| All open ones blocked | Work exists but is gated | Name the blockers holding the most back |
| Everything left gated by a `ready-for-human` ticket | One human ticket is the whole obstruction | Name that ticket and why its body says it needs a human |
| All open ones assigned | Everything is claimed | Name who holds them; offer `/implement` on your own claims |
| Open, unblocked, unlabelled | Triage gap | Name them and offer `/triage` |

These are five different facts and they must never collapse into one message.

The summary field carries a count and no names. To name the blockers, walk the edges of each open child: `gh api "repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by" --jq '.[] | select(.state=="open") | "#\(.number) \(.title)"'`.

## Divergences

The query is shared whole. Its two consumers differ in exactly one place — what a `ready-for-human` pick means:

- **`/implement-next` asks.** A human is present, so it prints why the ticket's body says it needs one and confirms before proceeding. Never auto-run a `ready-for-human` ticket.
- **`/implement-all` skips it and continues.** In an unattended loop there is nobody to ask, so `ready-for-human` means what a blocker means: not takeable, move on. Skipping is not re-ranking — it is one more filter over the same list in the same order, and every skip is named in that run's brief.

## Fallbacks

**Native dependencies not wired.** If `blocked_by` is `0` for every ticket including ones with obvious blockers, the graph is prose-only. Either wire it (preferred — it is one `POST` per edge and it makes this and every other tool work):

```bash
# blocker's numeric DATABASE id, not its #number
BLOCKER_ID=$(gh api repos/<owner>/<repo>/issues/<blocker> --jq .id)
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=$BLOCKER_ID
```

...or parse the prose refs, and **say that you did**, because a prose parse is a guess about formatting:

```bash
gh issue list --state all --limit 200 --json number,title,body,state,assignees --jq '
  [.[] | select(.body | test("Spec: #<spec>"))] | . as $a
  | ($a | map(select(.state == "CLOSED") | .number)) as $done
  | $a | map(select(.state == "OPEN" and (.assignees | length) == 0))
       | map(. + {b: ([.body | scan("- #([0-9]+) —")] | flatten | map(tonumber))})
       | map(select([.b[] | IN($done[])] | all))
       | sort_by(.number) | map("#\(.number)  \(.title)")[]'
```

**Sub-issues not used.** If the tickets reference their parent in prose instead, scope by that body text as above. Note it — a body-text scope silently misses a ticket whose parent line was reworded.
