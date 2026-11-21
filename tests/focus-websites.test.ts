import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as actions from "@core/actions";
import { MemoryStateStore } from "@core/store";
import { migrateState } from "@core/defaults";
import { cleanFocusSites } from "@core/domains";
import { focusWanted } from "@policy/index";
import { Clock, at, stateWith } from "./helpers";

describe("Focus websites: which tab wants Focus", () => {
  const state = stateWith([], { focusSites: ["docs.google.com", "youtube.com"] });
  it("matches the typed websites, their subdomains and aliases", () => {
    expect(focusWanted(state, "https://docs.google.com/document/d/1")).toBe(true);
    expect(focusWanted(state, "https://www.youtube.com/watch?v=x")).toBe(true);
    expect(focusWanted(state, "https://m.youtube.com/")).toBe(true);
    expect(focusWanted(state, "https://youtu.be/x")).toBe(true);
  });
  it("leaves every other address alone", () => {
    expect(focusWanted(state, "https://google.com/")).toBe(false);
    expect(focusWanted(state, "https://mail.google.com/")).toBe(false);
    expect(focusWanted(state, "https://notyoutube.com/")).toBe(false);
    expect(focusWanted(state, "chrome-extension://abc/dashboard.html")).toBe(false);
    expect(focusWanted(state, undefined)).toBe(false);
  });
  it("wants nothing without Focus websites", () => {
    expect(focusWanted(stateWith([]), "https://youtube.com/")).toBe(false);
    expect(focusWanted(stateWith([], { focusSites: [] }), "https://youtube.com/")).toBe(false);
  });
});

describe("Focus websites: the typed list", () => {
  it("keeps websites only, as domains, once each", () => {
    expect(
      cleanFocusSites([
        "https://www.YouTube.com/watch?v=x",
        "docs.google.com/document",
        "youtube.com",
        "not a website",
        "",
        42,
      ]),
    ).toEqual(["youtube.com", "docs.google.com"]);
  });
  it("survives a reload and drops anything that isn't a website", () => {
    const saved = { ...stateWith([]), focusSites: ["notion.so", "bad site", 7] };
    expect(migrateState(saved).focusSites).toEqual(["notion.so"]);
    expect(migrateState({ ...stateWith([]), focusSites: "notion.so" }).focusSites).toBeUndefined();
  });
  let store: MemoryStateStore, ctx: actions.ActionContext;
  beforeEach(() => {
    store = new MemoryStateStore();
    ctx = { store, now: new Clock(at(2026, 10, 21, 12)).now };
  });
  it("is saved through the actions, and an empty list removes it", async () => {
    const r = await actions.setFocusSites(ctx, ["Notion.so", "docs.google.com", "notion.so"]);
    expect(r.ok && r.data.focusSites).toEqual(["notion.so", "docs.google.com"]);
    const cleared = await actions.setFocusSites(ctx, []);
    expect(cleared.ok && "focusSites" in cleared.data).toBe(false);
    expect((await actions.setFocusSites(ctx, "notion.so")).ok).toBe(true);
    expect((await store.get()).focusSites).toBeUndefined();
  });
  it("asks for the settings password when one is set", async () => {
    await actions.setSettingsPassword(ctx, "a test password");
    const denied = await actions.setFocusSites({ ...ctx, password: undefined }, ["notion.so"]);
    expect(denied.ok).toBe(false);
    expect((await store.get()).focusSites).toBeUndefined();
    const allowed = await actions.setFocusSites({ ...ctx, password: "a test password" }, ["notion.so"]);
    expect(allowed.ok).toBe(true);
  });
});

// The Mac app's on/off timing (safari/ScreenFry/ScreenFry/FocusSwitch.swift) is plain Swift;
// on a Mac with the Swift compiler it's compiled with tests/swift/FocusSwitchTests/main.swift and run.
const root = resolve(import.meta.dirname, "..");
const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
describe.skipIf(!swiftc)("Focus websites: the Mac app's timing", () => {
  it("turns on at once, off 10 seconds after, and coming back resets the wait", () => {
    const dir = mkdtempSync(join(tmpdir(), "screenfry-focus-"));
    try {
      const binary = join(dir, "focus-switch-tests");
      execFileSync("xcrun", [
        "swiftc",
        "-o",
        binary,
        join(root, "safari/ScreenFry/ScreenFry/FocusSwitch.swift"),
        join(root, "tests/swift/FocusSwitchTests/main.swift"),
      ]);
      const out = execFileSync(binary, { encoding: "utf8" });
      expect(out).toContain("All FocusSwitch tests passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
