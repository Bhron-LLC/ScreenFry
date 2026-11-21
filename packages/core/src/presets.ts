import { siteDefinitions } from "@feeds/index";
import { LOADOUT_COUNT, type AccessWindow, type AppState, type DayOfWeek } from "@shared/index";
import {
  copyToLoadout,
  loadoutSettings,
  markPresetsOffered,
  setLoadoutFromCode,
  type ActionContext,
  type ActionResult,
  type SettingsExport,
} from "./actions";
import { createDefaultState } from "./defaults";
import { encodeShareCode } from "./share";

/** A ready-made setup: offered the first time the settings page opens, and from Websites. */
export interface Preset {
  id: "popular" | "strict" | "chill" | "short-free";
  name: string;
  summary: string;
  /** What it does, in a few short lines. */
  points: string[];
  /** The setup, in the shape a share code holds (applied the same way as a pasted code). */
  settings(): Pick<SettingsExport, "rules" | "windows" | "earnGoals" | "feedSettings" | "warningsEnabled">;
}

const EVERY_DAY: DayOfWeek[] = [0, 1, 2, 3, 4, 5, 6];

/** A fresh install's setup, to build each preset on. */
function base() {
  const { rules, feedSettings, warningsEnabled } = createDefaultState();
  return { rules, windows: [] as AccessWindow[], earnGoals: [], feedSettings, warningsEnabled };
}

/** Turns on every feed, and blocks Shorts, Reels and video feeds entirely, on every website. */
function hideFeedsAndShorts(feedSettings: ReturnType<typeof base>["feedSettings"]) {
  for (const site of siteDefinitions) {
    const on = feedSettings.sites[site.site];
    for (const [key, element] of Object.entries(site.elements))
      if (element.group === "Feeds" && !element.requires) on[key] = true;
    if (site.shortForm) on[site.shortForm.setting] = true;
  }
}

/** TikTok is short videos all the way through, so "no Shorts" blocks it. */
const SHORT_VIDEO_ONLY = new Set(["tiktok"]);

export const PRESETS: Preset[] = [
  {
    id: "popular",
    name: "Most popular",
    summary: "No feeds or Shorts, with an evening break.",
    points: [
      "Every feed hidden and Shorts, Reels and video feeds blocked, on every website.",
      "Fry Time from 6 pm to midnight: feeds come back for 30 minutes a day on each website.",
      "Search, links, profiles and messages keep working.",
    ],
    settings() {
      const setup = base();
      hideFeedsAndShorts(setup.feedSettings);
      setup.windows = [
        {
          id: "preset-evening-fry-time",
          label: "Evening Fry Time",
          enabled: true,
          domains: siteDefinitions.map((s) => s.domains[0]),
          days: EVERY_DAY,
          startMinute: 18 * 60,
          endMinute: 24 * 60,
          mode: "free",
          freeMinutes: 30,
        },
      ];
      return setup;
    },
  },
  {
    id: "strict",
    name: "Strict mode",
    summary: "Every website blocked.",
    points: [
      "YouTube, Instagram, X, Reddit, Substack, TikTok, Facebook, LinkedIn and Quora are blocked all day.",
      "Turn one back on from its page whenever you need it.",
    ],
    settings() {
      const setup = base();
      setup.rules = setup.rules.map((r) => ({ ...r, blocked: true }));
      return setup;
    },
  },
  {
    id: "chill",
    name: "Chill mode",
    summary: "One hour a day on each website.",
    points: [
      "A 1-hour daily limit on every website, reset at midnight.",
      "Feeds stay as they are; change any website's controls later.",
    ],
    settings() {
      const setup = base();
      setup.rules = setup.rules.map((r) => ({ ...r, dailyAllowance: { defaultMinutes: 60 } }));
      return setup;
    },
  },
  {
    id: "short-free",
    name: "Short-free",
    summary: "No Shorts, Reels or video feeds.",
    points: [
      "Shorts, Reels and endless video feeds blocked on every website, even from links.",
      "TikTok is blocked, since it's all short videos.",
      "Everything else stays as it is.",
    ],
    settings() {
      const setup = base();
      for (const site of siteDefinitions)
        if (site.shortForm) setup.feedSettings.sites[site.site][site.shortForm.setting] = true;
      setup.rules = setup.rules.map((r) => (SHORT_VIDEO_ONLY.has(r.id) ? { ...r, blocked: true } : r));
      return setup;
    },
  },
];

export const presetById = (id: unknown): Preset | undefined => PRESETS.find((p) => p.id === id);

/**
 * Before a preset replaces the setup in use: whether that setup has anything in it (a fresh
 * install's doesn't), and the empty loadout it can be saved in first, if there is one.
 */
export async function presetBackup(state: AppState, now: number): Promise<{ changed: boolean; empty?: number }> {
  const setupOf = (s: AppState) => {
    const { rules, windows, earnGoals, feedSettings } = loadoutSettings(s, s.activeLoadout ?? 0, now)!;
    return { rules, windows, earnGoals, feedSettings, warningsEnabled: s.warningsEnabled };
  };
  const changed = (await encodeShareCode(setupOf(state))) !== (await encodeShareCode(setupOf(createDefaultState())));
  const active = state.activeLoadout ?? 0;
  const empty = Array.from({ length: LOADOUT_COUNT }, (_, i) => i).find((i) => i !== active && !state.loadouts?.[i]);
  return { changed, empty };
}

/**
 * Uses a preset as the live setup, as the Mac app asks: the current setup goes into an empty
 * loadout first when it has anything in it. Needs the settings password when one is on.
 */
export async function applyPreset(
  ctx: ActionContext,
  preset: Preset,
): Promise<ActionResult<{ state: AppState; savedTo?: number }>> {
  const state = await ctx.store.get();
  const { changed, empty } = await presetBackup(state, ctx.now());
  const savedTo = changed ? empty : undefined;
  if (savedTo !== undefined) {
    const saved = await copyToLoadout(ctx, savedTo);
    if (!saved.ok) return saved;
  }
  const r = await setLoadoutFromCode(ctx, state.activeLoadout ?? 0, await encodeShareCode(preset.settings()));
  if (!r.ok) return r;
  const marked = await markPresetsOffered(ctx);
  return { ok: true, data: { state: marked.ok ? marked.data : r.data, savedTo } };
}
