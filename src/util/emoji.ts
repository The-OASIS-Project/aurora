/*
 * Emoji shortcodes. A curated map of the common `:name:` codes to their glyph,
 * plus the expansion + search the composer picker and the reply renderer use.
 *
 * No dependency by design (the project stays lean): this is the ~150 codes a
 * chat with DAWN actually reaches for, not the full Unicode set. An unknown
 * `:name:` is left as literal text, so ratios/times (`12:30:45`) and URLs
 * (`http://`) never expand by accident - only a name that is actually in the
 * table is replaced. Add codes here as they are missed; that is the whole
 * maintenance surface.
 */

export const EMOJI: Record<string, string> = {
   /* faces + people */
   smile: "😄",
   grin: "😁",
   laughing: "😆",
   joy: "😂",
   rofl: "🤣",
   slight_smile: "🙂",
   wink: "😉",
   blush: "😊",
   sunglasses: "😎",
   heart_eyes: "😍",
   thinking: "🤔",
   neutral_face: "😐",
   expressionless: "😑",
   unamused: "😒",
   roll_eyes: "🙄",
   smirk: "😏",
   pensive: "😔",
   confused: "😕",
   worried: "😟",
   cry: "😢",
   sob: "😭",
   weary: "😩",
   tired_face: "😫",
   fearful: "😨",
   scream: "😱",
   flushed: "😳",
   sweat_smile: "😅",
   yum: "😋",
   stuck_out_tongue: "😛",
   wink_tongue: "😜",
   zany: "🤪",
   upside_down: "🙃",
   money_mouth: "🤑",
   nerd: "🤓",
   shush: "🤫",
   hugging: "🤗",
   sleeping: "😴",
   mask: "😷",
   angry: "😠",
   rage: "😡",
   exploding_head: "🤯",
   cowboy: "🤠",
   partying: "🥳",
   pleading: "🥺",
   robot: "🤖",
   ghost: "👻",
   alien: "👽",
   skull: "💀",
   clown: "🤡",
   poop: "💩",

   /* gestures + hands */
   wave: "👋",
   raised_hand: "✋",
   ok_hand: "👌",
   pinch: "🤏",
   v: "✌️",
   crossed_fingers: "🤞",
   thumbsup: "👍",
   "+1": "👍",
   thumbsdown: "👎",
   "-1": "👎",
   fist: "✊",
   punch: "👊",
   clap: "👏",
   raised_hands: "🙌",
   pray: "🙏",
   handshake: "🤝",
   muscle: "💪",
   point_up: "☝️",
   point_down: "👇",
   point_left: "👈",
   point_right: "👉",
   writing_hand: "✍️",
   selfie: "🤳",

   /* hearts + symbols */
   heart: "❤️",
   orange_heart: "🧡",
   yellow_heart: "💛",
   green_heart: "💚",
   blue_heart: "💙",
   purple_heart: "💜",
   black_heart: "🖤",
   broken_heart: "💔",
   sparkling_heart: "💖",
   two_hearts: "💕",
   check: "✅",
   white_check_mark: "✅",
   heavy_check_mark: "✔️",
   x: "❌",
   cross_mark: "❌",
   warning: "⚠️",
   no_entry: "⛔",
   question: "❓",
   exclamation: "❗",
   bangbang: "‼️",
   100: "💯",
   sparkles: "✨",
   star: "⭐",
   star2: "🌟",
   dizzy: "💫",
   boom: "💥",
   fire: "🔥",
   zap: "⚡",
   bulb: "💡",
   bell: "🔔",
   lock: "🔒",
   unlock: "🔓",
   key: "🔑",
   mag: "🔍",
   gear: "⚙️",
   wrench: "🔧",
   hammer: "🔨",
   link: "🔗",
   paperclip: "📎",
   pushpin: "📌",
   round_pushpin: "📍",
   recycle: "♻️",
   infinity: "♾️",
   heavy_plus_sign: "➕",
   heavy_minus_sign: "➖",

   /* activity + celebration */
   tada: "🎉",
   confetti_ball: "🎊",
   balloon: "🎈",
   gift: "🎁",
   trophy: "🏆",
   medal: "🏅",
   dart: "🎯",
   rocket: "🚀",
   crown: "👑",
   gem: "💎",

   /* objects + tech */
   computer: "💻",
   desktop: "🖥️",
   keyboard: "⌨️",
   phone: "📱",
   battery: "🔋",
   electric_plug: "🔌",
   satellite: "🛰️",
   camera: "📷",
   headphones: "🎧",
   microphone: "🎤",
   speaker: "🔊",
   mute: "🔇",
   tv: "📺",
   floppy_disk: "💾",
   cd: "💿",
   printer: "🖨️",
   email: "📧",
   envelope: "✉️",
   package: "📦",
   memo: "📝",
   pencil: "✏️",
   book: "📖",
   books: "📚",
   clipboard: "📋",
   calendar: "📅",
   chart: "📈",
   chart_down: "📉",
   bar_chart: "📊",
   moneybag: "💰",
   dollar: "💵",
   hourglass: "⏳",
   watch: "⌚",
   alarm_clock: "⏰",
   stopwatch: "⏱️",

   /* nature + weather */
   sun: "☀️",
   cloud: "☁️",
   rain: "🌧️",
   snowflake: "❄️",
   snowman: "⛄",
   umbrella: "☔",
   rainbow: "🌈",
   ocean: "🌊",
   moon: "🌙",
   earth: "🌍",
   comet: "☄️",
   seedling: "🌱",
   herb: "🌿",
   four_leaf_clover: "🍀",
   maple_leaf: "🍁",
   cactus: "🌵",
   evergreen_tree: "🌲",
   sunflower: "🌻",
   rose: "🌹",
   dog: "🐶",
   cat: "🐱",
   fox: "🦊",
   bug: "🐛",
   butterfly: "🦋",
   snake: "🐍",
   dragon: "🐉",
   unicorn: "🦄",

   /* food + drink */
   coffee: "☕",
   tea: "🍵",
   beer: "🍺",
   wine: "🍷",
   pizza: "🍕",
   hamburger: "🍔",
   fries: "🍟",
   taco: "🌮",
   cake: "🍰",
   birthday: "🎂",
   cookie: "🍪",
   doughnut: "🍩",
   apple: "🍎",
   banana: "🍌",
   hot_pepper: "🌶️",
   popcorn: "🍿",

   /* travel + misc */
   car: "🚗",
   airplane: "✈️",
   ship: "🚢",
   anchor: "⚓",
   house: "🏠",
   office: "🏢",
   construction: "🚧",
   traffic_light: "🚦",
   flag: "🚩",
   checkered_flag: "🏁",
   eyes: "👀",
   brain: "🧠",
   footprints: "👣",
   zzz: "💤",
   speech_balloon: "💬",
   thought_balloon: "💭"
};

/* One colon-delimited run; the replacer keeps unknown names verbatim. Names use
   the same charset the picker accepts. */
const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

/* Replace every KNOWN `:name:` with its glyph; anything else is returned as-is.
   Used on the user's submitted text and on assistant reply text tokens. */
export function emojify(text: string): string {
   if (text.indexOf(":") === -1) return text; // fast path: nothing to do
   return text.replace(SHORTCODE_RE, (whole, name: string) => {
      const glyph = EMOJI[name.toLowerCase()];
      return glyph ?? whole;
   });
}

export interface EmojiHit {
   name: string;
   char: string;
}

/* Prefix-then-substring match on shortcode names, for the composer picker.
   Aliases that resolve to the same glyph as a shorter name are dropped so the
   list does not show `thumbsup` and `+1` as two rows for one emoji. */
export function searchEmoji(query: string, limit = 8): EmojiHit[] {
   const q = query.toLowerCase();
   const prefix: EmojiHit[] = [];
   const substr: EmojiHit[] = [];
   const seenChar = new Set<string>();
   for (const name of Object.keys(EMOJI)) {
      const idx = name.indexOf(q);
      if (idx === -1) continue;
      const char = EMOJI[name];
      if (seenChar.has(char)) continue; // one row per glyph
      seenChar.add(char);
      (idx === 0 ? prefix : substr).push({ name, char });
   }
   return prefix.concat(substr).slice(0, limit);
}
