// main.ts is mend, the CLI SPEC.md specifies. It applies the edits AI models write, in four formats, to a tree
// of text files: unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and
// JSON edits (section 9), with line matching at three tiers (section 5), safe paths, format detection,
// the output and exit codes (sections 1 to 4) and the all-or-nothing write (section 10). Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Strip trailing spaces and tabs. */
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
/** Strip leading and trailing spaces and tabs. */
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** The leading spaces and tabs of a line. */
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
/** True when a line is empty or only spaces and tabs. */
const blankST = (s: string): boolean => /^[ \t]*$/.test(s);

/** One file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A successful move, for the `R <old> -> <new>` output row (SPEC.md section 2). */
interface Move {
  old: string;
  neu: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/**
 * Find old lines O in the file's lines at the first tier where they occur (SPEC.md section 5):
 * tier 0 exact, tier 1 trailing spaces/tabs ignored, tier 2 leading and trailing spaces/tabs ignored.
 * Occurrences may overlap. Returns the tier and every occurrence position at it, or null.
 */
function matchTier(O: string[], lines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndST : trimST;
    const oN = O.map(norm);
    const occ: number[] = [];
    for (let i = 0; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (norm(lines[i + j]!) !== oN[j]) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one (optionally only one ending at the last line). */
function findOccurrence(
  O: string[],
  lines: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndST : trimST;
    const oN = O.map(norm);
    for (let i = from; i + O.length <= lines.length; i++) {
      if (eofOnly && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (norm(lines[i + j]!) !== oN[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

/** First line at or after `from` equal to a single-line anchor, at the first tier with one (SPEC.md section 8). */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndST : trimST;
    const a = norm(anchor);
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]!) === a) return i;
    }
  }
  return null;
}

/**
 * Replace the k matched lines at `pos` with N (SPEC.md section 5). A context line (Nctx[k] >= 0) is written
 * as the file's own matched line; at tier 2 every other non-blank line of N starting with P (the leading
 * spaces/tabs of O's first line) has that P replaced by F (the leading spaces/tabs of the file's first
 * matched line); at tiers 0 and 1 N's lines are written as they are.
 */
function applyLines(lines: string[], pos: number, O: string[], N: string[], Nctx: number[], tier: number): string[] {
  const out: string[] = lines.slice(0, pos);
  const F = tier === 2 ? leadST(lines[pos]!) : '';
  const P = tier === 2 ? leadST(O[0]!) : '';
  for (let k = 0; k < N.length; k++) {
    const c = Nctx[k]!;
    if (c >= 0) {
      out.push(lines[pos + c]!);
      continue;
    }
    const t = N[k]!;
    if (tier === 2 && !blankST(t) && t.startsWith(P)) out.push(F + t.slice(P.length));
    else out.push(t);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\\' no-newline marker. */
interface BodyItem {
  kind: string;
  text: string;
}

/** O and N of a body, with Nctx[k] the index into O when N[k] is a context line, else -1. */
function splitBody(body: BodyItem[]): { O: string[]; N: string[]; Nctx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const Nctx: number[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      Nctx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      Nctx.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, Nctx };
}

/** Whether a `\` line follows the body's last context or `+` line (unified final-break rule). */
function bodyNoEol(body: BodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') return k + 1 < body.length && body[k + 1]!.kind === '\\';
  }
  return false;
}

/** Whether a `\` line follows the body's last `+` line (created-file final-break rule). */
function bodyPlusNoEol(body: BodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === '+') return k + 1 < body.length && body[k + 1]!.kind === '\\';
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyItem[];
  O: string[];
  N: string[];
  Nctx: number[];
  noEol: boolean;
  plusNoEol: boolean;
}

interface USection {
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isNew: boolean;
  isDeleted: boolean;
  /** True once a `---`/`+++` pair has been read as this section's header pair (SPEC.md section 6:
   *  a further pair is then "not already part of a section's header" and starts a new section). */
  sawDash: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim().replace(/^(a|b)\//, '');
}

function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const gitRe = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;
  const hunkRe = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { dashOld: null, dashNew: null, renOld: null, renNew: null, gitOld: m[1]!, gitNew: m[2]!, isNew: false, isDeleted: false, sawDash: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.sawDash) {
        // The header pair of the current section.
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        cur.sawDash = true;
      } else {
        cur = { dashOld: dashPath(line), dashNew: dashPath(lines[i + 1]!), renOld: null, renNew: null, gitOld: null, gitNew: null, isNew: false, isDeleted: false, sawDash: true, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      // A `--- ` line not followed by a `+++ ` line, inside a section's header.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: BodyItem[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('diff --git ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl === '' ? { kind: ' ', text: '' } : { kind: bl[0]!, text: bl.slice(1) });
          i++;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      const { O, N, Nctx } = splitBody(body);
      cur.hunks.push({ a, body, O, N, Nctx, noEol: bodyNoEol(body), plusNoEol: bodyPlusNoEol(body) });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // A header line, before the section's first hunk.
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec, strict, moves));
}

function unifiedEdit(sec: USection, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    const oldRaw = sec.dashOld ?? sec.renOld ?? sec.gitOld;
    const newRaw = sec.dashNew ?? sec.renNew ?? sec.gitNew;
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === '/dev/null' ? null : newRaw;
    const isCreate = oldPath === null || sec.isNew;
    const isDelete = newPath === null || sec.isDeleted;
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.body.some((b) => b.kind === '+')) {
          noEol = h.plusNoEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldPath ?? '';
    const newP = newPath ?? '';
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const isMove = oldP !== newP;
    const curText = tree.get(oldP);
    if (curText === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const st = parseFile(curText);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.O.length > 0) {
        const m = matchTier(h.O, st.lines, strict);
        if (!m) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = m.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of m.occ) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const touchesEof = best + h.O.length === st.lines.length;
        st.lines = applyLines(st.lines, best, h.O, h.N, h.Nctx, m.tier);
        if (touchesEof) st.finalBreak = !h.noEol;
        d += h.N.length - h.O.length;
      } else {
        const at = Math.min(Math.max(h.a + d, 0), st.lines.length);
        const touchesEof = at === st.lines.length;
        st.lines = [...st.lines.slice(0, at), ...h.N, ...st.lines.slice(at)];
        if (touchesEof) st.finalBreak = !h.noEol;
        d += h.N.length;
      }
    }
    const out = serializeFile(st);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      moves.push({ old: oldP, neu: newP });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const m = matchTier(oldLines, st.lines, strict);
    if (!m) throw new Fail('no-match', path);
    if (m.occ.length > 1) throw new Fail('ambiguous', path);
    st.lines = applyLines(st.lines, m.occ[0]!, oldLines, newLines, newLines.map(() => -1), m.tier);
    tree.now.set(path, serializeFile(st));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

function parseV4a(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const raw: number[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push(i);
        i++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      const fileLines: string[] = [];
      for (const idx of raw) {
        const rl = lines[idx]!;
        if (rl === '') fileLines.push('');
        else if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      const raw: number[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push(i);
        i++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      for (const idx of raw) {
        if (!blank(lines[idx]!)) throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLineNo = i + 1;
      i++;
      const raw: number[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push(i);
        i++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      let j = 0;
      let moveTo: string | null = null;
      if (j < raw.length && lines[raw[j]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[raw[j]!]!.slice(13).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (j < raw.length) {
        const idx = raw[j]!;
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          firstChunk = false;
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          j++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${idx + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]!, text: l.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, st.lines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N, Nctx } = splitBody(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        st.lines = [...st.lines.slice(0, at), ...N, ...st.lines.slice(at)];
        cursor = at + N.length;
        continue;
      }
      const m = findOccurrence(O, st.lines, cursor, strict, ch.eof);
      if (!m) throw new Fail('no-match', path);
      st.lines = applyLines(st.lines, m.pos, O, N, Nctx, m.tier);
      cursor = m.pos + N.length;
    }
    const out = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, neu: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (as the kit starter wrote them)               */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output, order and atomicity       */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per path whose state changed, in byte order of the paths (UTF-8). A successful move
  // replaces its pair's D and A lines with one `R <old> -> <new>` row, sorted by `<new>`.
  const byPath = new Map<string, { key: string; row: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const k = was === null ? 'A' : now === null ? 'D' : 'M';
    byPath.set(p, { key: p, row: `${k} ${p}` });
  }
  for (const mv of moves) {
    const o = byPath.get(mv.old);
    const n = byPath.get(mv.neu);
    if (o !== undefined && n !== undefined && o.row.startsWith('D ') && n.row.startsWith('A ')) {
      byPath.delete(mv.old);
      byPath.delete(mv.neu);
      byPath.set(mv.neu, { key: mv.neu, row: `R ${mv.old} -> ${mv.neu}` });
    }
  }
  const rows = [...byPath.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
    .map((x) => x.row);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
