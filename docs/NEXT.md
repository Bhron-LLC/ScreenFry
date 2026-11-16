# ScreenFry next: store extensions, two-way installer, community

This branch (`dev/next`) holds work that isn't ready for the public release. `main` stays the released app: bug fixes land on `main` and ship through the update feed, and this branch merges `main` in regularly to keep them. A feature merges into `main` through a pull request when it's ready to ship. The release workflow refuses to run from anything not already on `main`, so nothing here can reach users' automatic updates by accident.

Order of work: **1 → 2 → 3**, then **4 → 5** (they share a backend).

## 1. ScreenFry on the Chrome Web Store

Today Chrome runs ScreenFry as an unpacked extension (Developer mode, dragged in from the app). A Web Store version installs with one click, updates through Chrome, and needs no Developer mode.

- [x] Samir signs in to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (account paid for). Claude's built-in browser can't open it and Chrome won't let extensions (Claude in Chrome) script it, so dashboard steps are done by hand.
- [x] `npm run package:chrome-store` builds `dist/ScreenFry-chrome-store-<version>.zip` from `dist/chrome`. 1.0.0 is uploaded as a new item, saved as an **Unlisted** draft (not yet submitted for review).
- [x] Fill in the listing from [store/chrome-web-store.md](../store/chrome-web-store.md): description, screenshots (1280×800), small promo tile (440×280), privacy practices and a reason for each permission. `npm run store:images` makes the screenshots and tile in `dist/store`.
- [x] Ticked the data-use certifications, replaced the package with a build that includes the store-install fix, and submitted 1.0.0 for review as **Unlisted** (2026-11-12). Expect an in-depth review because of `<all_urls>`.
- [x] The store's extension ID is `epoooaclakcopjgkplhmbffbgcjhmdfe`. The Mac app's native messaging host lets it in beside the unpacked copy (`ChromeNativeHost.storeExtensionID` and `allowedOrigins`, `SettingsTransfer.swift`), so check-ins, loadouts and Erase Everything work with either. With both installed they share Chrome's bridge folder: Erase Everything hands its request to every copy that checks in and waits for each one seen in the last ten minutes (`copies.json`, `erase-sent.json`), while the check-in, a reset and a loadout go to whichever copy checks in first.
- [x] The folder update check (`reloadIfUpdatedOnDisk`, with the background's version check) and the pages' stale-background heal (`healStaleBackground`) run only for the unpacked copy (`isUnpackedChrome`: `installType` is `development`); Chrome updates store installs itself.
- [x] Settings don't move between the unpacked and store copies (different extension IDs, separate storage). The official ScreenFry's Chrome card, when the unpacked folder is there, says how: Save ScreenFry Setup in Loadouts, add the Web Store version, Use in All Browsers, remove the old copy.
- [ ] Once approved, switch the listing to **Public**.
- [x] Once the Web Store version exists (Samir's request): turning off **Experimental beta features** in the Mac app, and the app in general for people not on betas, prompts them to install ScreenFry from the Chrome Web Store instead of the Developer mode copy. Betas keep the developer extensions (below). Built with section 3: leaving betas installs ScreenFry, whose Chrome card points to the Web Store; ScreenFry Developer suggests the switch once `Flavor.chromeWebStoreIsPublic` is set.

Decide: keep `<all_urls>` (windows and goals accept any website you type) or move typed websites to `optional_host_permissions` and request them when added, which makes review easier and the install prompt less scary.

## 2. Safari

Nothing is needed for an "official" Safari extension: since the Developer ID signed, notarized releases, Safari lists ScreenFry without any developer setting.

- [x] The **Mac App Store** edition (Sam: ship it together with the Chrome Web Store extension and the two-choice installer): the `ScreenFry App Store` target, sandboxed, no Sparkle, Chrome from the Web Store, the Safari bridge in an App Group. [docs/MAC_APP_STORE.md](MAC_APP_STORE.md) has how it differs and how it was tested; [store/mac-app-store.md](../store/mac-app-store.md) has the listing. `npm run appstore` builds it.
- [x] Xcode signed in again; `npm run appstore` exports a signed build.
- [x] The app is in App Store Connect (Apple ID `6834149513`) with its listing text filled in, and build 1.0.0 (45) is uploaded.
- [ ] Sam: accept the Paid Applications Schedule, add screenshots, the privacy/age/content-rights declarations, the review contact and pricing (docs/MAC_APP_STORE.md lists them); try the build in TestFlight (the App Group bridge with Safari, Chrome check-ins); then submit with the release.

## 3. Installer with two choices

The disk image offers **ScreenFry** as the main choice, and below it, smaller and set apart (Samir's request), **ScreenFry Developer** next to an **Uninstall ScreenFry** button:

- **ScreenFry** (the full-color logo): uses the official extensions. Chrome's card sends you to the Web Store listing instead of Developer mode.
- **ScreenFry Developer** (the greyed logo, `assets/branding/screenfry-developer.png`): today's behavior, with the unpacked Chrome extension that updates the moment the app does. For people who want it, for testing, and for betas.

Built (docs/DISTRIBUTION.md describes it):

- [x] **One app, two flavors**: the same bundle ID and code, with `ScreenFryChannel` = `official` or `developer` in Info.plist, set by `scripts/build-flavor.sh` (with the display name, `AppIconDeveloper` and the feed). Same bundle ID means macOS and Safari see one ScreenFry. The apps have different file names (the disk image needs both), so the app warns while both are installed and says to trash one.
- [x] The release workflow builds both, signs them, notarizes the disk image holding both (then staples each app), and publishes each flavor's zipped app with its own feed: `appcast.xml` (ScreenFry) and `appcast-developer.xml` (ScreenFry Developer). Copies from 1.0 read `appcast.xml`, so they become ScreenFry (Samir's choice); the official app keeps an existing unpacked folder current until it's gone.
- [x] In the app: the flavor picks the Chrome card (Web Store link vs. Developer mode steps), the name in the window and About, and the Dock icon. A Web Store copy behind the app's version shows as connected (the store's review lags). **Switch to Developer/Official Extensions…** in the app menu explains the difference and opens the download (Samir's choice; switching inside the app can come later).
- [x] The DMG (`assets/dmg/background.svg`, rendered by `scripts/render-dmg-background.mjs`): ScreenFry and Applications up top; an "Other options" panel with ScreenFry Developer and Uninstall ScreenFry (an applet that opens the installed app with `screenfry://uninstall`). Finder draws every icon at one size, so the options are smaller only in their type and placement.
- [x] Fitted to the beta channel (main 1.0.2): betas are ScreenFry Developer builds, in both feeds' beta lanes. Turning betas on in ScreenFry makes it ScreenFry Developer (Beta); turning them off always installs ScreenFry from `appcast.xml`, which points Chrome to the Web Store (Samir's request). The beta switch installs whichever app a download holds in this one's place. A beta's disk image keeps one app named ScreenFry.app, which 1.0.2's switch expects.
- [ ] Once the Web Store listing is public: set `Flavor.chromeWebStoreIsPublic`, so ScreenFry Developer not on betas suggests switching to ScreenFry.
- [ ] Before shipping: the store item approved, a signed `npm run dmg:local` tried on a Mac (install each flavor, switch between them, update from 1.0).

## 4. Setup library and search (community)

Browse and search setups other people share ("YouTube for studying", "no Shorts, 30 minutes of Reddit"), preview what one changes, and apply it to a loadout. Share codes (`SF2-`, settings only) are already the format.

This is ScreenFry's first backend, so it changes the local-first rule for this feature only. **The full plan is in [SETUP_LIBRARY.md](SETUP_LIBRARY.md)**: the API, data schema, code validation, privacy, UI flow, store review, tests and build order.

Decided (Samir, November 12, 2026): an anonymous key for each install to publish (no accounts), setups go live at once and are hidden after 3 reports, Cloudflare Workers + D1 in `services/library` in this repo, and a Library tab on the Share page first (the Mac app later).

- [x] Opt-in and separate: browsing and applying setups needs no key. Publishing, upvoting and reporting make an anonymous key for the install. Nothing about you or your settings is sent unless you publish. The core app keeps working with no network.
- [x] Choose the backend: Cloudflare Workers + D1.
- [x] Addresses: production `https://screenfry-library.bhron-site.workers.dev`, test `https://screenfry-library-test.bhron-site.workers.dev` (the Cloudflare account's free workers.dev subdomain; no DNS changes).
- [x] Contact for reports: help@bhron.org.
- [ ] Still open: the tag list (the draft in SETUP_LIBRARY.md is what's built).
- [ ] Build it in the order in [SETUP_LIBRARY.md](SETUP_LIBRARY.md#build-order). Steps 1–8 are built (PRs #70 and #71), and the test server is live. Left: deploy production and switch the extension to it, a Safari check, and the App Store text once #63 merges.
- [x] Privacy page, AGENTS.md, README, threat model and Chrome Web Store listing updated. The App Store text waits for PR #63 (in SETUP_LIBRARY.md). Never include usage or history in a published setup.

## 5. Earn leaderboard

Who spent the most time on their Earn goal websites (learning apps, reading, exercise sites) this week.

- [ ] Opt-in, with a display name; only the weekly Earn minutes per goal website are sent (never other websites, never history). Leave any time.
- [ ] Needs accounts or device keys to stop easy cheating: Sign in with Apple or an anonymous key pair per install. Accept that a browser extension can't fully stop faked numbers; keep it friendly (friends' boards, weekly resets).
- [ ] Same backend as the library (Cloudflare Workers + D1, `services/library`), and the same anonymous install keys. UI: a board on the Earn page; the Mac app could show your rank in the menu.

## Beta channel (from 1.0.2)

`dev/next` is the source of automatic beta builds (main's PR #68, `.github/workflows/beta.yml`, `scripts/beta.mjs`; docs/DISTRIBUTION.md "Beta channel"). After every main release and every push to `dev/next`, the Beta workflow merges `main` into `dev/next` and, if anything in `apps/`, `packages/` or `safari/` differs from `main`, builds, signs and notarizes a beta and ships it to everyone with **Experimental beta features** on. So:

- **Merging into `dev/next` releases to beta users.** Samir: nothing goes into the beta until it's good. Keep unfinished features on their own `dev/…` branches with pull requests into `dev/next`, and merge only when they're ready for beta users.
- Beta numbers ("1.0.2 Beta 1.1") count beta features only. Each feature merged into `dev/next` adds a short plain-words line to the `## Beta` section of `dev/next`'s `CHANGELOG.md` (the beta update window shows it).
- Betas use the developer (unpacked) Chrome extension and the app's Safari extension; store versions (Chrome Web Store, Mac App Store) never get betas.
- Reconciled (section 3): betas are ScreenFry Developer builds in both feeds' beta lanes, and leaving betas always comes back to ScreenFry.

## Working on this branch

- Start each session with `git fetch && git merge origin/main` so bug fixes from `main` are here.
- `npm run check` and `npm run test:e2e` as on `main`. Build the Mac app locally with `npm run dmg:local`; don't run the Release workflow (it refuses anyway).
- Ship a finished piece by opening a pull request from a branch off `dev/next` into `main`, with its `CHANGELOG.md` entry under Unreleased.
