# GitHub sub-issue and dependency API coverage

Research for [issue #3 — GitHub sub-issue and dependency API coverage](https://github.com/javrasya/perseverance/issues/3).

## The question

Can the harness fetch the entire wayfinder map graph in one query, and through which API surfaces?

For a given map issue the harness needs: its body, all child issues, each child's title, state, labels and assignee, and the blocking edges between them.

- Are sub-issues and issue dependencies exposed in GraphQL, REST, or both? Are either preview-gated or behind a feature flag?
- Can all of it come back in a single GraphQL round trip, or does the graph require N+1 calls?
- What does `octocrab` support today, and where would raw queries be needed instead?
- What are the rate limits for the resulting call pattern at a several-second refresh?
- Read-only is the constraint — does anything here need write scopes beyond what `gh auth token` already grants?

## Method and provenance

**Date checked:** 2026-08-01.

**Fixture:** `javrasya/perseverance` issue #1 (the map, labelled `wayfinder:map`) with sub-issues #2–#13 and 10 `blocked_by` edges wired. Everything marked verified was run against this map.

**Tools:** `gh` CLI with the token from `gh auth token`; raw `curl` against `api.github.com` (to prove no header ceremony is involved); a shallow clone of `XAMPPRocky/octocrab` at tag `v0.54.1`; and a throwaway Rust binary against `octocrab 0.54.1` built in `C:\Users\ahmet\AppData\Local\Temp\octocrab-verify\` (not part of the repo).

Claims are tagged:

- **[VERIFIED]** — I ran it against the fixture and pasted the real result. Output blocks below are real captures.
- **[DOCS]** — read in GitHub's own documentation or changelog, not executed. Source URL given inline.
- Anything I could not establish is called out under [What I could not establish](#what-i-could-not-establish).

Two working queries are saved alongside this note in the repo root: `map-graph.graphql` (the full graph) and `map-poll.graphql` (the cheap poll).

---

## Answer in one line

Yes — the whole map graph comes back in **one GraphQL round trip, no pagination, no preview headers, cost 3 points, ~0.4 s, ~13 KB**. REST exposes the same data but needs **1 + N** calls. `octocrab` has typed sub-issue support and **zero** dependency support, so the harness should use the raw GraphQL escape hatch for the graph query.

---

## 1. Which surfaces expose sub-issues and dependencies

Both features are **generally available on both REST and GraphQL**, with **no preview media type, no `GraphQL-Features` header, and no feature flag**.

| Feature | GA date | Source |
|---|---|---|
| Sub-issues | 2025-04-09 — *"we're thrilled to announce the general availability of sub-issues, issue types, advanced search…"* | [github.blog/changelog/2025-04-09-evolving-github-issues-and-projects](https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/) **[DOCS]** |
| Issue dependencies | 2025-08-21 — *"Dependencies on issues are now generally available!"*, *"Issue dependencies are fully supported in the API and webhooks"* | [github.blog/changelog/2025-08-21-dependencies-on-issues](https://github.blog/changelog/2025-08-21-dependencies-on-issues/) **[DOCS]** |
| `gh` CLI exposure of parent / sub-issue / dependency JSON fields | 2026-06-10, `gh` ≥ v2.94.0 | [github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/) **[DOCS]** |

**Evidence that nothing is gated [VERIFIED]** — the same query run through raw `curl` with *only* an `Authorization` header (no `Accept`, no `GraphQL-Features`, no preview media type) succeeds:

```console
$ curl -s -H "Authorization: bearer $(gh auth token)" -H "Content-Type: application/json" \
    -X POST -d '{"query":"{repository(owner:\"javrasya\",name:\"perseverance\"){issue(number:7){number blockedBy(first:5){totalCount nodes{number}}}} rateLimit{cost}}"}' \
    https://api.github.com/graphql
{"data":{"repository":{"issue":{"number":7,"blockedBy":{"totalCount":1,"nodes":[{"number":3}]}}},"rateLimit":{"cost":1}}}
```

And on REST, the response advertises the plain v3 media type — no preview type **[VERIFIED]**:

```
$ curl -sD - -o /dev/null -H "Authorization: Bearer $TOKEN" \
    https://api.github.com/repos/javrasya/perseverance/issues/1/sub_issues | grep -i media-type
X-GitHub-Media-Type: github.v3; format=json
```

### Surface matrix

| Data the harness needs | REST | GraphQL | `octocrab` 0.54.1 typed support |
|---|---|---|---|
| Map issue body / title / labels | `GET /repos/{o}/{r}/issues/{n}` | `Issue.body` / `.title` / `.labels` | ✅ `issues().get(n)` |
| Child issues of the map | `GET …/issues/{n}/sub_issues` | `Issue.subIssues` | ✅ `issues().list_sub_issues(n)` |
| Parent of a ticket | `GET …/issues/{n}/parent` | `Issue.parent` | ✅ `issues().get_parent_issue(n)` |
| Child title / number / state / stateReason | in the `sub_issues` payload | `Issue.subIssues.nodes{…}` | ✅ (fields on `models::issues::Issue`) |
| Child labels + assignees | in the `sub_issues` payload | `Issue.labels` / `.assignees` | ✅ |
| **Blocking edges (`blocked_by`)** | `GET …/issues/{n}/dependencies/blocked_by` | `Issue.blockedBy` | ❌ **none** |
| **Reverse edges (`blocking`)** | `GET …/issues/{n}/dependencies/blocking` | `Issue.blocking` | ❌ **none** |
| Progress counts | `sub_issues_summary` on the issue payload | `Issue.subIssuesSummary { total completed percentCompleted }` | ❌ not on the struct |
| Blocked/blocking counts per node | `issue_dependencies_summary` on the issue payload | `Issue.issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }` | ❌ not on the struct |
| Whole graph in one call | ❌ (1 + N) | ✅ | via raw `graphql()` |

REST reference pages: [rest/issues/sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [rest/issues/issue-dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) **[DOCS]**. GraphQL: [graphql/reference/objects#issue](https://docs.github.com/en/graphql/reference/objects#issue) **[DOCS]** — fields confirmed by live introspection **[VERIFIED]**:

```console
$ gh api graphql -f query='{__type(name:"Issue"){fields{name}}}'
… blockedBy blocking … issueDependenciesSummary … parent … subIssues subIssuesSummary …
```

---

## 2. The one query

This is the exact text, run verbatim against the fixture. It is also saved at `map-graph.graphql` in the repo root.

```graphql
query MapGraph($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title body url updatedAt
      labels(first: 10) { nodes { name } }
      subIssuesSummary { total completed percentCompleted }
      subIssues(first: 100) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number title state stateReason url updatedAt
          labels(first: 10) { nodes { name color } }
          assignees(first: 5) { nodes { login } }
          issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }
          blockedBy(first: 50) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { number title state repository { nameWithOwner } }
          }
        }
      }
    }
  }
  rateLimit { cost nodeCount limit remaining resetAt }
}
```

Run it with:

```console
$ gh api graphql -F owner=javrasya -F repo=perseverance -F number=1 -F query=@map-graph.graphql
```

**Live result [VERIFIED]** — the map body (5 140 chars), all 12 children with title/state/labels/assignees, and all 10 edges, in one response:

```
map #1 "Wayfinder harness" body_len=5140 children=12 cost=3 remaining=4479
  #2  OPEN  Claude Code observability surface        labels=["wayfinder:research"]   blockedBy=[]
  #3  OPEN  GitHub sub-issue and dependency API…     labels=["wayfinder:research"]   blockedBy=[]
  #4  OPEN  PTY spawn of agent CLIs on Windows…      labels=["wayfinder:research"]   blockedBy=[]
  #5  OPEN  Codex and Pi CLI surfaces for adapter…   labels=["wayfinder:research"]   blockedBy=[]
  #6  OPEN  Session registry and local store shape   labels=["wayfinder:grilling"]   blockedBy=[]
  #7  OPEN  Graph data model, derived phase…         labels=["wayfinder:grilling"]   blockedBy=[3]
  #8  OPEN  Harness prompt templates                 labels=["wayfinder:grilling"]   blockedBy=[3]
  #9  OPEN  Agent adapter contract                   labels=["wayfinder:grilling"]   blockedBy=[5, 4, 2]
  #10 OPEN  Graph visual language                    labels=["wayfinder:prototype"]  blockedBy=[7]
  #11 OPEN  App shell layout                         labels=["wayfinder:prototype"]  blockedBy=[10, 9]
  #12 OPEN  Run lifecycle, supervision…              labels=["wayfinder:grilling"]   blockedBy=[9, 4]
  #13 OPEN  Frontend stack and Rust-to-web wiring    labels=["wayfinder:grilling"]   blockedBy=[11]
```

Measured over 5 raw `curl` round trips **[VERIFIED]**: `0.691s / 0.407s / 0.369s / 0.347s / 0.392s`, `bytes=12723`, `cost=3`, `nodeCount=6610`. (`nodeCount` is what GitHub *reserved* against the 500 000-node ceiling assuming every `first:` is saturated, not what came back — the real response is 12 nodes.)

### There is no N+1, and there is no pagination

GitHub's own product limits make a single page sufficient for a wayfinder map:

- *"You can add up to **100 sub-issues** per parent issue"* and *"up to **eight levels** of nested sub-issues"* — [docs.github.com/…/adding-sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) **[DOCS]**
- *"You can link up to **50 issues** for each relationship type"* — [changelog 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues/) **[DOCS]**
- GraphQL `first`/`last` must be 1–100 — [resource limitations](https://docs.github.com/en/graphql/overview/resource-limitations) **[DOCS]**

So `subIssues(first: 100)` and `blockedBy(first: 50)` are each at the product ceiling: **`hasNextPage` can never be true** for a one-level map. Keep the `pageInfo` blocks in the query anyway as a tripwire — they are free (not connections) and will tell you loudly if GitHub raises a limit.

Cursor pagination does work if you ever need it **[VERIFIED]** — cursors are opaque base64 offsets:

```console
$ gh api graphql -f query='{repository(owner:"javrasya",name:"perseverance"){issue(number:1){subIssues(first:5){pageInfo{hasNextPage endCursor} nodes{number}}}}}'
{"nodes":[2,3,4,5,6],"pageInfo":{"endCursor":"NQ","hasNextPage":true}}
$ …subIssues(first:5,after:"NQ")…
{"nodes":[7,8,9,10,11],"pageInfo":{"endCursor":"MTA","hasNextPage":true}}
```

### Ordering: `subIssues` returns map order, and cannot be re-sorted

Introspection shows `subIssues` takes **only** `after / before / first / last` — **no `orderBy`** — whereas `blockedBy` and `blocking` do take `orderBy` **[VERIFIED]**:

```console
$ gh api graphql -f query='{__type(name:"Issue"){fields{name args{name}}}}'
subIssues  args: [after, before, first, last]
blockedBy  args: [orderBy, after, before, first, last]
blocking   args: [orderBy, after, before, first, last]
```

The fixture came back as #2…#13, i.e. the parent's own sub-issue list order **[VERIFIED]**. That is exactly what *"first in map order among unblocked and unclaimed"* (Decisions so far, item 8) needs — the API hands you the canonical ordering and gives you no way to accidentally destroy it.

### Two scalars that make frontier derivation cheap

`issueDependenciesSummary` distinguishes open blockers from all blockers **[VERIFIED]** (schema descriptions pulled live):

| Field | Description from the schema |
|---|---|
| `blockedBy` | *"Count of issues this issue is blocked by"* |
| `totalBlockedBy` | *"Total count of issues this issue is blocked by (open and closed)"* |
| `blocking` | *"Count of issues this issue is blocking"* |
| `totalBlocking` | *"Total count of issues this issue is blocking (open and closed)"* |

So **`issueDependenciesSummary.blockedBy == 0` means "every blocker is resolved"** — one integer per node. The `blockedBy` edge *lists* are needed only to *draw* the graph, never to compute the frontier. That matters for the cheap-poll design in §4.

### What REST costs instead

REST returns everything too, but the edges are per-issue endpoints, so the graph is **1 + N** calls: one `sub_issues` call (which already carries each child's title, state, labels, assignees, `sub_issues_summary`, `issue_dependencies_summary`, `parent_issue_url`) plus one `dependencies/blocked_by` per child. For the 12-child fixture that is **13 calls** where GraphQL needs 1. The REST payloads are also enormous — each child embeds the full repository object.

REST-only fields worth knowing **[VERIFIED]** — `GET /repos/{o}/{r}/issues/3` returns:

```json
{ "parent_issue_url": "https://api.github.com/repos/javrasya/perseverance/issues/1",
  "sub_issues_summary": { "total": 0, "completed": 0, "percent_completed": 0 },
  "issue_dependencies_summary": { "blocked_by": 0, "total_blocked_by": 0, "blocking": 2, "total_blocking": 2 } }
```

(Note `.parent` is **not** a field on the REST issue payload — it is `parent_issue_url` **[VERIFIED]**; `gh api … --jq .parent` returns `null` and will silently mislead you.)

REST pagination is standard `page` / `per_page`, default 30, max 100, with a `Link` header **[DOCS + VERIFIED]**:

```
Link: <…/issues/1/sub_issues?per_page=5&page=2>; rel="next", <…?per_page=5&page=3>; rel="last"
```

`per_page=200` is silently clamped, not rejected **[VERIFIED]**.

---

## 3. Rate limits and the refresh maths

### The cost formula, confirmed empirically

[Resource limitations](https://docs.github.com/en/graphql/overview/resource-limitations) **[DOCS]**:

> *"Add up the number of requests needed to fulfill each unique connection in the call. Assume every request will reach the `first` or `last` argument limits."* … *"Divide the number by 100 and round the result to the nearest whole number."* … *"The minimum point value of a call to the GraphQL API is 1."*

For the map query with `subIssues(first: N)` and 3 nested connections per node:

> **cost = max(1, round( (1 + 3N) / 100 ))**

Note this depends on the **declared `first`**, not on how many children actually exist — and **not at all** on the nested `first:` values. Measured against the fixture **[VERIFIED]**:

| `subIssues(first:)` | predicted | measured |
|---|---|---|
| 33 | round(1.00) = 1 | **1** |
| 49 | round(1.48) = 1 | **1** |
| 50 | round(1.51) = 2 | **2** |
| 66 | round(1.99) = 2 | **2** |
| 83 | round(2.50) = 3 | **3** |
| 100 | round(3.01) = 3 | **3** |

And by number of nested connections at `first: 100` **[VERIFIED]**: 0 nested → cost 1; labels only → 1; labels+assignees → 2; labels+assignees+blockedBy → 3.

### Budgets

| | GraphQL | REST |
|---|---|---|
| Primary limit (user PAT) | **5 000 points/hour** | **5 000 requests/hour** |
| Secondary (burst) | **2 000 points/minute** | **900 points/minute** (`GET` = 1 point) |
| Concurrency | 100 concurrent | 100 concurrent |
| Node ceiling | 500 000 nodes/call | — |

Sources: [GraphQL resource limitations](https://docs.github.com/en/graphql/overview/resource-limitations), [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) **[DOCS]**. Live headers confirm the ceiling **[VERIFIED]**: `X-RateLimit-Limit: 5000`, `X-RateLimit-Resource: graphql`.

### What a several-second refresh actually consumes

Full query at `first: 100` → **cost 3**:

| Cadence | Calls/hour | Points/hour | % of 5 000 |
|---|---|---|---|
| every 2 s | 1 800 | **5 400** | **108 % — exceeds** |
| every 3 s | 1 200 | 3 600 | 72 % |
| every 5 s | 720 | 2 160 | 43 % |
| every 10 s | 360 | 1 080 | 22 % |

Ceiling at cost 3: **1 666 calls/hour = one every 2.16 s**.

Same query sized `first: 49` (any map of ≤ 49 tickets) → **cost 1**:

| Cadence | Calls/hour | Points/hour | % of 5 000 |
|---|---|---|---|
| every 1 s | 3 600 | 3 600 | 72 % |
| every 3 s | 1 200 | **1 200** | **24 %** |
| every 5 s | 720 | 720 | 14 % |

Ceiling at cost 1: **5 000 calls/hour = one every 0.72 s**.

Burst limits are a non-issue either way: at one call per 3 s that is 20 calls/min × 3 = **60 points/min against a 2 000/min cap**.

**The budget is per user account, not per process.** Every `gh` call the agent session makes, every other tool on the machine using the same token, and every concurrent AFK research worktree draws from the same 5 000. A 72 % steady-state draw from polling alone is not a safe place to sit.

### REST-only refresh does not fit — unless you use ETags

1 + 12 = 13 calls per refresh at 3 s = **15 600 requests/hour**, i.e. **3.1× over the limit**. Conditional requests rescue it entirely:

> *"Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized with an `Authorization` header."* — [best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) **[DOCS]**

**Confirmed live [VERIFIED]** — three consecutive conditional GETs, `X-RateLimit-Used` frozen at 6, then one unconditional GET moves it to 7:

```
HTTP/1.1 304 Not Modified   X-RateLimit-Used: 6
HTTP/1.1 304 Not Modified   X-RateLimit-Used: 6
HTTP/1.1 304 Not Modified   X-RateLimit-Used: 6
HTTP/1.1 200 OK             X-RateLimit-Used: 7
```

`GET …/issues/1/sub_issues` does return an `ETag` (a 64-hex content hash) and honours `If-None-Match` **[VERIFIED]**.

### GraphQL has no ETags

The GraphQL endpoint returns **no `ETag` header** **[VERIFIED]** — response headers are `X-RateLimit-*` and `X-GitHub-Request-Id` only. The [resource limitations](https://docs.github.com/en/graphql/overview/resource-limitations) page does not mention conditional requests at all **[DOCS]**. There is no way to make a GraphQL poll free.

### The map issue's own `updatedAt` is useless as a change signal

**[VERIFIED]** — the map's `updatedAt` is *older* than several of its children's:

```
map #1        updatedAt = 2026-07-31T23:59:10Z
child #3      updatedAt = 2026-08-01T10:41:57Z
child #2      updatedAt = 2026-08-01T10:41:55Z
```

Do **not** build a "has the graph changed?" check on the parent issue's timestamp. Child mutations do not propagate to it.

---

## 4. A cheaper polling shape

Strip every nested connection from the poll and it drops to **cost 1** at `first: 100`, returning ~1.5 KB **[VERIFIED]**:

```graphql
query MapPoll($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title body updatedAt
      subIssuesSummary { total completed }
      subIssues(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes {
          number state stateReason updatedAt
          issueDependenciesSummary { blockedBy blocking totalBlockedBy totalBlocking }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

```console
$ gh api graphql -F owner=javrasya -F repo=perseverance -F number=1 -F query=@map-poll.graphql --jq .data.rateLimit
{"cost":1,"nodeCount":100,"remaining":4417,"resetAt":"2026-08-01T11:02:14Z"}
```

`body`, `state`, `updatedAt`, `subIssuesSummary` and `issueDependenciesSummary` are all scalars/objects, not connections, so they are free. This poll already carries **everything needed to derive phase, progress counts, and the designated frontier** (see the `blockedBy == 0` observation in §2) — it only lacks labels, assignees and the edge lists, which are needed to *render*, not to *decide*.

Fingerprint the poll (child count + per-child `state` + `updatedAt` + dependency counts) and run the full cost-3 query only when the fingerprint moves. Steady state at 3 s: **1 200 points/hour, 24 % of budget**.

Caveat: this depends on `updatedAt` bumping when labels or assignees change, which I could not verify read-only (see below). Pair it with a full refresh on a slower timer — every 60 s is 60 calls/hour × 3 = 180 points, noise.

---

## 5. `octocrab`

**Version: 0.54.1**, published **2026-07-24**, the latest on crates.io as of today **[VERIFIED]**:

```console
$ curl -s https://crates.io/api/v1/crates/octocrab | jq '.crate.max_version, .crate.updated_at'
"0.54.1"
"2026-07-24T09:28:15Z"
```

Findings are from a shallow clone of `github.com/XAMPPRocky/octocrab` at tag `v0.54.1` (commit `e6f4fc1`) **[VERIFIED]**, plus a compiled-and-run test binary.

### Sub-issues: typed, complete

`src/api/issues.rs`:

| Line | Signature |
|---|---|
| 1130 | `pub async fn get_parent_issue(&self, sub_issue_number: u64) -> Result<models::issues::Issue>` |
| 1149 | `pub fn list_sub_issues(&self, issue_number: u64) -> ListSubIssuesBuilder<'_, '_>` |
| 1163 | `pub async fn add_sub_issue(…)` *(write)* |
| 1189 | `pub async fn remove_sub_issue(…)` *(write)* |
| 1213 | `pub async fn reprioritize_sub_issue(…)` *(write)* |

`ListSubIssuesBuilder` (line 1237) exposes `.per_page(u8)` / `.page(u32)` and `.send() -> Result<Page<models::issues::Issue>>`. Verified working **[VERIFIED]**:

```
[typed list_sub_issues] 12 items, first = #2 Claude Code observability surface
```

### Issue dependencies: absent

Grepping the whole crate source for the dependency endpoints returns **nothing** — every hit for `blocking` is the unrelated *user-blocking* API (`src/api/users.rs`, `blocking:read` scope) or a webhook enum variant **[VERIFIED]**:

```console
$ grep -rniE "blocked_by|/dependencies" src/ --include=*.rs
(no matches)
```

There is **no** `issues().list_blocked_by()`, no `list_blocking()`, no dependency model.

### `models::issues::Issue` drops the summary fields

The struct (`src/models/issues.rs`) has `id, node_id, url, repository_url, labels_url, comments_url, events_url, html_url, number, state, state_reason, title, body, body_text, body_html, user, labels, assignee, assignees, author_association, milestone, locked, active_lock_reason, comments, pull_request, closed_at, closed_by, created_at, updated_at` — and **[VERIFIED]** **no** `sub_issues_summary`, **no** `parent_issue_url`, **no** `issue_dependencies_summary`. Even the typed `list_sub_issues` results silently discard the dependency counts that REST actually returned.

### Escape hatches — all three verified working

```rust
// (a) raw GraphQL — R deserialises the `data` object directly
pub async fn graphql<R: DeserializeOwned>(&self, payload: &(impl Serialize + ?Sized)) -> Result<R>   // src/lib.rs:1456

// (b) raw REST GET with your own struct
pub async fn get<R, A, P>(&self, route: A, parameters: Option<&P>) -> Result<R>                       // src/lib.rs:1570
where A: AsRef<str>, P: Serialize + ?Sized, R: FromResponse

// (c) raw GET exposing request + response headers (needed for ETag)
pub async fn _get_with_headers(&self, uri: impl TryInto<Uri>, headers: Option<http::HeaderMap>)
    -> Result<http::Response<BoxBody<Bytes, crate::Error>>>                                           // src/lib.rs:1641

pub fn ratelimit(&self) -> ratelimit::RateLimitHandler<'_>                                            // src/lib.rs:1419
```

Live output from the test binary **[VERIFIED]**:

```
[graphql] map #1 "Wayfinder harness" body_len=5140 children=12 cost=3 remaining=4479
[typed list_sub_issues] 12 items, first = #2 Claude Code observability surface
[raw get] IssueExt { number: 3, sub_issues_summary: Some(…{total:0,completed:0}),
                     issue_dependencies_summary: Some(DepsSummary { blocked_by: 0, blocking: 2,
                       total_blocked_by: 0, total_blocking: 2 }),
                     parent_issue_url: Some("…/issues/1") }
[raw get deps/blocking] [7, 8]
[_get_with_headers] status=200 OK etag="49b71a112b038eb70555c9caa30fc42af449af15aaa3172820a1410b0108c463"
[conditional replay] status=304 Not Modified
[ratelimit] core=4979/5000 graphql=Some((4479, 5000))
```

**Two gotchas found while doing this:**

1. The doc-comment on `Octocrab::graphql` (`src/lib.rs:1450`) shows
   `let response: octocrab::GraphqlResponse<serde_json::Value> = …graphql(…)` — **this does not compile**. `graphql::<R>()` already unwraps `GraphqlResponse` and returns `res.data`, so the annotation must be the *data* type: `let d: serde_json::Value = crab.graphql(&json).await?;`. The published example is wrong.
2. octocrab **does** ship an ETag module (`pub mod etag` — `EntityTag`, `Etagged`, `insert_if_none_match_header`, `extract_from_response`), but it is wired into exactly one handler: `src/api/actions.rs` (workflow artifacts) **[VERIFIED]**. Nothing in the issues API accepts an ETag. For conditional issue polling you must go through `_get_with_headers` and set `if-none-match` yourself — which works (proved above).

### Where the harness drops to raw

| Need | Path |
|---|---|
| Whole map graph | **raw** `crab.graphql(&json!({"query": …, "variables": …}))` |
| `sub_issues_summary` / `issue_dependencies_summary` / `parent_issue_url` from REST | **raw** `crab.get::<MyStruct, _, _>(path, None::<&()>)` |
| `dependencies/blocked_by` \| `blocking` | **raw** `crab.get::<Vec<…>, _, _>(path, None::<&()>)` |
| Conditional REST polling | **raw** `crab._get_with_headers(path, Some(headers))` |
| Rate-limit introspection | typed `crab.ratelimit().get()` ✅ |
| Sub-issue list / parent lookup | typed ✅ — but returns a struct missing the summary fields |

Given the graph arrives whole from GraphQL, octocrab's typed sub-issue API is largely redundant for the harness. It is useful as a fallback path and for one-off lookups.

---

## 6. Scopes — read-only is sufficient

`gh auth token` yields a classic OAuth token with **`gist, read:org, repo, workflow`** **[VERIFIED]**:

```console
$ gh auth status
✓ Logged in to github.com account javrasya (keyring)
  Token scopes: 'gist', 'read:org', 'repo', 'workflow'
```

Asking GitHub itself what each endpoint accepts **[VERIFIED]**:

| Endpoint | `X-Accepted-OAuth-Scopes` |
|---|---|
| `GET /repos/{o}/{r}/issues/{n}` | `repo` |
| `POST /graphql` | `repo` |
| `GET …/issues/{n}/sub_issues` | *(empty)* |
| `GET …/issues/{n}/dependencies/blocked_by` | *(empty)* |
| `GET …/issues/{n}/dependencies/blocking` | *(empty)* |

**Nothing here needs a write scope.** `repo` is required only because `javrasya/perseverance` is **private** — classic PATs have no read-only private-repo scope, so `repo` is the floor. On a public map, `public_repo` would suffice. Every read in this document ran successfully under the token `gh auth token` already produces, and none of them required more.

The `repo` scope is broader than the harness needs (it grants write). That is a **`gh` CLI limitation, not an API requirement** — a fine-grained PAT scoped to *Issues: Read-only* + *Metadata: Read-only* would be true least privilege. If the harness ever wants to enforce read-only in the token itself rather than by convention, that is the lever. But per Decisions item 9 the token comes from `gh auth token`, and that token works.

---

## What I could not establish

- **Whether a child's `updatedAt` bumps on a label, assignee or dependency change.** Testing this requires mutating the fixture, which the read-only constraint rules out. The cheap-poll fingerprint in §4 assumes it does; back it with a slow full-refresh timer rather than trusting it.
- **Whether the REST `sub_issues` ETag changes when a child's state changes.** The ETag is a 64-hex content hash and the payload embeds each child's full state, so it almost certainly does — but I did not prove it, for the same reason.
- **Whether the `blockedBy` *connection* includes closed blockers.** The *summary* clearly distinguishes them (`blockedBy` vs `totalBlockedBy`); the connection's behaviour is undocumented on the page I read and the fixture has no closed issues to test against. If the harness needs "show me the resolved blockers too", verify this first.
- **Fine-grained token permissions for the sub-issue and dependency endpoints.** Both REST reference pages omit the permission block that most endpoints carry — [rest/issues/sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [rest/issues/issue-dependencies](https://docs.github.com/en/rest/issues/issue-dependencies). The `X-Accepted-OAuth-Scopes` headers come back empty too, so I have no authoritative statement for fine-grained PATs — only the classic-scope result above.
- **Cross-repository dependency edges.** The schema returns `repository { nameWithOwner }` per blocker so they are representable, and the fixture has none to confirm against.
- **Behaviour above the product limits** (>100 sub-issues, >50 edges per relationship). The limits are documented; I did not attempt to exceed them.

---

## Implications for the harness

1. **Build on GraphQL, not REST, and not on octocrab's typed API.** One `crab.graphql()` call returns the entire map — body, all children, states, labels, assignees, and every edge — in ~0.4 s for 3 points. REST needs 13 calls for the same 12-node graph and octocrab has no dependency support at all. Define the query once as a `const &str`, deserialise into the harness's own graph structs, and treat GraphQL as the only read path.

2. **Nothing is preview-gated, so there is no header ceremony and no flag to guard.** Both features went GA in 2025. Plain `Authorization` is enough on both surfaces. Don't build a capability probe for this.

3. **Pagination is structurally impossible for a one-level map**, because GitHub caps sub-issues at 100 per parent and edges at 50 per relationship, and both fit in one GraphQL page. Keep `pageInfo` in the query as a tripwire, log loudly if `hasNextPage` is ever true, and do not build a paging loop for v1.

4. **`subIssues` has no `orderBy`, and returns the parent's own list order.** The designated-frontier rule ("first in map order among unblocked and unclaimed") reads straight off the response array with no client-side sort. Preserve that array order end-to-end into the graph model.

5. **Frontier selection needs one integer, not the edge lists.** `issueDependenciesSummary.blockedBy` counts *open* blockers only, so `blockedBy == 0 && state == OPEN` is the whole unblocked test. The `blockedBy` node lists are a rendering concern. This cleanly separates the derived-state query from the draw-the-graph query.

6. **A 3-second full refresh costs 72 % of the account's hourly GraphQL budget, which is too much.** The budget is per *account* — shared with the agent session's own `gh` calls and with every concurrent AFK research worktree. Use the two-tier shape: a cost-1 poll every 3 s (24 % of budget) that carries everything needed to derive phase, progress and frontier, and the cost-3 full query only when the poll's fingerprint changes, plus a slow full-refresh floor. Size `first:` to the known child count — a map of ≤ 49 tickets makes even the full query cost 1.

7. **Surface the budget in the UI and read `rateLimit` from every response.** Include `rateLimit { cost remaining resetAt }` in the poll — it is free and it is the only way the harness will notice it is competing with the agent session for quota. Back off the poll interval when `remaining` drops, rather than discovering the limit at 403.

8. **Do not use the map issue's `updatedAt` to detect changes.** Verified: it does not move when a child does. Fingerprint the children.

9. **GraphQL polling can never be free — there are no ETags on `/graphql`.** If quota ever becomes the binding constraint, the fallback is a conditional REST `GET …/issues/{map}/sub_issues`, whose 304s cost nothing at all. That call carries every child's state, labels, assignees and dependency *counts* — enough to gate a GraphQL refresh — but not the edges. Keep it in the back pocket; do not build it for v1.

10. **Read-only is already satisfied by `gh auth token`.** Every call in this document succeeded with it, and none required a write scope. The `repo` scope is broader than needed only because the repo is private and classic PATs offer nothing narrower; that is a `gh` constraint, not an API one. If the "exactly one writer" invariant should be enforced by the credential rather than by discipline, a fine-grained PAT with *Issues: Read-only* + *Metadata: Read-only* is the lever — but it is a deliberate choice, not a requirement.

11. **Vendor the fix for octocrab's broken `graphql` example.** `graphql::<R>()` returns the *data* type, not `GraphqlResponse<T>`; the published doc example does not compile. Whoever writes the adapter will hit this in the first ten minutes.
