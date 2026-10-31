// ESLint: the static checks strict TypeScript doesn't make (Aurora's counterpart to DAWN's
// clang-tidy). Type-aware typescript-eslint rules, and Mozilla's no-unsanitized, which flags any
// value reaching an HTML sink (innerHTML, insertAdjacentHTML, document.write, ...) that isn't a
// plain literal: text from DAWN, a mail or a web page reaches the page as text, never as markup.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import globals from "globals";

/* renderMarkdown is the one sanitizing renderer (marked, then DOMPurify): its output is safe HTML. */
const sanitizers = { escape: { methods: ["renderMarkdown"] } };

/* --- The architecture (ARCHITECTURE.md): ingest -> state -> choreography -> render -------------
   One block per layer, each with its COMPLETE rule set: in flat config a later block that sets a
   rule replaces an earlier block's options for that rule, so the shared parts below are spread into
   every block rather than set once. The import patterns match the import string, which assumes the
   layers stay one directory deep (true today); a layer that grows subdirectories needs a resolver-
   based rule (eslint-plugin-boundaries or import-x/no-restricted-paths). */
const SPINE = "ARCHITECTURE.md";
const THREE_ONLY_IN_ANCHOR = {
   paths: [{ name: "three", message: "Three.js lives only in src/anchor/." }],
   patterns: [{ group: ["three/*"], message: "Three.js lives only in src/anchor/." }]
};
/* Only the composition root (main.ts) picks the concrete client; everything else uses the Ingest
   contract (src/ingest/ingest.ts). */
const NO_CONCRETE_INGEST = {
   group: ["../ingest/dawn-ws*", "../ingest/stub*"],
   message:
      "Use the Ingest contract (ingest/ingest.ts); only main.ts picks DawnIngest or StubIngest."
};
/* One DAWN boundary: nothing outside the ingest opens a request or a socket. */
const NET = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"];
const NET_GLOBALS = NET.map((name) => ({
   name,
   message: "Requests and sockets to DAWN go through the ingest (src/ingest/)."
}));
const NET_PROPERTIES = [
   ...["window", "globalThis", "self", "top", "parent", "frames"].flatMap((object) =>
      NET.map((property) => ({
         object,
         property,
         message: "Requests and sockets to DAWN go through the ingest (src/ingest/)."
      }))
   ),
   { object: "navigator", property: "sendBeacon", message: "Requests go through the ingest." }
];
/* State and choreography are pure logic: no browser at all (the composition root reads the
   browser and passes values in, as it does the reduced-motion preference). Every browser global
   that isn't plain JavaScript is refused, so a new browser API can't slip in; console stays. */
const ES = new Set(Object.keys(globals.es2021));
const BROWSER = Object.keys(globals.browser)
   .filter((name) => !ES.has(name) && name !== "console")
   .map((name) => ({ name, message: `Pure logic layer: no browser access (${SPINE}).` }));

/* A dynamic import() isn't seen by no-restricted-imports: the same bans, as syntax. */
const DYNAMIC_THREE = {
   selector: "ImportExpression[source.value=/^three(\\/|$)/]",
   message: "Three.js lives only in src/anchor/."
};
const DYNAMIC_CONCRETE = {
   selector: "ImportExpression[source.value=/ingest\\/(dawn-ws|stub)/]",
   message: "Use the Ingest contract; only main.ts picks DawnIngest or StubIngest."
};

/* `client`: may pick the concrete DAWN client (main.ts only). */
const layer = (
   files,
   { imports = [], three = true, net = true, browser = false, client = false }
) => ({
   files,
   ignores: ["**/*.test.ts"],
   rules: {
      "@typescript-eslint/no-restricted-imports": [
         "error",
         {
            paths: three ? THREE_ONLY_IN_ANCHOR.paths : [],
            patterns: [...(three ? THREE_ONLY_IN_ANCHOR.patterns : []), ...imports]
         }
      ],
      "no-restricted-globals": ["error", ...(net ? NET_GLOBALS : []), ...(browser ? BROWSER : [])],
      "no-restricted-properties": ["error", ...(net ? NET_PROPERTIES : [])],
      "no-restricted-syntax": [
         "error",
         ...(three ? [DYNAMIC_THREE] : []),
         ...(client ? [] : [DYNAMIC_CONCRETE])
      ]
   }
});
const LAYER_DIRS = ["anchor", "state", "choreography", "ingest", "render", "util"];

export default tseslint.config(
   { ignores: ["dist/", "node_modules/", "coverage/"] },
   js.configs.recommended,
   ...tseslint.configs.recommendedTypeChecked,
   {
      plugins: { "no-unsanitized": noUnsanitized },
      rules: {
         "no-unsanitized/method": ["error", sanitizers],
         /* srcdoc is an HTML sink too (a frame's whole document). */
         "no-unsanitized/property": ["error", sanitizers, { srcdoc: {} }]
      }
   },
   {
      languageOptions: {
         globals: { ...globals.browser },
         parserOptions: {
            /* The config files are typed by tsconfig.node.json (Node, not the browser). */
            projectService: {
               allowDefaultProject: ["*.config.ts", "eslint.config.js"],
               defaultProject: "tsconfig.node.json"
            },
            tsconfigRootDir: import.meta.dirname
         }
      },
      rules: {
         /* An intentionally unused name says so with a leading underscore (as tsconfig allows). */
         "@typescript-eslint/no-unused-vars": [
            "error",
            { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
         ]
      }
   },
   /* --- The layers (see the constants above) ------------------------------------------------ */
   // The center reactor: the one place Three.js lives.
   layer(["src/anchor/**/*.ts"], {
      three: false,
      imports: [
         {
            regex: "^(?:\\./)*\\.\\./(?!anchor/|design/|util/)",
            allowTypeImports: true,
            message: "The anchor depends only on design and util (and Three.js)."
         }
      ]
   }),
   // State is pure data: depends on nothing above it.
   layer(["src/state/**/*.ts"], {
      browser: true,
      imports: [
         {
            regex: "^(?:\\./)*\\.\\./(?!state/|util/|design/)",
            message: "src/state depends on nothing above it."
         }
      ]
   }),
   // Choreography turns state into RenderNodes: it may name the seam's types, never touch pixels.
   layer(["src/choreography/**/*.ts"], {
      browser: true,
      imports: [
         {
            regex: "^(?:\\./)*\\.\\./render/",
            allowTypeImports: true,
            message: "Choreography may only use the seam's types (RenderNode), not render code."
         },
         {
            regex: "^(?:\\./)*\\.\\./(?!render/|state/|design/|util/|choreography/)",
            message: "Choreography depends only on state (and the seam's types)."
         }
      ]
   }),
   // The ingest is the DAWN boundary (net allowed) and feeds the view only through its sinks: it
   // value-imports only the audio pipeline it drives, state, the model rules, design and util.
   layer(["src/ingest/**/*.ts"], {
      net: false,
      imports: [
         {
            regex: "^(?:\\./)*\\.\\./(?!ingest/|state/|util/|design/|audio/|model/)",
            allowTypeImports: true,
            message:
               "The ingest reaches the view through its sinks; only types may come from view code."
         }
      ]
   }),
   // Render knows pixels; it decides no importance or timing, so it uses state only as types.
   layer(["src/render/**/*.ts"], {
      imports: [
         {
            regex: "^(?:\\./)*\\.\\./(?!render/|design/|util/)",
            allowTypeImports: true,
            message:
               "Render depends only on design and util (types from the layers above it are fine)."
         }
      ]
   }),
   // Shared helpers: no view or ingest code.
   layer(["src/util/**/*.ts"], {
      imports: [
         {
            regex: "^(?:\\./)*\\.\\./(?!util/|design/)",
            allowTypeImports: true,
            message:
               "util holds shared helpers: it depends only on design (types from elsewhere are fine)."
         }
      ]
   }),
   // The views.
   {
      ...layer(["src/**/*.ts"], { imports: [NO_CONCRETE_INGEST] }),
      ignores: ["**/*.test.ts", "src/main.ts", ...LAYER_DIRS.map((d) => `src/${d}/**`)]
   },
   // The composition root: the one file that picks DawnIngest or StubIngest.
   layer(["src/main.ts"], { client: true }),
   {
      // Tests reach into private members on purpose (through `any`), to drive one piece of the
      // client directly: the unsafe-any rules would flag every such line.
      files: ["**/*.test.ts"],
      rules: {
         "@typescript-eslint/no-explicit-any": "off",
         "@typescript-eslint/no-unsafe-assignment": "off",
         "@typescript-eslint/no-unsafe-member-access": "off",
         "@typescript-eslint/no-unsafe-call": "off",
         "@typescript-eslint/no-unsafe-argument": "off",
         "@typescript-eslint/no-unsafe-return": "off",
         "@typescript-eslint/unbound-method": "off",
         "@typescript-eslint/require-await": "off" // async mock implementations read naturally
      }
   },
   {
      // Node scripts (the source checks).
      files: ["scripts/**/*.mjs"],
      languageOptions: { globals: { ...globals.node } }
   },
   {
      // The audio worklets run in the AudioWorkletGlobalScope, not a window.
      files: ["public/worklets/**/*.js"],
      languageOptions: { globals: { ...globals.audioWorklet } }
   },
   {
      // Plain JavaScript (the worklets, this file): no type information.
      files: ["**/*.js", "**/*.mjs"],
      ...tseslint.configs.disableTypeChecked
   }
);
