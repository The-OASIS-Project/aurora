#!/usr/bin/env node
/*
 * Source checks: Aurora's design rules that need no build (the counterpart of DAWN's
 * source-checks job). ESLint holds the layer and import rules; these are the ones a linter
 * can't express:
 *
 *   colors     A color is a token: no hex, rgb()/hsl()/hwb()/lab()/lch()/oklab()/oklch()/color(), or
 *              (in CSS) named color outside src/design/tokens.ts. main.css and index.html mirror a
 *              few tokens as pre-boot fallbacks, and each must match its token.
 *              In TypeScript only string and template text is read (a color can't live anywhere
 *              else), so comments and identifiers never count. A spot that truly needs a literal (an
 *              alpha-only mask or sprite) says so with "color-ok:" and a reason, on its line or up
 *              to three lines above.
 *   dawn-urls  Every DAWN path ("/api/...", "/js/...", "/ws", "/music-ws") is built with dawnUrl() or
 *              tagDawnUrl(), so it carries Aurora's own login (per-app logins): the string must sit
 *              inside one of those calls. A path that is only inspected (no request) says so with
 *              "dawn-url-ok:" and a reason.
 *   em-dashes  No em dashes in prose. A lone "—" as an empty-cell placeholder is allowed.
 *
 * Usage: node scripts/check-source.mjs   (exit 1 with file:line findings)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/* The repo's files as they stand: tracked and new, minus deleted (so a run before committing a
   move checks the moved file, not the stale path). Outside a git checkout (a source tarball),
   every file under the root except the build and dependency folders. */
function listFiles() {
   try {
      return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
         encoding: "utf8",
         stdio: ["ignore", "pipe", "ignore"]
      })
         .split("\0")
         .filter((f) => f && existsSync(f));
   } catch {
      const out = [];
      const walk = (dir) => {
         for (const name of readdirSync(dir)) {
            if (["node_modules", "dist", "coverage", ".git"].includes(name)) continue;
            const path = dir === "." ? name : join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else out.push(path);
         }
      };
      walk(".");
      return out;
   }
}
const files = listFiles();
const findings = [];
const report = (file, line, rule, msg) => findings.push(`${file}:${line}: [${rule}] ${msg}`);
/* A marker on the line or up to three lines above it. */
const markedNear = (lines, i, marker) =>
   lines.slice(Math.max(0, i - 3), i + 1).some((l) => l.includes(marker));
const norm = (hex) =>
   (hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex).toLowerCase();

/* --- the palette ------------------------------------------------------------------ */
const tokensSrc = readFileSync("src/design/tokens.ts", "utf8");
const paletteSrc = tokensSrc.slice(tokensSrc.indexOf("export const PALETTE"));
const palette = new Map();
for (const m of paletteSrc
   .slice(0, paletteSrc.indexOf("};"))
   .matchAll(/^\s*([a-zA-Z]+):\s*"(#[0-9a-fA-F]{3,8})"/gm)) {
   palette.set(
      m[1].replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
      norm(m[2])
   );
}

/* A hex color (3, 4, 6 or 8 digits, not part of a word or an entity like &#123;), or a color
   function. */
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/;
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;
/* CSS named colors (not transparent / currentColor / inherit, which aren't palette choices). */
const NAMED = new RegExp(
   "(?<![\\w-])(?:" +
      "aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|" +
      "burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|" +
      "darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|" +
      "darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|" +
      "deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|" +
      "ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|" +
      "lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|" +
      "lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|" +
      "lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|" +
      "mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|" +
      "mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|" +
      "olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|" +
      "papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|" +
      "saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|" +
      "snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|" +
      "yellowgreen)(?![\\w-])",
   "i"
);
/* Text with a literal color. `computedTail`: this text runs straight into a ${...}, so a color
   function at its very end is built from computed values (interpolated tokens), not a choice. */
function hasColor(text, computedTail) {
   if (HEX.test(text)) return true;
   for (const m of text.matchAll(COLOR_FN)) {
      if (!(computedTail && m.index + m[0].length === text.length)) return true;
   }
   return false;
}

/* --- TypeScript / JavaScript: walk the strings ------------------------------------- */
const DAWN_PATH = /^\/(?:api(?:\/|$)|js\/|ws\b|music-ws\b)/;
const DAWN_TAGGERS = new Set(["dawnUrl", "tagDawnUrl", "tagIfDawnApi"]);
const COLOR_EXEMPT = new Set([
   "src/design/tokens.ts", // the palette itself
   "src/ingest/email-sim.ts" // simulated hostile mail for offline development: the colors are the attack
]);
const URL_EXEMPT = new Set([
   "src/util/dawn-app.ts", // the tagging itself
   "src/ingest/email-sim.ts" // a link inside simulated mail, never fetched
]);
/* Is the node inside a dawnUrl()/tagDawnUrl()/tagIfDawnApi() call (within the same function)? */
function insideTagger(node) {
   for (let n = node.parent; n && !ts.isFunctionLike(n); n = n.parent) {
      if (ts.isCallExpression(n)) {
         const callee = n.expression;
         const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : "";
         if (DAWN_TAGGERS.has(name)) return true;
      }
   }
   return false;
}
for (const file of files) {
   if (!/^src\/.*\.(ts|js)$/.test(file) || file.endsWith(".test.ts")) continue;
   const text = readFileSync(file, "utf8");
   const lines = text.split("\n");
   const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS
   );
   const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
   const check = (node, piece, computedTail, startsPath) => {
      const i = lineOf(node);
      if (
         !COLOR_EXEMPT.has(file) &&
         hasColor(piece, computedTail) &&
         !markedNear(lines, i, "color-ok:")
      ) {
         report(
            file,
            i + 1,
            "colors",
            `color literal; use a token from src/design/tokens.ts: ${lines[i].trim()}`
         );
      }
      if (
         startsPath &&
         !URL_EXEMPT.has(file) &&
         DAWN_PATH.test(piece) &&
         !insideTagger(node) &&
         !markedNear(lines, i, "dawn-url-ok:")
      ) {
         report(file, i + 1, "dawn-urls", "a DAWN path not built inside dawnUrl()/tagDawnUrl()");
      }
   };
   const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
         check(node, node.text, false, true);
      } else if (ts.isTemplateExpression(node)) {
         check(node.head, node.head.text, true, true);
         node.templateSpans.forEach((span, k) => {
            const last = k === node.templateSpans.length - 1;
            check(span.literal, span.literal.text, !last, true);
         });
      }
      ts.forEachChild(node, visit);
   };
   visit(sf);
}

/* --- CSS: declaration by declaration ------------------------------------------------ */
/* Properties whose values are names, not colors, even when a name is spelled like one. */
const NAME_VALUED = new Set([
   "grid-area",
   "grid-template-areas",
   "grid-row",
   "grid-column",
   "animation",
   "animation-name",
   "font-family",
   "transition",
   "transition-property",
   "will-change",
   "counter-reset",
   "counter-increment",
   "list-style-type",
   "content",
   "view-transition-name",
   "container-name"
]);
const stripCss = (text) =>
   text
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .replace(/"[^"\n]*"|'[^'\n]*'/g, (q) => q.replace(/./g, " "))
      .replace(/url\([^)\n]*\)/g, (u) => u.replace(/./g, " "));
for (const file of files) {
   if (!/^src\/.*\.css$/.test(file)) continue;
   const raw = readFileSync(file, "utf8").split("\n");
   const lines = stripCss(raw.join("\n")).split("\n");
   let prop = ""; // the declaration a line belongs to ("" between declarations)
   lines.forEach((line, i) => {
      const whole = line.trim();
      /* A rule written on one line ("a { color: x; }"): its declarations follow the brace. */
      const t = whole.includes("{") ? whole.slice(whole.lastIndexOf("{") + 1).trim() : whole;
      const start = t.match(/^(--[\w-]+|[a-zA-Z-]+)\s*:(?!:)(.*)$/);
      let value = "";
      if (start && !/[{,]$/.test(t)) {
         prop = start[1].toLowerCase();
         value = start[2];
      } else if (prop) {
         value = t; // a wrapped value's continuation line
      }
      if (!prop) return;
      const isColor = hasColor(value, false) || (!NAME_VALUED.has(prop) && NAMED.test(value));
      if (/[;}]/.test(t) || /[{]$/.test(whole)) prop = "";
      if (!isColor || markedNear(raw, i, "color-ok:")) return;
      /* main.css :root pre-boot fallbacks: allowed when they match the token. */
      const mirror =
         file === "src/styles/main.css" && t.match(/^--([a-z-]+):\s*(#[0-9a-fA-F]{3,8});/);
      if (mirror) {
         const want = palette.get(mirror[1]);
         if (want && want === norm(mirror[2])) return;
         report(
            file,
            i + 1,
            "colors",
            `--${mirror[1]} fallback ${mirror[2]} doesn't match its token (${want ?? "no such token"})`
         );
         return;
      }
      report(
         file,
         i + 1,
         "colors",
         `color literal; use a token from src/design/tokens.ts: ${raw[i].trim()}`
      );
   });
}

/* index.html paints the ground before any script runs: it must match the token. */
readFileSync("index.html", "utf8")
   .split("\n")
   .forEach((line, i) => {
      const m = line.match(/^\s*background:\s*(#[0-9a-fA-F]{3,8})\s*;/);
      if (m && norm(m[1]) !== palette.get("ground")) {
         report(
            "index.html",
            i + 1,
            "colors",
            `pre-boot background ${m[1]} doesn't match the ground token (${palette.get("ground")})`
         );
      }
   });

/* --- em dashes ------------------------------------------------------------------------ */
for (const file of files) {
   if (
      !/\.(ts|js|mjs|css|html|md|yml|json|sh|hook|txt)$/.test(file) ||
      file === "package-lock.json"
   )
      continue;
   readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
         if (line.replaceAll('"—"', "").includes("—"))
            report(file, i + 1, "em-dashes", "an em dash in prose");
      });
}

if (findings.length) {
   console.error(findings.join("\n"));
   console.error(`\n${findings.length} source check finding(s).`);
   process.exit(1);
}
console.log("Source checks passed.");
