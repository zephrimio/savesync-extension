# SaveSync Bookmarks

One-click export of your **X / Twitter**, **RedNote (小红书)**, and **YouTube Watch Later** bookmarks to a JSON file on your own computer.

No account. No uploads. No backend middleman.

> The Chrome Web Store listing is at **(coming soon)**. Meanwhile, you can run this as an unpacked extension — see below.

## How it works

You're already signed in to X, RedNote, and YouTube in your browser. The extension runs entirely inside those pages, reads the bookmarks / saved list you can already see, and hands you a portable JSON file. Nothing is sent anywhere.

- **X**: calls X's own `/i/api/graphql/Bookmarks` GraphQL endpoint from your open X tab, using the same session tokens X.com's own JavaScript uses.
- **RedNote**: reads the hydrated Pinia store on your profile page.
- **YouTube**: reads `ytInitialData` from an open YouTube tab and scrolls the Watch Later list to lazy-load more rows.

Output shape:

```json
{
  "x": {
    "platform": "x",
    "fetched_at": "2026-04-19T10:23:00.000Z",
    "count": 60,
    "bookmarks": [
      { "id": "...", "author": "...", "text": "...", "media": [...], ... }
    ]
  }
}
```

When "All three" is selected, the top-level object has one key per platform.

## Install (unpacked, for now)

1. Clone this repo.
2. Open `chrome://extensions` in Chrome, Edge, or Brave.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and pick this directory.
5. Pin the **SaveSync Bookmarks** action for quick access.

## Usage

1. Make sure you're signed in on the relevant platform in a Chrome tab:
   - **X** — any `x.com` tab with a valid session.
   - **RedNote** — your profile page at `xiaohongshu.com/user/profile/<id>`.
   - **YouTube** — any `youtube.com` tab while signed in.
2. Click the extension icon, pick a platform + item count, and hit **Fetch & download JSON**.
3. The JSON lands in your Downloads folder as `savesync-bookmarks-<platform>-<timestamp>.json`.

## Permissions — what they're for

| Permission | Why it's needed |
|---|---|
| `scripting` | Injects the bookmark-reading script into the five supported sites only. |
| `downloads` | Saves the resulting JSON to your local Downloads folder. |
| `tabs` | Reads the URL of the active tab to pick the right scraper and find a logged-in tab on the target site. |
| `storage` | Remembers your last-used UI preferences. Stays on-device. |
| `host_permissions` | Limited to x.com, twitter.com, xiaohongshu.com, rednote.com, youtube.com. |

The extension does **not** request the `cookies` permission and never transmits any data off your device. See the [privacy policy](https://savesync-api.vercel.app/privacy) for the full breakdown.

## Limits

- **X**: the Bookmarks endpoint starts returning empty pages after ~800 items.
- **RedNote**: whatever Pinia has hydrated for `user.notes[1]` — typically the first SSR page.
- **YouTube**: capped by how far the extension can scroll the Watch Later list before the DOM stops growing.

## Optional: a place to put the JSON

If you want a searchable library instead of a JSON file sitting in Downloads, SaveSync also has an iOS app and a web uploader at <https://savesync-api.vercel.app>. Sign in with Apple, drop the JSON on the uploader, and it lands in your personal library — image-cached for RedNote so thumbnails stop expiring. Both are optional; the extension works standalone.

## Contributing

Issues and PRs welcome. The code is small on purpose — one `background.js` with a per-platform scraper, one popup, a manifest. No bundler, no build step.

## License

MIT — see [LICENSE](LICENSE).
