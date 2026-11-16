# Chrome Web Store listing (draft)

Fill these into the [developer dashboard](https://chrome.google.com/webstore/devconsole). Upload `dist/ScreenFry-chrome-store-<version>.zip` from `npm run package:chrome-store`.

## Store listing

**Name:** ScreenFry

**Summary (132 characters max):** Less feed. More day. Hide feeds and Shorts, set daily limits and earn your time on YouTube, Instagram, X, Reddit, TikTok and more.

**Category:** Productivity (Workflow & Planning)

**Description:**

> ScreenFry strips the endless feeds, Shorts and recommendations out of social websites and limits how long you spend on them, while search, links, profiles and messages keep working.
>
> • Hide feeds, recommendations, comments and buttons, website by website: YouTube, Instagram, X, Reddit, Substack, TikTok, Facebook, LinkedIn and Quora.
> • Block Shorts and Reels, or use research mode: the one you were sent plays, nothing after it.
> • Daily limits per website, with a live countdown when time is up.
> • Windows: allow websites only at certain times, block them at others, or open their feeds up for a while with Fry Time.
> • Earn your time: spend minutes on a website you want to use more to unlock others or earn Fry Time.
> • Five loadouts, and share codes to swap setups with friends.
> • An optional setup library: find setups other people have published, like "YouTube for studying", preview what one changes, and put it in a loadout. Or publish your own.
> • An optional password protects your settings from impulsive changes. It never grants extra time.
>
> Everything stays in your browser: no account, no analytics, and no record of the websites you visit. The setup library is the only part that goes online, and only after you turn it on: it receives your searches and the setups you choose to publish, never your usage or history. Every control starts off, so nothing changes until you choose.
>
> On a Mac, the ScreenFry app adds Safari, keeps your setups for every browser and updates everything together.

**Screenshots (1280×800, up to 5):** Websites page (YouTube controls), the Shorts choice, Windows page, Earn page, a "Time is up!" screen. `tests/e2e/chrome-smoke.mjs` captures dashboard pages to `dist/screenshots` locally; crop or re-capture at 1280×800.

**Small promo tile (440×280):** logo and "Less feed. More day." on the dark ember background.

## Privacy practices

**Single purpose:** Reduce distraction on social websites by hiding feeds and short-form video, and limiting the time spent on them.

**Permission justifications:**

| Permission | Why |
| --- | --- |
| `storage` | Saves your settings, windows, goals and daily time on your device. |
| `tabs` | Knows which website the active tab shows, to count time and apply its settings when you switch tabs. |
| `idle` | Earn goals count only time you're actually at the computer. |
| `alarms` | Resets limits at midnight and starts and ends windows on time. |
| `declarativeNetRequestWithHostAccess` | Blocks a website's pages, or its Shorts and Reels pages, when its limit or window says so. |
| `nativeMessaging` | Talks to the optional ScreenFry Mac app on the same computer (connection status, saving setups to its loadouts, reset requests). Nothing leaves the computer. |
| Host access (`<all_urls>`) | Hides feeds on the supported websites, and applies limits, windows and goals to other websites you add by name. Page text, messages and form fields are never read. |
| Remote code | None. All code ships in the package. Setups from the optional library are settings data (a share code), checked like a pasted code, never code. |

**Data usage:** ScreenFry collects nothing automatically. The only data that leaves the browser is what someone chooses to send through the optional setup library (off until turned on in Share → Library):
- the search words and filters they type;
- a setup they publish: its share code (limits, blocks, windows, earn goals, feed blocking, and the names of windows, goals and any websites they added), with a title, description and tags they write;
- upvotes and reports, with an anonymous per-install key (no name or email).

None of the form's categories fits a published setup exactly. The closest is **Website content**, because a setup names websites. Tick that and nothing else, and explain it in the justification below. Certify: not sold, not used for unrelated purposes, not used for creditworthiness. The privacy policy below describes the library in full.

**Justification for the network requests (if asked):** the optional setup library at `screenfry-library.bhron-site.workers.dev` (Cloudflare Workers). Only the settings page contacts it, and only after the user turns it on. There's no new permission: extension pages can fetch an HTTPS API, and the API sends CORS headers.

**Privacy policy URL:** https://github.com/yasserjaghoori/ScreenFry/blob/main/docs/PRIVACY.md

## Distribution

Start **Unlisted** for testing with the Mac app; switch to **Public** after the installer's two choices (docs/NEXT.md) are ready. Regions: all.
