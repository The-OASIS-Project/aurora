/*
 * Reading DAWN's frames. A frame's fields arrive as `unknown`: DAWN's shapes have had gaps, and a
 * field can be missing, null, or (a server bug) the wrong type. `String(value)` would turn an object
 * into the text "[object Object]" and show it; these say what a field is or fall back.
 */

/* A text field: a string as-is, a number or boolean as its text, anything else the fallback. */
export function str(value: unknown, fallback = ""): string {
   if (typeof value === "string") return value;
   if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
      return String(value);
   return fallback;
}
