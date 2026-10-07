/*
 * User settings that follow the person (docs/EMAIL_PANEL_DESIGN.md 8.7), Aurora-wide.
 *
 * Ingest stores RAW JSON per key and knows nothing about what a key means: each view owns its typed
 * definitions (PrefDef: key, default, parse) and every read runs the view's parse, falling back to
 * the default for a missing or malformed value (another client or version may have written it).
 *
 * LocalUserPrefs keeps the values in this browser (one map in `dawn.hero.prefs`, in USER_KEYS, so
 * logout and a user switch wipe it) and follows other tabs through the `storage` event. It is the
 * whole store against a DAWN without the settings store (a permanent path for older daemons), and
 * the cache under a DAWN-backed source once DAWN has one (9.14).
 */

export const PREFS_KEY = "dawn.hero.prefs";

export interface PrefDef<T> {
   key: string;
   default: T;
   /* The value from untrusted raw JSON, or undefined when it isn't valid. */
   parse(raw: unknown): T | undefined;
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/* A view's setting. The key is namespaced by view, lowercase (`mail.mark_read`). */
export function definePref<T>(d: PrefDef<T>): PrefDef<T> {
   if (!KEY_RE.test(d.key) || !d.key.includes(".")) throw new Error(`bad pref key: ${d.key}`);
   return d;
}

export interface UserPrefs {
   get<T>(def: PrefDef<T>): T;
   set<T>(def: PrefDef<T>, value: T): void;
   /* Change a value as an operation on the CURRENT one (an add or remove on a list). A DAWN-backed
      source re-applies it to the fresh value on a conflict, so another device's stale write can't
      undo it (9.14 compare-and-set). */
   update<T>(def: PrefDef<T>, fn: (current: T) => T): void;
   /* Called with the keys that changed (here, in another tab, or from DAWN). */
   onChange(cb: (keys: string[]) => void): () => void;
   /* Whether these settings are DAWN-backed and loaded for this connection (copy only). */
   synced(): boolean;
   /* Whether this connection's values have loaded (privacy-sensitive settings stay strict until). */
   loaded(): boolean;
   dispose(): void;
}

type Raw = Record<string, unknown>;

interface Stored {
   v: 1;
   values: Raw;
   authority: "local" | "dawn";
   dirty: string[];
}

/* A null-prototype copy, so a key like "constructor" can't resolve to an Object.prototype member. */
function clean(o: unknown): Raw {
   const out: Raw = Object.create(null) as Raw;
   if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (KEY_RE.test(k)) out[k] = v;
   }
   return out;
}

export class LocalUserPrefs implements UserPrefs {
   private stored: Stored;
   private readonly listeners = new Set<(keys: string[]) => void>();
   private readonly onStorage = (e: StorageEvent): void => {
      if (e.key === PREFS_KEY) this.refresh();
   };

   constructor() {
      this.stored = LocalUserPrefs.read();
      window.addEventListener("storage", this.onStorage);
   }

   private static read(): Stored {
      try {
         const raw = localStorage.getItem(PREFS_KEY);
         if (raw) {
            const p = JSON.parse(raw) as Partial<Stored>;
            return {
               v: 1,
               values: clean(p.values),
               authority: p.authority === "dawn" ? "dawn" : "local",
               dirty: Array.isArray(p.dirty) ? p.dirty.filter((k): k is string => typeof k === "string" && KEY_RE.test(k)) : []
            };
         }
      } catch {
         /* blocked or corrupt: start empty */
      }
      return { v: 1, values: clean(null), authority: "local", dirty: [] };
   }

   private write(): void {
      try {
         localStorage.setItem(PREFS_KEY, JSON.stringify(this.stored));
      } catch {
         /* blocked: this tab keeps the values in memory */
      }
   }

   private emit(keys: string[]): void {
      for (const cb of this.listeners) cb(keys);
   }

   get<T>(def: PrefDef<T>): T {
      if (!Object.hasOwn(this.stored.values, def.key)) return def.default;
      return def.parse(this.stored.values[def.key]) ?? def.default;
   }

   set<T>(def: PrefDef<T>, value: T): void {
      this.setRaw(def.key, value);
   }

   update<T>(def: PrefDef<T>, fn: (current: T) => T): void {
      this.refresh(); // apply the operation to what's stored NOW (another tab may have just written)
      this.setRaw(def.key, fn(this.get(def)));
   }

   /* Raw access for a DAWN-backed source wrapping this one as its cache (9.14). */
   setRaw(key: string, value: unknown, notify = true): void {
      if (!KEY_RE.test(key)) return;
      this.refresh(); // merge into the stored map, never overwrite another tab's newer keys
      if (JSON.stringify(this.stored.values[key]) === JSON.stringify(value)) return;
      this.stored.values[key] = value;
      this.write();
      if (notify) this.emit([key]);
   }

   /* Re-read the stored map; tell listeners about keys another tab changed that this tab hadn't
      seen yet (its storage event may not have arrived). */
   private refresh(): void {
      const before = this.stored.values;
      this.stored = LocalUserPrefs.read();
      const changed: string[] = [];
      for (const k of new Set([...Object.keys(before), ...Object.keys(this.stored.values)])) {
         if (JSON.stringify(before[k]) !== JSON.stringify(this.stored.values[k])) changed.push(k);
      }
      if (changed.length) this.emit(changed);
   }

   onChange(cb: (keys: string[]) => void): () => void {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
   }

   synced(): boolean {
      return false;
   }

   /* The browser is the whole store here, so its values are loaded from the start. */
   loaded(): boolean {
      return true;
   }

   dispose(): void {
      window.removeEventListener("storage", this.onStorage);
      this.listeners.clear();
   }
}
