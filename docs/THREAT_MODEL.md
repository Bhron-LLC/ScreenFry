# Enforcement limits

ScreenFry is a browser productivity tool. It applies selected controls while the extension is enabled and has website access.

## Enforced in the product

- Full-site blocking at exhausted daily limits and outside enabled allowed windows.
- Independent feed/button choices, Shorts/Reels URL blocking and playback suppression in recognized short-form players.
- Optional password checks on all user mutations: site rules, windows, feed settings, preferences, password replacement/removal and reset.
- Web-page content scripts can report media status and request policy decisions; they cannot change settings.
- No temporary visits, PIN bypasses, commitment dates or queued changes.

## Browser and device boundaries

Users can disable/remove the extension, revoke website access, change profiles, use another browser, edit extension storage or change the system clock. The optional password protects in-product editing, not against someone who controls the device or its browser developer tools.

Chrome private browsing applies only with Allow in Incognito enabled. Safari requires Private Browsing and website permissions; its private-access status is an observation, not a continuous guarantee. Browser state is independent; Chrome and Safari do not share usage or passwords.

## Playback and measurement limits

Playback reporting reads HTML audio/video state, including muted video, and combines it with the browser's recent-audio flag. A site using inaccessible closed shadow roots, canvas players or otherwise opaque media can need additional support. A recent-audio flag may linger briefly after playback stops. Reports expire after 30 seconds; the normal heartbeat is one minute.

Recognized Shorts/Reels routes and player markup are blocked rather than rewritten. A video accessed through an ordinary watch/embed URL without any short-form metadata may be indistinguishable from a normal video. This implementation does not claim universal classification of every short video. Website markup changes can also break selectors; real-site regression testing remains necessary.

Long checkpoint gaps are capped at 90 seconds to avoid charging extended sleep/suspension. This can undercount real playback during an unusually long worker or system suspension. Chrome uses network/tab redirects. Safari renders a local modal notice and pauses media, avoiding stalled cross-scheme navigation; the underlying hidden document can still fetch resources. This is not a network firewall or proof of a data leak. Safari runtime behavior needs manual testing beyond compilation and isolated fixtures. TikTok's linked-video guard covers recognized direct video paths, player controls and SPA route changes; website markup changes or opaque players may require selector updates.

## Setup library

The opt-in setup library (`services/library`, [plan](SETUP_LIBRARY.md)) is the only server ScreenFry talks to.

- **Malicious setups:** a published setup is a share code. The server rebuilds it from settings checked by the same code as a paste, and the extension decodes and checks it again before showing the slides. A setup can only change limits, blocks, windows, goals and feed blocking, and only in the loadout the user picks, with the usual password gate. It can't run code or read anything.
- **Data leaks:** the `SF2-` format has no fields for usage, history or passwords, and the server re-encodes every code, dropping anything else. Names (windows, goals, added websites) do become public. The publish screen lists them first.
- **Spam and abuse:** each install has an anonymous P-256 key that signs writes. Limits are per address (not stored) and per key per day, with a cap on publishing for everyone. A word filter covers every name, and links aren't allowed in titles or descriptions. A setup is hidden after 3 reports from different keys, and an admin can restore or remove it, or block a key. Keys cost nothing to make, so someone determined can still publish spam or hide a setup with fake reports. Admin review and blocking are the backstop.
- **Upvotes** are one per key, so they can be inflated by making many keys. They only sort results.
- **Availability:** if the server is down or unreachable, only the Library tab is affected. The extension never contacts it from the background, popup or content scripts.

