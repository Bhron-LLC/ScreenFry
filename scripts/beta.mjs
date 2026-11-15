#!/usr/bin/env node
// The experimental beta lane of ScreenFry's update feed (docs/DISTRIBUTION.md, "Beta channel").
//
//   node scripts/beta.mjs plan <state.json> <main-ref> <head-ref> <main-version> <main-build>
//       Whether to publish a beta, its number and build: prints JSON (and sets GitHub outputs).
//   node scripts/beta.mjs notes <version> <beta> [changelog]   the beta's update-window notes (HTML)
//   node scripts/beta.mjs label <fragment.xml> <display>       names the beta item "1.0.2 Beta 1.4"
//   node scripts/beta.mjs compose <out.xml> <main.xml> [beta.xml]   one feed with both lanes
//
// Beta numbers count beta features only. A beta is "major.minor": minor goes up when the beta's
// changes against main change, and stays the same when the beta is rebuilt on a newer main
// release. When main has everything the beta had (the beta went public), major goes up and
// minor restarts at 0: an "N.0" beta is identical to main, so it isn't published.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sectionFor, toHtml } from "./release-notes.mjs";

/** Folders whose changes make a beta (the app and both extensions), not docs or tooling. */
export const BETA_PATHS = ["apps", "packages", "safari"];
export const START = { major: 1, minor: 0, fingerprint: "", serial: 0, base: "" };

/**
 * What the beta's changes against main are, ignoring line numbers and context, so rebuilding
 * the same features on a newer main gives the same fingerprint. Empty when there are none.
 */
export function fingerprint(diff) {
  const lines = diff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line))
    .sort();
  return lines.length ? createHash("sha256").update(lines.join("\n")).digest("hex") : "";
}

/** The next beta, from the last published one's state and the beta's changes now. */
export function planBeta(previous, { fingerprint: print, base, mainBuild }) {
  const prev = { ...START, ...(previous ?? {}) };
  let { major, minor } = prev;
  let publish;
  if (!print) {
    // Identical to main. If it had features before, they've gone public: the next beta series.
    if (prev.fingerprint) {
      major += 1;
      minor = 0;
    }
    publish = false;
  } else if (print !== prev.fingerprint) {
    minor += 1;
    publish = true;
  } else {
    // Same features: rebuild only when main has moved on.
    publish = base !== prev.base;
  }
  const serial = publish ? prev.serial + 1 : prev.serial;
  const state = {
    major,
    minor,
    fingerprint: print,
    serial,
    base: publish ? base : prev.base,
  };
  return {
    publish,
    retire: !print && Boolean(prev.fingerprint),
    beta: `${major}.${minor}`,
    build: `${mainBuild}.${serial}`,
    state,
  };
}

/** The update window's notes for a beta: says plainly that it's a beta, then what's new. */
export function betaNotes(version, beta, changelog = "") {
  const section = sectionFor(changelog, "Beta");
  return [
    `<p><strong>Beta update</strong>: experimental features that are still being built and may have bugs. Includes everything in ScreenFry ${version}.</p>`,
    section ? toHtml(section) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** generate_appcast names the item after the app's version; a beta shows its beta number. */
export function labelBeta(xml, display) {
  if (!xml.includes("<sparkle:channel>beta</sparkle:channel>"))
    throw Error("The beta item isn't tagged with the beta channel.");
  return xml
    .replace(/<title>[^<]*<\/title>(\s*<pubDate>)/, `<title>${display}</title>$1`)
    .replace(
      /<sparkle:shortVersionString>[^<]*<\/sparkle:shortVersionString>/,
      `<sparkle:shortVersionString>${display}</sparkle:shortVersionString>`,
    );
}

const itemsOf = (xml) => xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

/** One feed: main's item(s), then the beta's. */
export function composeFeed(mainXml, betaXml) {
  const items = [...itemsOf(mainXml), ...(betaXml ? itemsOf(betaXml) : [])];
  if (!itemsOf(mainXml).length) throw Error("The main feed has no item.");
  const start = mainXml.slice(0, mainXml.indexOf("<item>"));
  const end = mainXml.slice(mainXml.lastIndexOf("</item>") + "</item>".length);
  return start + items.join("\n        ") + end;
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`)
      .join(""),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    const [statePath, mainRef, headRef, base, mainBuild] = args;
    const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    const diff = execFileSync("git", ["diff", "-U0", mainRef, headRef, "--", ...BETA_PATHS], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const plan = planBeta(previous, { fingerprint: fingerprint(diff), base, mainBuild });
    console.log(JSON.stringify(plan, null, 2));
    output({ publish: String(plan.publish), retire: String(plan.retire), beta: plan.beta, build: plan.build, state: plan.state });
  } else if (command === "notes") {
    const [version, beta, changelogPath] = args;
    const changelog = changelogPath && existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
    console.log(betaNotes(version, beta, changelog));
  } else if (command === "label") {
    const [path, display] = args;
    writeFileSync(path, labelBeta(readFileSync(path, "utf8"), display));
  } else if (command === "compose") {
    const [out, mainPath, betaPath] = args;
    const beta = betaPath && existsSync(betaPath) ? readFileSync(betaPath, "utf8") : undefined;
    writeFileSync(out, composeFeed(readFileSync(mainPath, "utf8"), beta));
  } else {
    console.error("Usage: node scripts/beta.mjs plan|notes|label|compose …");
    process.exit(1);
  }
}
