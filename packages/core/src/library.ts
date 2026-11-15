/**
 * The setup library's checks (see docs/SETUP_LIBRARY.md). Pure functions, shared by the
 * extension (to give instant errors before publishing) and the library server (which runs
 * them again on everything it stores). Nothing here touches the network or the app's state.
 *
 * A published setup is a share code rebuilt from checked settings, so it can only hold what
 * the `SF2-` format holds (rules, windows, earn goals, feed blockers, the warnings switch):
 * never usage, history, the password or browser details.
 */
import type { AccessWindow, EarnGoal, WebsiteRule } from "@shared/index";
import { siteDefinitions } from "@feeds/index";
import { checkSettings } from "./actions";
import { createDefaultState } from "./defaults";
import { expandDomainAliases, hostMatchesDomain } from "./domains";
import { BLOCKED_STEMS, BLOCKED_WORDS } from "./library-words";
import { SHARE_PREFIX, decodeShareCode, encodeShareCode, summarizeShared, type SharedSummary } from "./share";
import { defaultRules } from "./sites";

/**
 * The library's addresses, on the Cloudflare account's workers.dev subdomain. The extension
 * uses the test one until the library ships. Changing them needs an extension update.
 */
export const LIBRARY_URLS = {
  production: "https://screenfry-library.bhron-site.workers.dev",
  test: "https://screenfry-library-test.bhron-site.workers.dev",
} as const;

/** The longest code the library takes. Real setups are a few hundred characters. */
export const LIBRARY_MAX_CODE_LENGTH = 8_000;
/** The unpacked payload's cap (the app itself allows 1 MB for pasted codes). */
export const LIBRARY_MAX_JSON_BYTES = 64_000;
export const LIBRARY_LIMITS = {
  rules: 40,
  windows: 20,
  earnGoals: 20,
  titleMin: 3,
  title: 60,
  description: 280,
  tags: 4,
  reportNote: 280,
} as const;

/** Fixed, so tags need no moderation. Websites aren't tags: they come from the code. */
export const LIBRARY_TAGS = [
  "studying",
  "work",
  "deep-focus",
  "evenings",
  "weekends",
  "sleep",
  "detox",
  "gentle",
  "strict",
  "earn",
  "fry-time",
  "no-shorts",
] as const;
export type LibraryTag = (typeof LIBRARY_TAGS)[number];

export const REPORT_REASONS = ["offensive", "spam", "misleading", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** What someone sends to publish a setup. */
export interface PublishRequest {
  code: string;
  title: string;
  description?: string;
  tags?: string[];
}
/** A checked setup, ready to store: the code is the canonical one, rebuilt from its settings. */
export interface Publishable {
  code: string;
  title: string;
  description: string;
  tags: LibraryTag[];
  /** Site ids for the registry's websites ("youtube"), domains for any other website. */
  websites: string[];
  summary: SharedSummary;
}

const NOT_SF2 =
  "Only share codes that start with SF2- can be published. Copy the code from the Share page again.";

/** Control characters, zero-width characters and bidirectional overrides. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
/** Trimmed, invisible characters removed, runs of spaces made one. */
export function cleanText(text: unknown): string {
  return String(text ?? "")
    .replace(INVISIBLE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SWAPS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };
const blockedWords = new Set(BLOCKED_WORDS);
/** True when the text holds a blocked word (see library-words.ts). */
export function hasBlockedWord(text: string): boolean {
  const swapped = text.toLowerCase().replace(/[013457@$!]/g, (c) => SWAPS[c]);
  const words = swapped.split(/[^a-z]+/).filter(Boolean);
  // "s.h.i.t" and "f u c k": single letters in a row, read as one word.
  const joined: string[] = [];
  let run = "";
  for (const w of [...words, ""]) {
    if (w.length === 1) run += w;
    else {
      if (run.length > 2) joined.push(run);
      run = "";
    }
  }
  return [...words, ...joined].some(
    (w) => blockedWords.has(w) || BLOCKED_STEMS.some((stem) => w.startsWith(stem)),
  );
}
/** Links in a title or description (website names such as "x.com" are fine). */
const LINK = /https?:\/\/|www\./i;

const siteFor = (domain: string) =>
  siteDefinitions.find((site) =>
    expandDomainAliases(site.domains).some((sd) => hostMatchesDomain(domain, sd)),
  );
const websiteKey = (domain: string) => siteFor(domain)?.site ?? domain;

/**
 * The websites a setup changes: a rule that differs from a fresh install, a window or earn
 * goal naming the website, or a feed blocker on. Site ids for the registry's websites.
 */
export function setupWebsites(settings: {
  rules: WebsiteRule[];
  windows: AccessWindow[];
  earnGoals?: EarnGoal[];
  feedSettings: { sites: Record<string, Record<string, boolean>> };
}): string[] {
  const fresh = defaultRules();
  const keys = new Set<string>();
  for (const rule of settings.rules) {
    const isDefault = fresh.some((d) => d.domains.join() === rule.domains.join());
    const changed = rule.blocked || rule.showTimer || !rule.enabled || Boolean(rule.dailyAllowance);
    if (!isDefault || changed) rule.domains.forEach((d) => keys.add(websiteKey(d)));
  }
  for (const w of settings.windows) w.domains.forEach((d) => keys.add(websiteKey(d)));
  for (const g of settings.earnGoals ?? [])
    [...g.goalDomains, ...g.lockedDomains].forEach((d) => keys.add(websiteKey(d)));
  for (const [site, elements] of Object.entries(settings.feedSettings.sites))
    if (Object.values(elements ?? {}).some((on) => on === true)) keys.add(site);
  // Registry websites first, in the registry's order, then other websites alphabetically.
  const order = siteDefinitions.map((s) => s.site as string);
  return [...keys].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
}
/** Websites a setup names that aren't in the site registry (they become public on publishing). */
export const customWebsites = (websites: string[]) =>
  websites.filter((w) => !siteDefinitions.some((s) => s.site === w));

let freshCode: Promise<string> | undefined;
/** A fresh install's code ("SF2-je30"): a setup equal to it changes nothing. */
const freshInstallCode = () =>
  (freshCode ??= (() => {
    const s = createDefaultState();
    return encodeShareCode({
      rules: s.rules,
      windows: s.windows,
      earnGoals: s.earnGoals ?? [],
      feedSettings: s.feedSettings,
      warningsEnabled: s.warningsEnabled,
    });
  })());

/**
 * Checks a code for the library and rebuilds it: only real `SF2-` codes, within the size and
 * count limits, passing the same checks as a pasted code, changing something, and without
 * blocked words in any name. Returns the canonical code, the websites and a summary.
 */
export async function checkLibraryCode(
  input: unknown,
): Promise<{ code?: string; websites?: string[]; summary?: SharedSummary; error?: string }> {
  const text = String(input ?? "").replace(/\s+/g, "");
  if (!text.toUpperCase().startsWith(SHARE_PREFIX)) return { error: NOT_SF2 };
  if (text.length > LIBRARY_MAX_CODE_LENGTH)
    return { error: "This setup is too big to publish. Remove some windows or goals and try again." };
  let data: unknown;
  try {
    data = await decodeShareCode(text, LIBRARY_MAX_JSON_BYTES);
  } catch (error) {
    return { error: error instanceof Error ? error.message : NOT_SF2 };
  }
  const { settings, error } = checkSettings(data, 0);
  if (!settings) return { error };
  const custom = settings.rules.filter((r) => !defaultRules().some((d) => d.domains.join() === r.domains.join()));
  if (
    custom.length > LIBRARY_LIMITS.rules - siteDefinitions.length ||
    settings.windows.length > LIBRARY_LIMITS.windows ||
    (settings.earnGoals?.length ?? 0) > LIBRARY_LIMITS.earnGoals
  )
    return {
      error: `A published setup can have up to ${LIBRARY_LIMITS.windows} windows, ${LIBRARY_LIMITS.earnGoals} earn goals and ${LIBRARY_LIMITS.rules - siteDefinitions.length} added websites.`,
    };
  // Names lose invisible characters (such as right-to-left overrides) before they go public.
  const shareable = {
    rules: settings.rules.map((r) => ({ ...r, label: cleanText(r.label) })),
    windows: settings.windows.map((w) => ({ ...w, label: cleanText(w.label) })),
    earnGoals: (settings.earnGoals ?? []).map((g) => ({ ...g, label: cleanText(g.label) })),
    feedSettings: settings.feedSettings,
    warningsEnabled: settings.warningsEnabled ?? true,
  };
  const code = await encodeShareCode(shareable);
  if (code === (await freshInstallCode()))
    return { error: "This setup doesn’t change anything yet. Turn something on, then publish it." };
  const websites = setupWebsites(shareable);
  const names = [
    ...shareable.windows.map((w) => w.label),
    ...shareable.earnGoals.map((g) => g.label),
    ...customWebsites(websites),
    ...custom.map((r) => r.label),
  ];
  if (names.some((n) => hasBlockedWord(n)))
    return { error: "A window, goal or website name in this setup has a word the library doesn’t allow. Rename it, then publish." };
  return { code, websites, summary: summarizeShared(shareable) };
}

/** Checks everything someone sends to publish a setup. */
export async function checkPublishable(input: unknown): Promise<{ setup?: Publishable; error?: string }> {
  const req = (input ?? {}) as Partial<PublishRequest>;
  const title = cleanText(req.title);
  const description = cleanText(req.description);
  if (title.length < LIBRARY_LIMITS.titleMin || title.length > LIBRARY_LIMITS.title)
    return { error: `Give the setup a title of ${LIBRARY_LIMITS.titleMin} to ${LIBRARY_LIMITS.title} characters.` };
  if (description.length > LIBRARY_LIMITS.description)
    return { error: `Keep the description to ${LIBRARY_LIMITS.description} characters.` };
  if (hasBlockedWord(title) || hasBlockedWord(description))
    return { error: "The title or description has a word the library doesn’t allow." };
  if (LINK.test(title) || LINK.test(description))
    return { error: "Titles and descriptions can’t have links." };
  if (req.tags !== undefined && !Array.isArray(req.tags)) return { error: "Choose tags from the list." };
  const tags = [...new Set(req.tags ?? [])];
  if (tags.some((t) => !(LIBRARY_TAGS as readonly string[]).includes(t)))
    return { error: "Choose tags from the list." };
  if (tags.length > LIBRARY_LIMITS.tags) return { error: `Choose up to ${LIBRARY_LIMITS.tags} tags.` };
  const checked = await checkLibraryCode(req.code);
  if (!checked.code) return { error: checked.error };
  return {
    setup: {
      code: checked.code,
      title,
      description,
      tags: tags as LibraryTag[],
      websites: checked.websites!,
      summary: checked.summary!,
    },
  };
}

/**
 * Signed requests: the install's P-256 key signs this text (see docs/SETUP_LIBRARY.md). The
 * extension and the server build it the same way. `path` is the URL path, without the query.
 */
export const LIBRARY_SIGNING_VERSION = "v1";
export const LIBRARY_MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const librarySigningText = (method: string, path: string, time: number | string, bodyHashHex: string) =>
  [LIBRARY_SIGNING_VERSION, method.toUpperCase(), path, String(time), bodyHashHex].join("\n");
/** SHA-256 of a request body, as hex (the empty body's hash for requests without one). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
