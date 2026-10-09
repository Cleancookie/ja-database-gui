# 4. Commits are prefixed with an emoji that names the kind of change

Date: 2026-08-17
Status: Accepted

## Context

The history had no convention, so the only way to tell a bug fix from a feature
from a refactor was to read the diff. That is fine while one person holds the
whole project in their head and stops being fine immediately afterwards —
including for release notes, and for anything that wants to derive a version
number from the log.

This repo does not use the `AB#<ticket>` prefix that the G4C portal projects
do. There are no tickets; the subject line is the whole record.

## Decision

Every commit subject starts with one of four emoji, then a space, then the
description:

```
✨ Add SQL autocomplete to the filter box and the editor
🐛 Stop Enter in the filter box opening the cell viewer
```

| Emoji | Means | Semver |
| --- | --- | --- |
| 🔥 | Breaking change | major |
| ✨ | New capability | minor |
| 🛠️ | Minor change — refactors, docs, tooling, polish | minor |
| 🐛 | Bug fix | patch |

Only these four. A wider palette (📝 docs, ♻️ refactor, 🔧 config …) describes
the *area* rather than the *size* of a change, which is what a version number
needs; those all land on 🛠️ here.

The description keeps the existing style: imperative mood, capitalised, no
trailing full stop.

Not enforced mechanically. A `commit-msg` hook did this at first and was
removed: a hook that rejects a commit after the message is written is invisible
until it fires, needs a per-clone install step git will not do for you, and is
one more piece of machinery to maintain for a four-line rule. The convention
lives in `README.md` and `CLAUDE.md` instead, which is where a person or an
agent writing a commit will already be looking.

## Consequences

- The kind and rough size of every change is readable from `git log --oneline`.
- Automated semver tagging becomes a script over the log: 🔥 or ✨ anywhere
  since the last tag means a major bump, otherwise 🛠️ means minor, otherwise
  patch. That script does not exist yet; this is the groundwork for it.
- **✨ bumping major is a deliberate departure from convention**, where a new
  backwards-compatible feature is normally a minor bump. It was chosen on the
  grounds that "I added something significant" and "I broke something" are both
  worth announcing loudly. The cost is that major numbers will move quickly —
  a feature-heavy month could reach v9. If that becomes annoying, the fix is to
  move ✨ to minor and leave 🔥 as the only major, which changes this table and
  nothing else.
- Emoji in subject lines are one more thing that can render badly in a terminal
  or mail client. 🛠️ in particular carries a variation selector, so it is two
  code points and can occupy one or two columns depending on the font. Either
  form is acceptable in a subject; do not treat the bare 🛠 as wrong.
- Nothing rejects a non-conforming commit, so the convention can drift — it
  already did once before the hook existed. The mitigation is that both places
  a commit gets written from now state the rule; the check is `git log
  --oneline` during review, not a gate at commit time. If drift returns and the
  docs are not enough, the answer is a check in CI over the pushed range rather
  than a local hook — it needs no install step and reports where it can be seen.
- History before this ADR is unconverted. Rewriting it was considered and
  rejected: the subjects are already descriptive, and rewriting shared history
  to add decoration is a bad trade.

## Amendment 2026-10-09: ✨ is minor

The table above now says what this one did not: ✨ is a minor bump and 🔥 is
the only major. The first release script (`scripts/next-version.sh`, ADR 0010)
made the cost concrete before anything had shipped — a new capability is not a
breaking change, and a version that jumped a major for every feature would
stop saying anything. The paragraph under Consequences that called ✨-as-major
deliberate is superseded; the rest stands.
