# mend

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/revan997/hidden-spec-cli-01-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/revan997/hidden-spec-cli-01-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree
of files. `SPEC.md` is the whole specification. The checks that score it are drawn after the deadline
from a pool nobody outside the house has seen; the practice checks are public.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory; absent or `-` reads
  the patch from standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, detected per SPEC.md section 4).
- `--check` does everything but write: the same output and exit code, no file created, changed
  or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one row per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and
`ok: <n> files`. Exit 1 reports each failed edit (`no-match`, `ambiguous`, `missing`, `exists`,
`unsafe`) and `failed: <k> of <n> edits`, and writes nothing. Exit 2 reports one line:
`error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.

## How it works

- **Line matching (section 5).** Old lines are found at the first of three tiers where they occur:
  exact, trailing whitespace ignored, leading and trailing whitespace ignored. Context lines are
  written as the file's own lines; at tier 2 the other new lines are re-indented from the patch's
  indentation to the file's.
- **Unified diffs (section 6).** Sections from `diff --git` or bare `---`/`+++` pairs, with rename,
  create, delete and move handling; hunks take the occurrence nearest to `A - 1 + d`, insert empty
  hunks after `A + d` lines, and honour `\ No newline at end of file` at the end of the file.
- **SEARCH/REPLACE blocks (section 7).** Path from the nearest non-blank, non-fence line above the
  block (falling back to the previous block's path); the old lines must occur exactly once.
- **V4A patches (section 8).** Add, Delete and Update (+ Move to) sections; chunks with an anchor
  search from a cursor that is never reset, end-of-file chunks, and empty-old insertion at the cursor.
- **JSON edits (section 9).** Array or JSON Lines form; `create`, `str_replace` (exact, overlapping
  occurrences counted, CRLF round-tripped) and `insert` (line numbers count lines before insertion).
- **Order and atomicity (section 10).** Edits apply in patch order to the tree as earlier edits left
  it; every named path is checked for safety before anything else about the edit; a failed edit
  changes nothing and later edits still run; when any edit failed, no file is written.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on
  each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Validation

- Practice set: **100 of 100 passed (score 1000)**, ~20 s wall for 100 checks.
- A hand-built adversarial suite of 118 checks (one per SPEC sentence: CRLF files, tier
  boundaries, re-indentation, overlapping occurrences, nearest ties, the `d` offset, empty-old
  insertion, `\ No newline`, move/edit chains, rename, prefix stripping, bad `@@` lines, V4A
  cursor/EOF/`Move to`, SR path fallback, JSON fault line numbers, unsafe paths, CLI options,
  `--check`, `--strict`, empty patches, `R`-line sorting): **118 of 118 passed**, deterministic
  across two runs (identical output hashes).
- No model calls, no network, no clock, no randomness, no `eval`/dynamic import, no
  environment-secret reads — the same input always produces the same output.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and
indentation, blank context lines without their leading space, prose and code fences around the patch,
CRLF files, files without a final line break, blocks that occur twice. Read SPEC.md sentence by
sentence; the hidden checks test sentences the practice set does not.
