# Evaluation method

The point of this harness is to be hard to please. A briefing that sounds right and cites
nothing should score badly, and a briefing that cites the directory listing as proof of what
is inside a file should score *partially* — not fully. Getting those two cases right is most
of the design.

---

## The primary metric

**Evidence-backed task accuracy** — the share of all questions, across all cases, where the
system got the answer right **and** cited it from a location that actually contains the
answer.

```
evidenceBackedTaskAccuracy = evidenceBackedAnswers / totalQuestions
```

The denominator is every question in every case that was asked, including questions in cases
where the run crashed. There is no way to raise the metric by producing less.

Answer accuracy — correct answers over the same denominator — is reported alongside it. The
gap between the two is the interesting number: it is the share of the system's correct
answers that it could not substantiate, which is to say the share you would have had to
verify by hand.

## The four measures

Each question yields four independent judgements, computed in
[`score.ts`](../packages/evaluator/src/score.ts).

### 1. Correct answer

`expectedKeywords` must **all** appear in the targeted field. `anyOfKeywords` is a list of
alternative groups; at least one group must match in full. Matching is case-insensitive over
whitespace-collapsed text, so `Order.Created` matches `order.created` and a keyword split
across a line break still matches.

`field` narrows the search — `summary`, `dependencies`, `testing`, and so on, or `any` to
search the whole briefing. When a question matches under `any`, the score records
**which** section answered, so a failure can be traced without re-reading the briefing.

A question with neither `expectedKeywords` nor `anyOfKeywords` is **rejected at load time**.
An unscorable question that loaded successfully would sit in the denominator forever.

### 2. Evidence-backed answer — the primary metric

Three conditions, all required:

1. The answer is correct (measure 1).
2. The **claim that answered** carries at least one citation the grounding step confirmed
   (`grounded: true`). An unverified citation earns nothing.
3. If the case names `expectedEvidence`, one of those confirmed citations points at an
   expected location **with content strength**.

Condition 2 is stricter than it first looks. Evidence is credited **per claim**, not per
briefing. If a case asks for `express` and `routing`, and the briefing mentions `express` in
one component and routing in another, the joined text satisfies the keywords but no single
claim does — the score records a note reading *"matched across separate claims"* and credits
no evidence. Otherwise a briefing could earn the metric by being long.

### The content/existence distinction

This is the decision the whole metric turns on.

A citation of `tree` with `location: "src/services/inventory.js"` proves that file **exists**.
It does not prove anything about what is in it. A briefing that says *"the inventory service
has a race condition"* and cites the directory listing has not shown its work; it has shown
that a plausible-sounding filename exists.

So evidence carries a strength:

| Strength | Meaning | Earns |
| --- | --- | --- |
| `content` | The cited source's own text covers the expected location | **`evidenceBacked`** |
| `existence` | Only `tree` or `metadata` naming the path | `partialEvidence` |

`existence` is reported separately and never counts toward the primary metric. The score
records a note: *"the location was only shown to exist"*.

The practical consequence is that cases can be written on both sides of the line. In
`case-001-orders-api`, `q2-http-framework` expects `package.json`, which the baseline
genuinely receives — it can win that question outright. `q5-oversell-guard` expects
`src/services/inventory.js` and `docs/incidents/2025-08-oversell.md`, which the baseline never
opens — the best it can do is `partialEvidence`, and only an agent that reads files can earn
the metric.

That is deliberate: the baseline scores above zero, so the harness is measuring something,
and there is measurable headroom left for the agent to claim.

### 3. Unsupported claim

Two ways to earn one:

- **Uncited**: the answer is correct but the answering claim has no confirmed citation.
- **Fabricated**: the field contains a phrase from `mustNotContain`. This also fails the
  answer and sets `fabricationDetected`.

An *incorrect* answer is not "unsupported" — it is simply wrong, and counting it twice would
overstate the fabrication rate.

Separately, every briefing carries its own `evidenceAudit` from the grounding step:
citations claimed, citations verified, citations dropped with reasons, and claims left with
nothing behind them. Those numbers reach the report as `droppedCitations` and
`briefingUnsupportedClaims`, and they answer a different question than the per-case scores do:
not "was this answer supported?" but "what did the system try to claim that it could not back
up at all?"

### 4. Evidence relevance

Of the confirmed citations on the answering claim, the share pointing at a location the case
expects. `null` when the case names no expected location — reporting `0` there would be
false. The report averages relevance only over questions where it was measurable.

---

## Case format

```json
{
  "id": "case-001-orders-api",
  "title": "orders-api — write-side HTTP service for customer orders",
  "repository": "fixtures/orders-api",
  "notes": "Why this case exists and what it discriminates.",
  "questions": [
    {
      "id": "q2-http-framework",
      "question": "Which HTTP framework does the service use?",
      "field": "dependencies",
      "expectedAnswer": "Express (declared as a runtime dependency in package.json).",
      "expectedKeywords": ["express"],
      "anyOfKeywords": [],
      "mustNotContain": ["fastify", "koa", "nestjs"],
      "expectedEvidence": ["package.json"]
    }
  ]
}
```

`expectedAnswer` is documentation for a human reader and is never matched against.
`repository` is relative to the project root so cases are portable across machines.
`expectedEvidence` accepts a directory prefix (`src/services/`), which matches any file
beneath it.

### Writing a good question

- **Ask what a new engineer asks on day one.** "Which framework?" and "what breaks if I
  touch this?" — not trivia that happens to be greppable.
- **Choose `mustNotContain` phrases that could only appear as inventions.** `graphql` in a
  REST-only service is a good forbidden phrase. See the limitation below before choosing one
  with a natural negated form.
- **Set `expectedEvidence` to where the answer really lives**, not to where a shallow system
  could plausibly find it. A case that lowers its bar to let the baseline pass stops measuring
  the thing that matters.
- **Prefer few keywords.** Every extra keyword is another way for a correct answer to fail on
  phrasing rather than on substance.

## Dataset

Two cases, both against generated fixtures ([`scripts/build-fixtures.ts`](../scripts/build-fixtures.ts)),
seven questions each — 14 questions total.

| Case | Repository | Discriminates |
| --- | --- | --- |
| `case-001-orders-api` | Node/Express write-side service | Manifest reading vs. source reading; a race condition documented only in an incident note |
| `case-002-pyflow` | Python CLI ETL runner with SQLite state | A non-Node manifest (`pyproject.toml`); dispatch logic that lives only in source |

The fixtures are built with pinned author, email and commit dates, so commit hashes are
reproducible — which matters for a later agent that reads history.

## Running it

```sh
pnpm evaluate:baseline                          # every case
pnpm evaluate:baseline --mock                   # offline, deterministic, no cost
pnpm evaluate:baseline --case case-001-orders-api
pnpm evaluate:baseline --cases ./my-cases --out ./my-results
```

Output in [`evaluation/results/`](../evaluation/results/): a timestamped JSON report, a
timestamped Markdown summary, and a stable `latest-baseline.{json,md}` pair.

The report records total cases, passed cases (all questions correct), fully-cited cases,
failed cases, total questions, correct answers, evidence-backed answers, partial-evidence
answers, unsupported answers, fabrications, dropped citations, average evidence relevance,
runtime, token usage, estimated cost, and the full per-question breakdown.

### Determinism

As deterministic as the harness can make it:

- Scoring is pure string logic — no model judge.
- Cases load in filename order; questions in file order.
- The seed, model, thinking level and Node version are recorded on every report.
- Timestamps and durations come from an injectable clock, so tests pin them.

What is *not* deterministic is the model. Gemini's Interactions API takes a seed rather than a
temperature, and a fixed seed is a best effort, not a guarantee. Two runs against the real API
may differ; two runs against `--mock` will not.

### Cost

`estimatedCostUsd` is computed from token usage and published per-model prices. If any run in
the report used a model with no published price, the total is reported as a **lower bound**
(`costEstimateComplete: false`, and the Markdown says "at least $…"). If no run could be
priced, the figure is `null` and the summary says `unknown` rather than `$0.000000` — a zero
there would read as free.

---

## Current results

**None yet.** No evaluation run against a real model has been executed, so there is no
baseline number to report and nothing here claims the results are good.

The pipeline has been verified end to end with the offline mock provider: both cases load,
both produce a schema-valid briefing, every citation is verified, both artefacts are written,
and the totals are arithmetically consistent. Those scores measure the harness and the canned
mock text — **not any model** — and the runner stamps every mock report with a caveat saying
so in the report itself.

To produce a real result: set `GEMINI_API_KEY` in `.env` and run `pnpm evaluate:baseline`.
The first real number is the baseline, whatever it turns out to be, and it should be recorded
in `CHANGELOG.md` alongside the model id and seed that produced it.

<a name="limitations"></a>
## Limitations

Stated plainly, because a metric whose weaknesses are undocumented invites being gamed by
accident.

1. **Two cases, 14 questions.** One question is 7.1 percentage points. Differences smaller
   than a few questions are noise, and the report says so in a caveat on every run.
2. **Keyword matching is not comprehension.** A briefing can contain `express` while being
   confused about how it is used. Matching rewards the presence of the right token, not
   understanding — it is the trade taken to keep scoring deterministic and model-free.
3. **`mustNotContain` is naive substring matching.** A briefing that correctly says *"there is
   no GraphQL layer"* trips a `graphql` forbidden phrase. Choose forbidden phrases that could
   only appear as inventions, and check the per-question notes before believing a fabrication
   count.
4. **Excerpt verification is textual, not semantic.** An excerpt that genuinely appears in the
   cited source passes even if it does not actually support the claim built on it. Grounding
   proves provenance, not relevance.
5. **Truncated sources can cause false drops.** A long README is cut at a budget; an excerpt
   from the discarded tail is unverifiable through no fault of the model. The drop reason says
   `truncated` so these are distinguishable, but they still cost the metric.
6. **The baseline cannot answer file-internal questions at all.** Roughly a third of the
   questions in the dataset expect evidence from a source file the baseline never opens. Its
   ceiling on those is `partialEvidence`. This is intentional headroom, not an oversight — but
   it means the baseline's score is not a measure of "how good is an LLM at reading code".
7. **Fixture repositories are synthetic.** They were written to have the properties the cases
   test. Real repositories are messier, larger, and less tidily documented; scores here are an
   upper bound on what to expect in the wild.
8. **`passedCases` is all-or-nothing.** A case where six of seven questions are right counts
   as not passed. It is a deliberately harsh secondary figure; the primary metric is the
   per-question one.
