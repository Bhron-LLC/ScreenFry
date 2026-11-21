import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as actions from "@core/actions";
import { MemoryStateStore } from "@core/store";
import { createDefaultState, migrateState } from "@core/defaults";
import { encodeShareCode } from "@core/share";
import { applyPreset, PRESETS, presetById } from "@core/presets";
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

  it("the Mac app lists the same presets, with the same words", () => {
    const swift = readFileSync(new URL("../safari/ScreenFry/ScreenFry/AppPresets.swift", import.meta.url), "utf8");
    // Swift strings use ’ where the TypeScript ones may use '.
    const plain = (text: string) => text.replace(/’/g, "'");
    const listed = [...swift.matchAll(/Preset\(id: "([^"]+)", name: "([^"]+)", summary: "([^"]+)"/g)].map((m) => m.slice(1));
    expect(listed).toEqual(PRESETS.map((p) => [p.id, p.name, p.summary]));
    for (const preset of PRESETS) for (const point of preset.points) expect(plain(swift)).toContain(plain(point));
  });

  it("are offered on a fresh install, never after an update", () => {
    expect(createDefaultState().presetsOffered).toBe(false);
    // A fresh install's saved state keeps the offer until it's shown.
    expect(migrateState(createDefaultState()).presetsOffered).toBe(false);
    expect(migrateState({ ...createDefaultState(), presetsOffered: true }).presetsOffered).toBe(true);
    // Saved by a version before presets (or one that never saved the flag): no offer.
    const { presetsOffered: _, ...older } = createDefaultState();
    expect(migrateState(older).presetsOffered).toBe(true);
    expect(migrateState(undefined).presetsOffered).toBe(false);
  });

  it("from the Mac app, keeps the current setup in an empty loadout and counts as offered", async () => {
    const start = createDefaultState();
    start.rules = start.rules.map((r) => (r.id === "youtube" ? { ...r, dailyAllowance: { defaultMinutes: 15 } } : r));
    const store = new MemoryStateStore(start);
    const r = await applyPreset({ store, now: () => Date.now() }, presetById("strict")!);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const { state, savedTo } = (r as { data: { state: AppState; savedTo?: number } }).data;
    expect(savedTo).toBe(1);
    expect(state.loadouts?.[1]?.rules.find((x) => x.id === "youtube")?.dailyAllowance?.defaultMinutes).toBe(15);
    expect(state.rules.every((x) => x.blocked)).toBe(true);
    expect(state.presetsOffered).toBe(true);
    // A fresh setup has nothing worth keeping, so no loadout is used.
    const fresh = await applyPreset({ store: new MemoryStateStore(createDefaultState()), now: () => Date.now() }, presetById("chill")!);
    expect(fresh.ok && fresh.data.savedTo).toBe(undefined);
  });

  it("from the Mac app, wait for the settings password", async () => {
    const store = new MemoryStateStore(createDefaultState());
    await actions.setSettingsPassword({ store, now: () => Date.now() }, "correct horse battery");
    const r = await applyPreset({ store, now: () => Date.now() }, presetById("chill")!);
    expect(r.ok).toBe(false);
    expect((await store.get()).rules.some((x) => x.dailyAllowance)).toBe(false);
  });
});
