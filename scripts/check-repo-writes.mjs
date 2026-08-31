#!/usr/bin/env node
/**
 * Inside the operator's repository, this app runs `git worktree add` and
 * appends one line. Nothing else, and nothing forced.
 *
 * `docs/adr/0022` spent the old invariant — *the harness writes nothing inside
 * the operator's repository* — on the one thing that cannot be done from
 * outside, and replaced it with a narrower bound: one directory this app
 * created, and one line in a file git already treats as local-only. That ADR
 * names this file as the way the bound stops being a sentence, and this is it.
 *
 * The bound is worth a check because of how it would go: not by somebody
 * deciding to write in a stranger's checkout, but by one convenient `git`
 * invocation at a time — a `git fetch` to freshen the map, a `git config` to
 * spare the operator a step, a `--force` on the worktree that "obviously" wants
 * clearing. Each of those is one line in a review that already has forty, and
 * every one of them writes in a repository this app was lent rather than given.
 *
 * Three rules, over the non-test Rust of the whole workspace:
 *
 * 1. **No mutating `git` subcommand**, except the pair `worktree add` in
 *    `crates/worktree/` — *that* pair, in that order, and with no other mutating
 *    verb beside it. The verbs are read out of the argv literals of each
 *    `Command::new("git")` chain, and only verbs that cannot be read-only are
 *    named — `branch` and `remote` are absent because their listing spellings
 *    are ordinary and this check would rather miss a `git branch -f` (which the
 *    next rule catches anyway) than fire on a `git remote get-url`. The
 *    worktree verbs that write are named too: `remove`, `move`, `lock`,
 *    `unlock` and `repair` are how a second worktree command gets in, and ADR
 *    0022 gave this app exactly one.
 * 2. **No forcing flag in any `git` argv**, anywhere, including the crate that
 *    is allowed to run git. `--force`, `-f`, `-B`, `--hard`, `-D`: every one of
 *    them is git being told that something already there does not matter, and
 *    the whole posture of `perseverance-worktree` is that it does.
 * 3. **Inside `crates/worktree/`, files are appended to, never rewritten.**
 *    Every `OpenOptions` chain there must say `.append(true)` and may not say
 *    `.truncate(true)` or `.write(true)`: `.git/info/exclude` is the operator's
 *    file with the operator's excludes in it, and a press of ours reordering or
 *    truncating it is the intrusion the exclude line exists to prevent.
 *
 * Plus one literal: `.gitignore` may not be named in non-test code at all. The
 * tracked ignore file is a commit in somebody else's history about a directory
 * only this machine has, and no code here has a reason to spell it.
 *
 * **What this cannot see, and a reader should not think it does.** The child
 * session is not the harness: a work run is a coding agent editing the
 * operator's checkout, which is the point of it, and no scan of this workspace
 * bounds what it does. Nor does this catch a bare `fs::write` into the picked
 * folder — the path would have to be traced from `where_it_runs` to a call
 * site, which is more than source text can honestly say. What it does catch is
 * every way the *harness itself* has ever reached into that repository, which
 * is git, and the two writes the worktree crate performs with its own hands.
 *
 * Test modules are blanked before the scan, for the reason
 * `check-no-install-probing.mjs` blanks them: `crates/worktree`'s own tests
 * build a real repository with `git init`, `git add` and `git commit`, and a
 * check that rejected its own strongest evidence would be deleted within the
 * month.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Verbs that cannot be a read of the repository. */
const MUTATING = [
  "add",
  "am",
  "apply",
  "cherry-pick",
  "checkout",
  "clean",
  "clone",
  "commit",
  "config",
  "fetch",
  "gc",
  "init",
  "lock",
  "merge",
  "move",
  "mv",
  "prune",
  "pull",
  "push",
  "rebase",
  "remove",
  "repair",
  "reset",
  "restore",
  "rm",
  "stash",
  "submodule",
  "switch",
  "tag",
  "unlock",
  "update-ref",
  "worktree",
];

/**
 * The one pair a crate is allowed to say, in order, and the crate allowed to say
 * it.
 *
 * **In order, and nothing else with it.** The mutating verbs of an allowed argv
 * must be exactly this sequence — not a subset of it, which is what a per-crate
 * allowance would come to. A subset admits `git add .`, whose only mutating verb
 * is `add`: staging the operator's checkout, inside the one crate this check
 * exists to bound, passing because half of the allowed pair happens to spell a
 * verb of its own. `worktree` alone is admitted by nothing either, which is what
 * keeps `git worktree remove` and `git worktree move` out — ADR 0022 gives this
 * app one worktree verb, and removal is #60's.
 */
const ALLOWED = { crate: `crates${sep}worktree${sep}`, verbs: ["worktree", "add"] };

/** Git being told that what is already there does not matter. */
const FORCING = ["--force", "--force-with-lease", "-f", "-B", "-D", "--hard", "--delete"];

/** Where a chain that started at `Command::new("git")` is taken to end. */
const RUN = [".output(", ".status(", ".spawn(", "Command::new("];

/**
 * Comments blanked, string literals kept, offsets and line numbers unchanged.
 *
 * The doc comment above this file's own subject matter is the reason: the
 * worktree crate's module doc says `--force` appears in it nowhere, and a scan
 * that read comments would fire on the sentence promising the thing it checks.
 */
function withoutComments(source) {
  const blank = (body) => body.replace(/[^\n]/g, " ");
  let out = "";
  let at = 0;

  while (at < source.length) {
    const here = source[at];
    const next = source[at + 1];

    if (here === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(at, stop));
      at = stop;
      continue;
    }

    if (here === "/" && next === "*") {
      let depth = 0;
      let cursor = at;
      while (cursor < source.length) {
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (source[cursor] === "*" && source[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
          if (depth === 0) break;
          continue;
        }
        cursor += 1;
      }
      out += blank(source.slice(at, cursor));
      at = cursor;
      continue;
    }

    if (here === "r" && (next === '"' || next === "#")) {
      const opening = /^r(#*)"/.exec(source.slice(at));
      if (opening) {
        const closing = `"${opening[1]}`;
        const found = source.indexOf(closing, at + opening[0].length);
        const end = found === -1 ? source.length : found + closing.length;
        out += source.slice(at, end);
        at = end;
        continue;
      }
    }

    /* Char literals go before the `"` branch, because `'"'` is a quote that
       opens nothing. Read as the start of a string it would swallow everything
       up to the next quote in the file, and the scan would go quietly blind for
       as long as the quotes stayed odd — a real trespass sitting behind one
       would be reported as nothing at all. The literal is matched whole and
       blanked, because no rule here cares what a char says.

       The shape is deliberately narrow so a lifetime falls through untouched:
       `'a`, `&'static` and `'outer:` have no closing quote where a char literal
       has one, so the pattern does not match and the apostrophe is copied out
       like any other character. The byte forms need no case of their own — the
       `b` of `b'"'` is copied first and the quote arrives here. */
    if (here === "'") {
      const character =
        /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[^\n])|[^\\'\n])'/.exec(
          source.slice(at),
        );
      if (character) {
        out += blank(character[0]);
        at += character[0].length;
        continue;
      }
    }

    if (here === '"') {
      let cursor = at + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += source.slice(at, cursor);
      at = cursor;
      continue;
    }

    out += here;
    at += 1;
  }

  return out;
}

/** `#[cfg(test)]` modules blanked, brace by brace, offsets unchanged. */
function withoutTestModules(code) {
  const marker = "#[cfg(test)]";
  let kept = code;
  let from = 0;

  for (;;) {
    const found = kept.indexOf(marker, from);
    if (found === -1) break;
    const opening = kept.indexOf("{", found);
    if (opening === -1) break;

    let depth = 0;
    let end = opening;
    while (end < kept.length) {
      if (kept[end] === "{") depth += 1;
      if (kept[end] === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
      end += 1;
    }

    kept = kept.slice(0, found) + kept.slice(found, end).replace(/[^\n]/g, " ") + kept.slice(end);
    from = end;
  }

  return kept;
}

/** Every `"…"` in a slice, with the offset each one started at. */
function literalsIn(slice, offset) {
  const found = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  for (let match = pattern.exec(slice); match; match = pattern.exec(slice)) {
    found.push({ text: match[1], at: offset + match.index });
  }
  return found;
}

/**
 * The verdict, as a pure function of one file's text, so the paragraph below
 * can put known-bad input through the same code the tree goes through.
 *
 * `file` is the repository-relative path, and it is read: the one allowance in
 * these rules is a crate's, not a call site's.
 */
export function trespassesIn(file, source) {
  const code = withoutTestModules(withoutComments(source));
  const lineOf = (at) => code.slice(0, at).split("\n").length;
  const inside = file.split("/").join(sep).startsWith(ALLOWED.crate);
  const found = [];

  const git = 'Command::new("git")';
  for (let at = code.indexOf(git); at !== -1; at = code.indexOf(git, at + git.length)) {
    const from = at + git.length;
    const ends = RUN.map((token) => code.indexOf(token, from)).filter((end) => end !== -1);
    const to = ends.length > 0 ? Math.min(...ends) : code.length;
    const argv = literalsIn(code.slice(from, to), from);
    const verbs = argv.filter((word) => MUTATING.includes(word.text));

    const said = verbs.map((word) => word.text);
    /* The whole argv is judged once, not each verb against the allowance on its
       own: what is permitted is the command `git worktree add`, and a command is
       its verbs in the order it says them. */
    const allowed =
      inside &&
      said.length === ALLOWED.verbs.length &&
      said.every((verb, index) => verb === ALLOWED.verbs[index]);

    for (const word of verbs) {
      if (!allowed) {
        found.push({ file, line: lineOf(word.at), said: `git ${word.text}` });
      }
    }

    for (const word of argv.filter((word) => FORCING.includes(word.text))) {
      found.push({ file, line: lineOf(word.at), said: `git … ${word.text}` });
    }
  }

  for (const word of literalsIn(code, 0)) {
    if (word.text.includes(".gitignore")) {
      found.push({ file, line: lineOf(word.at), said: "the tracked .gitignore" });
    }
  }

  if (inside) {
    const options = "OpenOptions::new()";
    for (
      let at = code.indexOf(options);
      at !== -1;
      at = code.indexOf(options, at + options.length)
    ) {
      const opened = code.indexOf(".open(", at);
      const chain = code.slice(at, opened === -1 ? code.length : opened);
      const rewrites = [".truncate(true)", ".write(true)"].filter((mode) => chain.includes(mode));
      const modes = chain.includes(".append(true)")
        ? rewrites
        : [...rewrites, "no .append(true)"];
      for (const mode of modes) {
        found.push({ file, line: lineOf(at), said: `a file opened with ${mode}` });
      }
    }
  }

  return found.sort((left, right) => left.line - right.line);
}

/**
 * A check nobody has ever seen fail is indistinguishable from a check that
 * cannot fail. Each rule is fed source that was never in this repository, and a
 * `trespassesIn` that stopped seeing any one of them fails here rather than
 * going on printing its green line forever.
 */
const KNOWN_BAD = [
  {
    name: "a mutating git subcommand in the app",
    file: "crates/app/src/lib.rs",
    source: 'Command::new("git").arg("-C").arg(folder).arg("commit").output()?;\n',
  },
  {
    name: "git add outside the worktree crate",
    file: "crates/store/src/repo.rs",
    source: 'Command::new("git").arg("add").arg(".").status()?;\n',
  },
  {
    name: "a forced worktree in the crate allowed to make one",
    file: "crates/worktree/src/lib.rs",
    source: 'Command::new("git").arg("worktree").arg("add").arg("--force").arg(path).output()?;\n',
  },
  {
    name: "staging the operator's checkout from the crate allowed to run git",
    file: "crates/worktree/src/lib.rs",
    source: 'Command::new("git").arg("-C").arg(folder).arg("add").arg(".").output()?;\n',
  },
  {
    name: "a worktree removed by the crate that may only add one",
    file: "crates/worktree/src/lib.rs",
    source: 'Command::new("git").arg("worktree").arg("remove").arg(path).output()?;\n',
  },
  {
    name: "a worktree moved out from under the operator",
    file: "crates/worktree/src/lib.rs",
    source: 'Command::new("git").arg("worktree").arg("move").arg(path).arg(to).output()?;\n',
  },
  {
    name: "a prune the operator did not ask for",
    file: "crates/worktree/src/lib.rs",
    source: 'Command::new("git").arg("worktree").arg("prune").output()?;\n',
  },
  {
    name: "the tracked ignore file",
    file: "crates/worktree/src/lib.rs",
    source: 'std::fs::write(folder.join(".gitignore"), "/.perseverance/\\n")?;\n',
  },
  {
    name: "the operator's excludes rewritten rather than appended to",
    file: "crates/worktree/src/lib.rs",
    source: "OpenOptions::new().write(true).truncate(true).open(&exclude)?;\n",
  },
  {
    name: "an exclude file opened in no particular mode",
    file: "crates/worktree/src/lib.rs",
    source: "OpenOptions::new().create(true).open(&exclude)?;\n",
  },
  {
    name: "a trespass hidden behind a quote char literal",
    file: "crates/worktree/src/lib.rs",
    source:
      "let quote = '\"';\n" +
      'std::fs::write(folder.join(".gitignore"), "/.perseverance/\\n")?;\n',
  },
  {
    name: "a trespass hidden behind a byte quote literal",
    file: "crates/github/src/read.rs",
    source:
      "let quote = b'\"';\n" +
      'Command::new("git").arg("worktree").arg("remove").arg(path).output()?;\n',
  },
];

const KNOWN_GOOD = [
  {
    name: "the one command this workspace is allowed to run",
    file: "crates/worktree/src/lib.rs",
    source:
      'let mut command = Command::new("git");\n' +
      'command.arg("-C").arg(folder).arg("worktree").arg("add");\n' +
      'command.arg("-b").arg(branch).arg(path);\ncommand.output()\n',
  },
  {
    name: "a read of the repository",
    file: "crates/app/src/lib.rs",
    source: 'Command::new("git").arg("rev-parse").arg("HEAD").output()?;\n',
  },
  {
    name: "the append the exclude line is",
    file: "crates/worktree/src/lib.rs",
    source: "OpenOptions::new().create(true).append(true).open(&exclude)?;\n",
  },
  {
    name: "a comment promising what this file checks",
    file: "crates/worktree/src/lib.rs",
    source:
      "//! Nothing is forced: `--force` appears here nowhere, and the tracked\n" +
      "//! `.gitignore` is never touched.\n",
  },
  {
    name: "an apostrophe that is a lifetime and not a char",
    file: "crates/worktree/src/lib.rs",
    source:
      "fn refusal<'a>(said: &'a str, quote: char) -> &'a str {\n" +
      "    let _ = (quote, '\\'', 'x');\n    said\n}\n",
  },
  {
    name: "a test that builds a real repository",
    file: "crates/worktree/src/lib.rs",
    source:
      "#[cfg(test)]\nmod tests {\n    fn a_repository() {\n" +
      '        Command::new("git").arg("commit").arg("-m").arg("first").output();\n    }\n}\n',
  },
];

for (const { name, file, source } of KNOWN_BAD) {
  if (trespassesIn(file, source).length === 0) {
    console.error(`check-repo-writes cannot detect ${name}: its own known-bad input passed.`);
    process.exit(1);
  }
}

for (const { name, file, source } of KNOWN_GOOD) {
  const found = trespassesIn(file, source);
  if (found.length > 0) {
    console.error(
      `check-repo-writes fires on ${name}, which is code this repository wants:\n` +
        found.map((one) => `  ${one.file}:${one.line} ${one.said}`).join("\n"),
    );
    process.exit(1);
  }
}

/** Every `.rs` in the workspace, because the bound is the workspace's. */
function sourcesIn(folder) {
  const found = [];
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourcesIn(path));
    } else if (path.endsWith(".rs")) {
      found.push(path.slice(root.length + 1).split(sep).join("/"));
    }
  }
  return found.sort();
}

const findings = [];
for (const file of sourcesIn(join(root, "crates"))) {
  let source;
  try {
    source = readFileSync(join(root, file), "utf8");
  } catch (error) {
    console.error(`check-repo-writes cannot read ${file}: ${error.message}`);
    process.exit(1);
  }
  findings.push(...trespassesIn(file, source));
}

if (findings.length > 0) {
  console.error(
    "Inside the operator's repository this app runs `git worktree add` and appends one\n" +
      "line to `.git/info/exclude`. These write more than that:\n" +
      findings.map((one) => `  ${one.file}:${one.line} ${one.said}`).join("\n") +
      "\n\nA repository the operator lent this harness is not one it was given. If a new\n" +
      "write here is genuinely the bound moving, move it in docs/adr/0022 first — the\n" +
      "sentence is the decision and this file is only its enforcement.",
  );
  process.exit(1);
}

console.log(
  "the operator's repository: one `git worktree add`, one appended exclude line, nothing forced.",
);
