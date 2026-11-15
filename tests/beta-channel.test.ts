import { describe, expect, it } from "vitest";
import { betaNotes, composeFeed, fingerprint, labelBeta, planBeta } from "../scripts/beta.mjs";

const diff = (lines: string[]) =>
  ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,0 +2,3 @@", ...lines].join("\n");

describe("beta numbers", () => {
  it("follow beta features, not main releases", () => {
    // Nothing in the beta yet: no beta is published.
    let plan = planBeta(null, { fingerprint: "", base: "1.0.2", mainBuild: "47" });
    expect(plan.publish).toBe(false);
    // The first beta features: 1.0.2 Beta 1.1.
    plan = planBeta(plan.state, { fingerprint: "a", base: "1.0.2", mainBuild: "47" });
    expect([plan.publish, plan.beta, plan.build]).toEqual([true, "1.1", "47.1"]);
    // More features: Beta 1.2.
    plan = planBeta(plan.state, { fingerprint: "b", base: "1.0.2", mainBuild: "47" });
    expect([plan.publish, plan.beta, plan.build]).toEqual([true, "1.2", "47.2"]);
    // A docs-only change: nothing to publish.
    plan = planBeta(plan.state, { fingerprint: "b", base: "1.0.2", mainBuild: "47" });
    expect(plan.publish).toBe(false);
    // Main ships 1.0.3: rebuilt as 1.0.3 Beta 1.2, the beta number unchanged.
    plan = planBeta(plan.state, { fingerprint: "b", base: "1.0.3", mainBuild: "48" });
    expect([plan.publish, plan.beta, plan.build]).toEqual([true, "1.2", "48.3"]);
    // The beta goes public: identical to main (Beta 2.0), so the beta lane is retired.
    plan = planBeta(plan.state, { fingerprint: "", base: "1.1.0", mainBuild: "49" });
    expect([plan.publish, plan.retire, plan.beta]).toEqual([false, true, "2.0"]);
    // The next beta feature starts the 2.x series.
    plan = planBeta(plan.state, { fingerprint: "c", base: "1.1.0", mainBuild: "49" });
    expect([plan.publish, plan.beta, plan.build]).toEqual([true, "2.1", "49.4"]);
  });

  it("see the same features rebuilt on a newer main as the same", () => {
    const before = diff(["+added line", "-removed line"]);
    const moved = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -9,0 +12,3 @@", "-removed line", "+added line"].join("\n");
    expect(fingerprint(before)).toBe(fingerprint(moved));
    expect(fingerprint(before)).not.toBe(fingerprint(diff(["+another line"])));
    expect(fingerprint("")).toBe("");
  });
});

describe("the beta lane of the feed", () => {
  const item = (title: string, extra = "") => `<item>
            <title>${title}</title>
            <pubDate>Sun, 15 Nov 2026 16:09:21 +0000</pubDate>${extra}
            <sparkle:version>47</sparkle:version>
            <sparkle:shortVersionString>1.0.2</sparkle:shortVersionString>
        </item>`;
  const feed = (items: string) =>
    `<?xml version="1.0" standalone="yes"?>\n<rss version="2.0">\n    <channel>\n        <title>ScreenFry</title>\n        ${items}\n    </channel>\n</rss>`;

  it("names beta items by their beta number and keeps both lanes in one feed", () => {
    const beta = labelBeta(feed(item("1.0.2", "\n            <sparkle:channel>beta</sparkle:channel>")), "1.0.2 Beta 1.4");
    expect(beta).toContain("<title>1.0.2 Beta 1.4</title>");
    expect(beta).toContain("<sparkle:shortVersionString>1.0.2 Beta 1.4</sparkle:shortVersionString>");
    expect(beta).toContain("<title>ScreenFry</title>");
    const both = composeFeed(feed(item("1.0.2")), beta);
    expect(both.match(/<item>/g)).toHaveLength(2);
    expect(both.indexOf("<title>1.0.2</title>")).toBeLessThan(both.indexOf("Beta 1.4"));
    expect(composeFeed(feed(item("1.0.2")))).toBe(feed(item("1.0.2")));
    expect(() => labelBeta(feed(item("1.0.2")), "1.0.2 Beta 1.4")).toThrow();
  });

  it("says plainly in the update window that it's a beta", () => {
    expect(betaNotes("1.0.2", "1.4", "## Beta\n\n- New thing\n\n## 1.0.2\n\n- Old")).toBe(
      "<p><strong>Beta update</strong>: experimental features that are still being built and may have bugs. Includes everything in ScreenFry 1.0.2.</p>\n<ul>\n<li>New thing</li>\n</ul>",
    );
  });
});
