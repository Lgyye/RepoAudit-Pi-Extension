import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseArgs } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const entryPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const parsed = parseArgs(["-e", entryPath]);

assert.deepEqual(parsed.extensions, [entryPath]);

const loaded = await loadExtensions(parsed.extensions, process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);

const toolNames = [...loaded.extensions[0].tools.keys()];
assert.deepEqual(toolNames, ["repoaudit_scan"]);

console.log(JSON.stringify({
  extensionPath: entryPath,
  extensionCount: loaded.extensions.length,
  toolNames,
  initializationErrors: loaded.errors,
}));
