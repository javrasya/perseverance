import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const SRC_ROOT = join(REPO_ROOT, "src");

export interface SourceFile {
  /** Repo-relative, forward-slashed, so assertion messages are pasteable. */
  path: string;
  text: string;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

export function collect(extensions: readonly string[]): SourceFile[] {
  return walk(SRC_ROOT, [])
    .filter((full) => extensions.some((ext) => full.endsWith(ext)))
    .map((full) => ({
      path: relative(REPO_ROOT, full).split(sep).join("/"),
      text: readFileSync(full, "utf8"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function collectStylesheets(): SourceFile[] {
  return collect([".css"]);
}

export function collectMarkupAndStyles(): SourceFile[] {
  const inSrc = collect([".ts", ".tsx", ".css", ".svg", ".html"]);
  const indexHtml = join(REPO_ROOT, "index.html");
  return [
    ...inSrc,
    { path: "index.html", text: readFileSync(indexHtml, "utf8") },
  ];
}
