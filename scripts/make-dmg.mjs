// Builds the drag-to-Applications download: dist/ScreenFry-<version>.dmg (macOS only).
//   npm run dmg -- [path/to/ScreenFry.app] [path/to/ScreenFry Developer.app]
//   npm run dmg -- --single <path/to/app>          (a beta: one app, named ScreenFry.app)
// A release's window (assets/dmg/background.svg) shows ScreenFry with an arrow to Applications,
// and below them, as quieter "Other options", ScreenFry Developer and Uninstall ScreenFry (a
// small applet that asks the installed ScreenFry to run its Uninstall). SCREENFRY_SIGN_IDENTITY
// signs that applet ("Developer ID Application" for releases; ad-hoc when unset).
// Dropping a newer ScreenFry onto Applications replaces the old one; bundle identifiers never
// change, so Safari keeps the extension and its settings, and the app refreshes Chrome's copy.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.error("make-dmg runs on macOS (it uses hdiutil).");
  process.exit(1);
}
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const single = args[0] === "--single";
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", `ScreenFry-${version}.dmg`);
rmSync(out, { force: true });
const work = mkdtempSync(join(tmpdir(), "screenfry-dmg-"));
const ditto = (from, to) => execFileSync("/usr/bin/ditto", [from, to]);

let spec;
let expected;
try {
  if (single) {
    // A beta's disk image: its one app, named ScreenFry.app (what the 1.0.2 beta switch and
    // Sparkle look for), beside Applications.
    const source = resolve(args[1] ?? "");
    need(source);
    const app = join(work, "ScreenFry.app");
    ditto(source, app);
    expected = ["ScreenFry.app"];
    spec = {
      background: join(root, "assets/dmg/background-single.png"),
      "icon-size": 112,
      window: { size: { width: 660, height: 400 } },
      contents: [
        { x: 170, y: 190, type: "file", path: app },
        { x: 490, y: 190, type: "link", path: "/Applications" },
      ],
    };
  } else {
    const app = resolve(args[0] ?? "dist/safari/Build/Products/Release/ScreenFry.app");
    const developer = resolve(args[1] ?? "dist/safari-developer/Build/Products/Release/ScreenFry Developer.app");
    need(app);
    need(developer);
    if (basename(app) !== "ScreenFry.app" || basename(developer) !== "ScreenFry Developer.app") {
      console.error("Pass ScreenFry.app, then ScreenFry Developer.app.");
      process.exit(1);
    }
    const uninstaller = makeUninstaller(join(work, "Uninstall ScreenFry.app"));
    expected = ["ScreenFry.app", "ScreenFry Developer.app", "Uninstall ScreenFry.app"];
    // Finder draws every icon at one size, so the options are set apart by place and the
    // background's quieter panel (assets/dmg/background.svg holds the same coordinates).
    spec = {
      background: join(root, "assets/dmg/background.png"),
      "icon-size": 88,
      window: { size: { width: 760, height: 500 } },
      contents: [
        { x: 200, y: 205, type: "file", path: app },
        { x: 560, y: 205, type: "link", path: "/Applications" },
        { x: 520, y: 415, type: "file", path: developer },
        { x: 660, y: 415, type: "file", path: uninstaller },
      ],
    };
  }
  const specPath = join(work, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      title: "ScreenFry",
      icon: join(root, "apps/extension/public/icons/icon-512.png"),
      format: "UDZO",
      ...spec,
    }),
  );
  // appdmg sometimes fails to detach its working image on GitHub's Macs ("hdiutil detach
  // failed"), which once shipped a plain installer (0.7.4). Clear leftover ScreenFry volumes
  // and try a few times; a release must never fall back to the plain image.
  const detachStale = () => {
    for (const volume of readdirSync("/Volumes").filter((v) => v.startsWith("ScreenFry"))) {
      try {
        execFileSync("hdiutil", ["detach", "-force", join("/Volumes", volume)], { stdio: "ignore" });
      } catch {
        /* not ours or already gone */
      }
    }
  };
  let laidOut = false;
  for (let attempt = 1; attempt <= 3 && !laidOut; attempt++) {
    detachStale();
    rmSync(out, { force: true });
    try {
      execFileSync("npx", ["--yes", "appdmg@0.6.6", specPath, out], { stdio: "inherit" });
      laidOut = true;
    } catch {
      console.warn(`appdmg attempt ${attempt} failed.`);
      execFileSync("sleep", ["5"]);
    }
  }
  if (laidOut) verifyLayout(out, expected);
  else {
    if (process.env.CI) {
      console.error("appdmg failed three times; not shipping an installer without its window layout.");
      process.exit(1);
    }
    // Local builds only: a plain image with the same items and an Applications shortcut.
    console.warn("appdmg failed; building a plain disk image instead (local builds only).");
    const staging = join(work, "staging");
    mkdirSync(staging);
    for (const item of spec.contents.filter((c) => c.type === "file")) ditto(item.path, join(staging, basename(item.path)));
    symlinkSync("/Applications", join(staging, "Applications"));
    execFileSync("hdiutil", ["create", "-volname", "ScreenFry", "-srcfolder", staging, "-ov", "-format", "UDZO", out], {
      stdio: "inherit",
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Built ${out}`);

function need(path) {
  if (!existsSync(path)) {
    console.error(`No app at ${path}. Build it first (see docs/DISTRIBUTION.md).`);
    process.exit(1);
  }
}

/**
 * "Uninstall ScreenFry": a small AppleScript applet that opens the installed ScreenFry (or
 * ScreenFry Developer) with screenfry://uninstall, which shows its own Uninstall choices
 * (Keep Settings or Erase Everything). It names the app by its path, so the copy inside this
 * disk image never answers instead.
 */
function makeUninstaller(path) {
  const script = `on run
  repeat with candidate in {"/Applications/ScreenFry.app", "/Applications/ScreenFry Developer.app"}
    try
      do shell script "test -d " & quoted form of candidate
      do shell script "open -a " & quoted form of candidate & " screenfry://uninstall"
      return
    end try
  end repeat
  display dialog "ScreenFry isn't in your Applications folder, so there's nothing to uninstall." buttons {"OK"} default button 1 with title "Uninstall ScreenFry"
end run`;
  execFileSync("/usr/bin/osacompile", ["-o", path, "-e", script]);
  const plist = join(path, "Contents/Info.plist");
  // Set or add each key (osacompile's Info.plist has only some of them).
  const set = (key, value) => {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "ignore" });
    } catch {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
    }
  };
  set("CFBundleIdentifier", "com.screenfry.Uninstall");
  set("CFBundleName", "Uninstall ScreenFry");
  set("CFBundleShortVersionString", version);
  // Its icon: the greyed logo with a red "remove" badge (scripts/render-dmg-background.mjs).
  const iconset = join(work, "uninstall.iconset");
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      execFileSync("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), join(root, "assets/dmg/uninstall.png"),
        "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(path, "Contents/Resources/applet.icns")]);
  // Signed like the apps, so the notarized disk image covers it too.
  const identity = process.env.SCREENFRY_SIGN_IDENTITY || "-";
  const flags = identity === "-" ? [] : ["--options", "runtime", "--timestamp"];
  execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, ...flags, path], { stdio: "inherit" });
  return path;
}

/** The installer must carry its background and window layout (Finder's .DS_Store). */
function verifyLayout(dmg, items) {
  const mount = mkdtempSync(join(tmpdir(), "screenfry-dmg-check-"));
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg], { stdio: "ignore" });
  try {
    const missing = [".background", ".DS_Store", ...items, "Applications"].filter(
      (name) => !existsSync(join(mount, name)),
    );
    if (missing.length) {
      console.error(`The installer is missing ${missing.join(", ")}.`);
      process.exit(1);
    }
  } finally {
    execFileSync("hdiutil", ["detach", mount], { stdio: "ignore" });
    rmSync(mount, { recursive: true, force: true });
  }
}
