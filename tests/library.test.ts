import { beforeEach, describe, expect, it } from "vitest";
import * as actions from "@core/actions";
import { MemoryStateStore } from "@core/store";
import { createDefaultState } from "@core/defaults";
import { encodeShareCode } from "@core/share";
import {
  LIBRARY_MAX_CODE_LENGTH,
  checkLibraryCode,
  checkPublishable,
  cleanText,
  hasBlockedWord,
} from "@core/library";
import { Clock, at, rule } from "./helpers";
import type { AccessWindow } from "@shared/index";

const NOW = at(2026, 10, 15, 12);
const lunch: AccessWindow = {
  id: "lunch",
  label: "Lunch",
  enabled: true,
  domains: ["reddit.com"],
  days: [1, 2, 3, 4, 5],
  startMinute: 720,
  endMinute: 780,
  mode: "allow",
};
let ctx: actions.ActionContext;
beforeEach(() => {
  ctx = { store: new MemoryStateStore(), now: new Clock(NOW).now };
});
const codeOf = async () => encodeShareCode(actions.exportSettings(await ctx.store.get(), NOW));
const toBase64Url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A hand-made SF2 code with the plain ("j") payload. */
const rawCode = (payload: unknown) => `SF2-j${toBase64Url(JSON.stringify(payload))}`;

async function studyingSetup() {
  await actions.saveRule(ctx, rule({ dailyAllowance: { defaultMinutes: 30 } }));
  await actions.saveWindow(ctx, lunch);
  const s = await ctx.store.get();
  s.feedSettings.sites.youtube.shorts = true;
  await ctx.store.update(() => s);
  return codeOf();
}

describe("setup library checks", () => {
  it("accepts a real code and returns it with its websites and summary", async () => {
    const code = await studyingSetup();
    const { setup, error } = await checkPublishable({
      code,
      title: "  YouTube   for studying ",
      description: "No Shorts, 30 minutes a day.",
      tags: ["studying", "no-shorts", "studying"],
    });
    expect(error).toBeUndefined();
    expect(setup!.code).toBe(code);
    expect(setup!.title).toBe("YouTube for studying");
    expect(setup!.tags).toEqual(["studying", "no-shorts"]);
    expect(setup!.websites).toEqual(["youtube", "reddit"]);
    expect(setup!.summary.limits).toEqual(["YouTube: 30 min a day"]);
    expect(setup!.summary.windows).toEqual(["Lunch"]);
  });

  it("refuses anything that isn't an SF2 code", async () => {
    await studyingSetup();
    const settings = actions.exportSettings(await ctx.store.get(), NOW);
    const v1 = `SCREENFRY-1-${toBase64Url(JSON.stringify(settings))}`;
    const mac = `SFM1-${toBase64Url(JSON.stringify({ safari: await codeOf() }))}`;
    for (const code of [v1, mac, JSON.stringify(settings), "", "hello", undefined])
      expect((await checkLibraryCode(code)).error).toMatch(/SF2-/);
  });

  it("refuses damaged, oversized and empty codes", async () => {
    expect((await checkLibraryCode("SF2-zAAAA")).error).toMatch(/damaged/);
    expect((await checkLibraryCode(`SF2-j${"A".repeat(LIBRARY_MAX_CODE_LENGTH)}`)).error).toMatch(/too big/);
    const fresh = await encodeShareCode(actions.exportSettings(createDefaultState(), NOW));
    expect((await checkLibraryCode(fresh)).error).toMatch(/doesn’t change anything/);
  });

  it("refuses a payload that unpacks past the library's cap", async () => {
    const json = new TextEncoder().encode(JSON.stringify({ w: [["x".repeat(70_000), 0, 2, 0, 60, "reddit"]] }));
    const zipped = new Uint8Array(
      await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
    );
    const code = `SF2-z${toBase64Url(String.fromCharCode(...zipped))}`;
    expect(code.length).toBeLessThan(LIBRARY_MAX_CODE_LENGTH);
    expect((await checkLibraryCode(code)).error).toMatch(/damaged/);
  });

  it("refuses setups past the count limits", async () => {
    const w = Array.from({ length: 21 }, (_, i) => [`W${i}`, 1, 2, 0, 60, "reddit"]);
    expect((await checkLibraryCode(rawCode({ w }))).error).toMatch(/up to 20 windows/);
  });

  it("rebuilds the code, so nothing but settings can ride along", async () => {
    const payload = {
      r: { youtube: [1] },
      u: { "youtube.com": 3_600_000 },
      history: ["https://example.com/private"],
      password: { hash: "abc" },
    };
    const { code, error } = await checkLibraryCode(rawCode(payload));
    expect(error).toBeUndefined();
    const body = code!.slice(4);
    const json =
      body[0] === "j"
        ? atob(body.slice(1).replace(/-/g, "+").replace(/_/g, "/"))
        : new TextDecoder().decode(
            await new Response(
              new Blob([Uint8Array.from(atob(body.slice(1).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))])
                .stream()
                .pipeThrough(new DecompressionStream("deflate-raw")),
            ).arrayBuffer(),
          );
    expect(Object.keys(JSON.parse(json)).every((k) => ["r", "w", "e", "f", "g", "n"].includes(k))).toBe(true);
    expect(json).not.toMatch(/history|password|private|3600000/);
  });

  it("checks every name in the code, not only the title", async () => {
    await actions.saveWindow(ctx, { ...lunch, label: "sh1t o'clock" });
    expect((await checkLibraryCode(await codeOf())).error).toMatch(/word the library/);
  });

  it("strips invisible characters from names in the code", async () => {
    await actions.saveWindow(ctx, { ...lunch, label: "Lunch‮ break" });
    const { code } = await checkLibraryCode(await codeOf());
    const { settings } = actions.checkSettings(
      await (await import("@core/share")).decodeShareCode(code!),
      NOW,
    );
    expect(settings!.windows[0].label).toBe("Lunch break");
  });

  it("names custom websites by domain and registry websites by site id", async () => {
    await actions.saveWindow(ctx, { ...lunch, domains: ["news.example.org", "x.com", "youtu.be"] });
    const { websites } = await checkLibraryCode(await codeOf());
    expect(websites).toEqual(["youtube", "x", "news.example.org"]);
  });

  it("checks the title, description and tags", async () => {
    const code = await studyingSetup();
    const err = async (patch: object) =>
      (await checkPublishable({ code, title: "Good title", ...patch })).error;
    expect(await err({ title: "Hi" })).toMatch(/title of 3 to 60/);
    expect(await err({ title: "x".repeat(61) })).toMatch(/title of 3 to 60/);
    expect(await err({ description: "x".repeat(281) })).toMatch(/280/);
    expect(await err({ title: "F U C K feeds" })).toMatch(/word/);
    expect(await err({ description: "see https://spam.example" })).toMatch(/links/);
    expect(await err({ description: "x.com before 9 only" })).toBeUndefined();
    expect(await err({ tags: ["studying", "made-up"] })).toMatch(/from the list/);
    expect(await err({ tags: ["studying", "work", "sleep", "detox", "earn"] })).toMatch(/up to 4/);
    expect(await err({ tags: "studying" })).toMatch(/from the list/);
  });
});

describe("word filter", () => {
  it("catches swaps and spacing without catching ordinary words", () => {
    for (const bad of ["shit", "Sh1tty feeds", "s.h.i.t", "F@ggot", "motherfucker"])
      expect(hasBlockedWord(bad)).toBe(true);
    for (const fine of ["Scunthorpe", "assessment", "class time", "Essex", "grapes", "Sussex", "Dickens"])
      expect(hasBlockedWord(fine)).toBe(false);
  });

  it("cleans text", () => {
    expect(cleanText("  a​\tb\n‮c ")).toBe("a b c");
    expect(cleanText(undefined)).toBe("");
  });
});
