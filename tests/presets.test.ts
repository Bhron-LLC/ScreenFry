import { describe, expect, it } from "vitest";
import * as actions from "@core/actions";
import { MemoryStateStore } from "@core/store";
import { createDefaultState } from "@core/defaults";
import { encodeShareCode } from "@core/share";
import { PRESETS } from "@core/presets";
import { evaluatePolicy } from "@policy/index";
import { siteDefinitions } from "@feeds/index";
import type { AppState } from "@shared/index";

/** Applies a preset the way the settings page does: as a share code into the live loadout. */
async function apply(id: string): Promise<AppState> {
  const store = new MemoryStateStore(createDefaultState());
  const preset = PRESETS.find((p) => p.id === id)!;
  const code = await encodeShareCode(preset.settings());
  const r = await actions.setLoadoutFromCode({ store, now: () => new Date(2026, 10, 18, 19, 0).getTime() }, 0, code);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return (r as { data: AppState }).data;
}

describe("presets", () => {
  it("are the four Samir asked for", () => {
    expect(PRESETS.map((p) => p.name)).toEqual(["Most popular", "Strict mode", "Chill mode", "Short-free"]);
  });

  it("Most popular hides every feed and Short, with 30 minutes of Fry Time from 6 pm to midnight", async () => {
    const state = await apply("popular");
    for (const site of siteDefinitions) {
      const on = state.feedSettings.sites[site.site];
      for (const [key, element] of Object.entries(site.elements))
        if (element.group === "Feeds" && !element.requires) expect(on[key], `${site.site}.${key}`).toBe(true);
      if (site.shortForm) expect(on[site.shortForm.setting], site.site).toBe(true);
    }
    expect(state.windows).toHaveLength(1);
    const [w] = state.windows;
    expect([w.mode, w.freeMinutes, w.startMinute, w.endMinute, w.days.length]).toEqual(["free", 30, 1080, 1440, 7]);
    expect(state.rules.every((r) => !r.blocked && !r.dailyAllowance)).toBe(true);
    // At 7 pm, YouTube's feeds are paused for Fry Time.
    expect(evaluatePolicy(state, "https://www.youtube.com/", new Date(2026, 10, 18, 19, 0).getTime()).freeTime).toBeTruthy();
  });

  it("Strict mode blocks every website", async () => {
    const state = await apply("strict");
    expect(state.rules.map((r) => r.id).sort()).toEqual(siteDefinitions.map((s) => s.site).sort());
    expect(state.rules.every((r) => r.blocked)).toBe(true);
    expect(evaluatePolicy(state, "https://www.reddit.com/", Date.now()).status).toBe("blocked");
  });

  it("Chill mode gives every website an hour a day", async () => {
    const state = await apply("chill");
    expect(state.rules.every((r) => r.dailyAllowance?.defaultMinutes === 60 && !r.blocked)).toBe(true);
  });

  it("Short-free blocks Shorts, Reels and video feeds, and TikTok", async () => {
    const state = await apply("short-free");
    for (const site of siteDefinitions.filter((s) => s.shortForm))
      expect(state.feedSettings.sites[site.site][site.shortForm!.setting], site.site).toBe(true);
    expect(state.rules.find((r) => r.id === "tiktok")?.blocked).toBe(true);
    expect(state.rules.filter((r) => r.id !== "tiktok").every((r) => !r.blocked)).toBe(true);
    // Ordinary feeds stay as they were.
    expect(state.feedSettings.sites.youtube.home).toBe(false);
  });
});
