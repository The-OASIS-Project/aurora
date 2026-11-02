/* The fake DAWN's fixtures (tests/fake-dawn/) against DAWN itself, for a person to look at: run
 * locally with DAWN checked out next to Aurora (../dawn), or pass DAWN's path. Not part of CI,
 * which has no DAWN. Reports:
 *  - each frame and request name the fixtures use that DAWN's docs/WEBSOCKET_PROTOCOL.md never
 *    mentions (a renamed frame, or one of DAWN's documentation gaps: check its source);
 *  - what changed in DAWN's WebUI and protocol doc since the commit the fixtures were last checked
 *    against (CHECKED_AGAINST in tests/fake-dawn/scenarios.ts), so a shape change gets looked at.
 * The unit round-trip (src/ingest/fake-dawn-fixtures.test.ts) checks the fixtures against Aurora;
 * this checks them against DAWN. docs/FAKE_DAWN_PLAN.md phase 1c. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
   CHECKED_AGAINST,
   SCENARIOS,
   answerFrame,
   connectFrames
} from "../tests/fake-dawn/scenarios.ts";
import { ANSWERED, OPTIONAL, SILENT } from "../tests/fake-dawn/fake-dawn.ts";

/* DAWN beside Aurora (resolved from this file, so it works from any directory), or the argument. */
const dawn = process.argv[2] ?? fileURLToPath(new URL("../../dawn", import.meta.url));
const docPath = join(dawn, "docs", "WEBSOCKET_PROTOCOL.md");
if (!existsSync(docPath)) {
   console.error(`DAWN's protocol doc isn't at ${docPath}: pass DAWN's path as the argument.`);
   process.exit(2);
}
const doc = readFileSync(docPath, "utf8");

/* Every frame type the fake sends, and every request type it takes. */
const frames = new Set(connectFrames(SCENARIOS.signedIn).map((f) => f.type));
for (const verb of ANSWERED) {
   if (verb === "init" || verb === "reconnect") continue;
   for (const f of answerFrame(verb, { conversation_id: 1, seq: 1 })) frames.add(f.type);
}
frames.add("error"); // UNKNOWN_TYPE
const requests = new Set([...ANSWERED, ...SILENT, ...OPTIONAL]);

/* Mentioned as code (`name`) or as a JSON string ("name", e.g. a "type" in an example). Generic
   names (state, error, config) will always match something: the list is a prompt to look, not
   proof. */
const missing = (names) =>
   [...names].filter((n) => !doc.includes(`\`${n}\``) && !doc.includes(`"${n}"`)).sort();
const missingFrames = missing(frames);
const missingRequests = missing(requests);

console.log(`Fixtures: ${frames.size} frame types, ${requests.size} request types.`);
if (missingFrames.length || missingRequests.length) {
   console.log("Not mentioned in DAWN's WEBSOCKET_PROTOCOL.md (check them against DAWN's source):");
   for (const n of missingFrames) console.log(`   frame    ${n}`);
   for (const n of missingRequests) console.log(`   request  ${n}`);
} else {
   console.log("Every name is in DAWN's WEBSOCKET_PROTOCOL.md.");
}

const git = (...args) => execFileSync("git", ["-C", dawn, ...args], { encoding: "utf8" }).trim();
const PATHS = ["src/webui", "docs/WEBSOCKET_PROTOCOL.md"];
try {
   const head = git("rev-parse", "--short=8", "HEAD");
   console.log(`\nFixtures checked against DAWN ${CHECKED_AGAINST}; DAWN is at ${head}.`);
   /* Is the checked commit behind this checkout? If not (an older or unrelated branch), the commit
      list below can't tell the whole story; the diff still compares the two trees. */
   let ancestor = true;
   try {
      git("merge-base", "--is-ancestor", CHECKED_AGAINST, "HEAD");
   } catch {
      ancestor = false;
      console.log(
         `Warning: ${CHECKED_AGAINST} isn't behind this checkout (an older or unrelated branch?):`
      );
      console.log(
         "   the protocol doc read above may not be the one the fixtures were checked against."
      );
   }
   if (ancestor) {
      const commits = git("log", "--oneline", `${CHECKED_AGAINST}..HEAD`, "--", ...PATHS);
      if (commits) {
         console.log("Commits since then touching DAWN's WebUI or protocol doc:");
         for (const line of commits.split("\n")) console.log(`   ${line}`);
      }
   }
   /* Against the working tree: both directions, and uncommitted edits too. */
   const diff = git("diff", "--stat", CHECKED_AGAINST, "--", ...PATHS);
   if (diff) {
      console.log("Changed since then (working tree included; look for shape changes):");
      for (const line of diff.split("\n")) console.log(`   ${line}`);
      console.log("Once the fixtures match, set CHECKED_AGAINST in tests/fake-dawn/scenarios.ts.");
   } else {
      console.log("No changes to DAWN's WebUI or protocol doc since.");
   }
} catch (e) {
   console.log(`\nCouldn't read DAWN's history (${e.message.split("\n")[0]}).`);
}
