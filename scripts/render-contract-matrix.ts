/**
 * Regenerates `docs/contract/matrix.md` from the registry and the declarations.
 *
 * `npm run contract:matrix`. TypeScript rather than a `.mjs` beside the other
 * scripts because it reads the registry and the declaration parser directly —
 * a second copy of either, in a language that could not import them, is exactly
 * the parallel list the matrix exists to avoid. `vite-node` ships with vitest,
 * so this costs no dependency.
 *
 * The output gates nothing. `tests/contract-matrix.test.ts` asserts only that
 * it is current.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RULES } from "../src/contract/rules";
import { VIEWS } from "../src/views/views";
import { MATRIX_PATH, readDeclaration } from "../tests/support/contract";
import { renderMatrix } from "../tests/support/matrix";
import { REPO_ROOT } from "../tests/support/sources";

const path = join(REPO_ROOT, MATRIX_PATH);
writeFileSync(path, renderMatrix(RULES, VIEWS.map(readDeclaration)), "utf8");
process.stdout.write(`${MATRIX_PATH} rendered\n`);
