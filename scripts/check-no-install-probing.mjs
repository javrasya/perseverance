#!/usr/bin/env node
/**
 * Nothing on the resolution surface looks anywhere a `PATH` did not name.
 *
 * There are two tiers of resolution in this app and no third one: the folder's
 * own harvested environment, and an override the operator typed. A third tier
 * that went looking in `/opt/homebrew`, `%APPDATA%\npm` or wherever `where.exe`
 * points would not fail by being *incomplete* — it would fail by **diverging**
 * from what the operator's own shell resolves, and it would do it silently. A
 * silently wrong binary is worse than a loud not-found, which is what the
 * not-found readout is for. `docs/adr/0011` records the argument; this file is
 * the part of it a build can check.
 *
 * An allowlist of files rather than the whole tree, because a scan over
 * everything would have to permit the fixtures, the ADRs and the copy that
 * *names* these directories in order to say they are not looked in. The cost is
 * the same one `PTY_SOURCES` already carries and README records: a resolution
 * path added in a file not on this list escapes the scan.
 *
 * `C:\Windows` and `SystemRoot` are deliberately absent from the token set.
 * `powershell_location` derives the *harvest's own interpreter* from
 * `SystemRoot`, with a comment saying why `PATH` may not be used for it — the
 * `PATH` is the thing not yet acquired. That is not an agent CLI and is out of
 * scope.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file that resolves a program name, and nothing else. */
const SURFACE = [
  "crates/env/src/environment.rs",
  "crates/env/src/locate.rs",
  "crates/env/src/folder.rs",
  "crates/env/src/shell.rs",
  "crates/env/src/run.rs",
  "crates/app/src/lib.rs",
];

/**
 * The vocabulary of looking somewhere a `PATH` did not name. Two kinds: a
 * hardcoded install directory, and shelling out to something that answers with
 * one. Matched case-insensitively, because a candidate list does not become
 * acceptable by being shouted.
 */
const PROBING = [
  "/usr/local/bin",
  "/opt/homebrew",
  ".local/bin",
  "Program Files",
  "AppData\\Roaming\\npm",
  "npm root",
  "npm prefix",
  "where.exe",
  "Get-Command",
  "command -v",
  "whereis",
];

/** Same length as what it replaced, so every line number survives. */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Comments out, strings in.
 *
 * A doc comment that *names* `/opt/homebrew` in order to say it is never looked
 * in must not fail this — the whole crate argues its case in prose. So comments
 * are removed from what is scanned, and string literals are kept, because a
 * literal is exactly where a hardcoded directory would live.
 *
 * `code` is the same text with string bodies blanked as well, which is what the
 * brace matcher below counts: a `{` inside a string is not a block.
 */
function strip(source) {
  let text = "";
  let code = "";
  let at = 0;

  /** Ordinary source: kept in both, so the brace matcher can see it. */
  const both = (body) => {
    text += body;
    code += body;
  };
  /** A string literal: scanned for tokens, invisible to the brace matcher. */
  const literal = (body) => {
    text += body;
    code += blank(body);
  };
  /** A comment: invisible to both. */
  const drop = (body) => {
    text += blank(body);
    code += blank(body);
  };

  while (at < source.length) {
    const here = source[at];
    const next = source[at + 1];

    if (here === "/" && next === "/") {
      let end = source.indexOf("\n", at);
      if (end === -1) end = source.length;
      drop(source.slice(at, end));
      at = end;
      continue;
    }

    // Rust block comments nest, so this counts rather than searching for `*/`.
    if (here === "/" && next === "*") {
      let depth = 0;
      let end = at;
      while (end < source.length) {
        if (source[end] === "/" && source[end + 1] === "*") {
          depth += 1;
          end += 2;
          continue;
        }
        if (source[end] === "*" && source[end + 1] === "/") {
          depth -= 1;
          end += 2;
          if (depth === 0) break;
          continue;
        }
        end += 1;
      }
      drop(source.slice(at, end));
      at = end;
      continue;
    }

    if (here === "r" && (next === '"' || next === "#")) {
      let cursor = at + 1;
      let hashes = 0;
      while (source[cursor] === "#") {
        hashes += 1;
        cursor += 1;
      }
      if (source[cursor] === '"') {
        const closing = `"${"#".repeat(hashes)}`;
        const found = source.indexOf(closing, cursor + 1);
        const end = found === -1 ? source.length : found + closing.length;
        literal(source.slice(at, end));
        at = end;
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
      literal(source.slice(at, cursor));
      at = cursor;
      continue;
    }

    // A char literal can hide a quote; a lifetime cannot, so only the first is
    // consumed and `'static` falls through as ordinary text.
    if (here === "'") {
      const quoted = /^'(\\.|[^\\'])'/.exec(source.slice(at, at + 4));
      if (quoted) {
        both(quoted[0]);
        at += quoted[0].length;
        continue;
      }
    }

    both(here);
    at += 1;
  }

  return { text, code };
}

/**
 * Test modules out.
 *
 * A test that puts a program somewhere no `PATH` names and asserts it is *not*
 * found has to name such a directory to be that test, and the agreement test in
 * `crates/app` spells `/usr/local/bin/claude` on purpose. Scanning them would
 * make the check reject its own strongest evidence.
 */
function withoutTestModules({ text, code }) {
  let kept = text;
  const marker = "#[cfg(test)]";
  let from = 0;

  for (;;) {
    const found = code.indexOf(marker, from);
    if (found === -1) break;
    const opening = code.indexOf("{", found);
    if (opening === -1) break;

    let depth = 0;
    let end = opening;
    while (end < code.length) {
      if (code[end] === "{") depth += 1;
      if (code[end] === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
      end += 1;
    }

    kept = kept.slice(0, found) + blank(kept.slice(found, end)) + kept.slice(end);
    from = end;
  }

  return kept;
}

/**
 * The verdict, as a pure function of one file's text, so the paragraph below
 * can put known-bad input through the same code the tree goes through.
 */
export function probingIn(file, source) {
  const scanned = withoutTestModules(strip(source));
  const haystack = scanned.toLowerCase();
  const found = [];

  for (const token of PROBING) {
    for (const needle of spellingsOf(token.toLowerCase())) {
      let at = haystack.indexOf(needle);
      while (at !== -1) {
        found.push({
          file,
          line: scanned.slice(0, at).split("\n").length,
          token,
        });
        at = haystack.indexOf(needle, at + needle.length);
      }
    }
  }

  return found.sort((left, right) => left.line - right.line);
}

/**
 * A Windows path is written two ways in Rust and both are the same directory:
 * `"AppData\\Roaming\\npm"` in an ordinary literal and `r"AppData\Roaming\npm"`
 * in a raw one. A scan that knew only the second would be defeated by the more
 * common of the two.
 */
function spellingsOf(needle) {
  if (!needle.includes("\\")) return [needle];
  return [needle, needle.replaceAll("\\", "\\\\")];
}

/*
 * A check nobody has ever seen fail is indistinguishable from a check that
 * cannot fail, which is why the two stack-level checks that came before this one
 * test themselves. This does the same, in both directions: input that must be
 * caught, and input that must not be — because a scan that flagged the prose
 * arguing against install-location probing would be turned off within a week,
 * and a scan turned off is a scan that cannot fail either.
 */
const KNOWN_BAD = [
  {
    name: "a hardcoded homebrew directory",
    source: 'fn look() -> &str { "/opt/homebrew/bin" }\n',
  },
  {
    name: "a hardcoded npm global root",
    source: 'const NPM: &str = "AppData\\\\Roaming\\\\npm";\n',
  },
  {
    name: "shelling out to where.exe",
    source: 'run_in(&env, "where.exe", &["claude"], &cwd, &bounds);\n',
  },
  {
    name: "shelling out to the shell's own resolver",
    source: 'let asked = format!("command -v {program}");\n',
  },
  {
    name: "asking PowerShell what it would run",
    source: 'let asked = "Get-Command claude";\n',
  },
  {
    name: "a candidate list hidden behind a raw string",
    source: 'const HOMES: &[&str] = &[r"C:\\Program Files\\claude"];\n',
  },
];

const KNOWN_GOOD = [
  {
    name: "prose that names a directory in order to refuse it",
    source: "/// There is no `/opt/homebrew` here and no `where.exe`: resolution\n\
/// walks the harvested `PATH` and names no directory of its own.\n\
pub fn locate(environment: &Environment, name: &str) -> Option<PathBuf> {\n\
    environment.resolve(name)\n\
}\n",
  },
  {
    name: "a block comment making the same argument",
    source: "/*\n * Never `command -v`, never `Get-Command`, never `/usr/local/bin`.\n */\nfn resolve() {}\n",
  },
  {
    name: "a test that puts a program where no PATH names it",
    source: '#[cfg(test)]\nmod tests {\n    #[test]\n    fn nowhere() {\n        let missed = "/usr/local/bin/claude";\n        assert!(resolve(missed).is_none());\n    }\n}\n',
  },
  {
    name: "the harvest's own interpreter, derived from SystemRoot",
    source: 'let root = lookup("SystemRoot").unwrap_or("C:\\\\Windows".to_string());\n',
  },
];

for (const { name, source } of KNOWN_BAD) {
  if (probingIn("known-bad.rs", source).length === 0) {
    console.error(`check-no-install-probing cannot detect ${name}: its own known-bad input passed.`);
    process.exit(1);
  }
}

for (const { name, source } of KNOWN_GOOD) {
  const found = probingIn("known-good.rs", source);
  if (found.length > 0) {
    console.error(
      `check-no-install-probing rejects ${name}, which it must not: ${found
        .map((one) => one.token)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

const findings = [];
for (const file of SURFACE) {
  let source;
  try {
    source = readFileSync(join(root, file), "utf8");
  } catch (error) {
    console.error(`check-no-install-probing cannot read ${file}: ${error.message}`);
    process.exit(1);
  }
  findings.push(...probingIn(file, source));
}

if (findings.length > 0) {
  console.error(
    "Resolution goes through the harvested PATH and through nothing else.\n" +
      "Found what looks like install-location probing:\n" +
      findings.map(({ file, line, token }) => `  ${file}:${line}  ${token}`).join("\n") +
      "\n\nThe failure mode of guessing at install directories is not incompleteness,\n" +
      "it is divergence from what the operator's own shell resolves — silently, and\n" +
      "in favour of the wrong binary. A loud not-found is the better answer, and the\n" +
      "per-folder readout is what makes it falsifiable. See docs/adr/0011.",
  );
  process.exit(1);
}

console.log(
  `no install-location probing across ${SURFACE.length} resolution-surface files.`,
);
