/**
 * Words the setup library refuses in published text (titles, descriptions, window and goal
 * names, custom websites). Lowercase, matched as whole words after common letter swaps
 * (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s), so "sh1t" and "s.h.i.t" are caught but "Scunthorpe"
 * and "assessment" aren't. Edit this list in a pull request; the extension and the server both
 * use it, so a change takes effect for publishing once both are updated.
 *
 * `STEMS` also match as the start of a longer word ("fucking", "shitty").
 */
export const BLOCKED_WORDS = [
  "anal", "anus", "arse", "arsehole", "ass", "asshole", "bastard", "bitch", "bollocks", "boner",
  "boob", "boobs", "cock", "coon", "cum", "cunt", "dick", "dildo", "dyke", "fag", "faggot",
  "gook", "handjob", "hitler", "jizz", "kike", "milf", "nazi", "negro", "nigga", "nigger",
  "nude", "nudes", "orgasm", "paki", "penis", "porn", "porno", "pussy", "rape", "raping",
  "rapist", "retard", "retarded", "sex", "sexy", "slut", "spic", "tits", "titty", "tranny",
  "twat", "vagina", "wank", "wanker", "whore",
];
export const BLOCKED_STEMS = ["fuck", "shit", "motherfuck", "nigg", "cunt", "whore", "porn"];
