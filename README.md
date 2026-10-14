# TubeLens — YouTube viewing insights

A responsive, YouTube-inspired analytics dashboard built with HTML, CSS, vanilla JavaScript, Chart.js, a browser Web Worker, Express, and Google's official `googleapis` Node client.

**Not affiliated with YouTube or Google.** This is an independent community project.

## What it does

- Imports Google Takeout's `watch-history.json` and computes the viewing analytics **in the browser**.
- Shows watch-event and unique-video counts, creators by activity, monthly trends, daily activity, weekday/hour heatmaps, repeat watches, recurring viewing sessions, peak days/hours, and creator rabbit-hole patterns.
- Lets you filter the visualisations by the whole export, the last 12 months, 90 days, or 30 days relative to the newest event in the export.
- Separates likely music plays from other videos using local signals (YouTube Music source metadata, “- Topic” and VEVO channel names, and music-specific title markers). The global All content / Regular videos / Music selector filters the whole dashboard. Use Review music labels to override a channel classification; these overrides are held in memory for the current tab only.
- Optionally connects a Google account through a server-side OAuth flow and retrieves the user's YouTube subscriptions using read-only access. It compares channel IDs when possible and channel names as a fallback to identify the most-watched subscribed channel.
- Includes sample data so the UI can be explored before importing any personal data.
- Supports dark and light themes and mobile layouts.

### Important data limitations

The YouTube Data API does **not** provide an authenticated user's personal watch-history feed. The dashboard therefore gets watch events from the user's own Google Takeout export, not from the YouTube API. The YouTube Data API integration retrieves subscriptions only. See the official [Subscriptions: list documentation](https://developers.google.com/youtube/v3/docs/subscriptions/list) and Google's [Takeout activity export format](https://github.com/google/takeout/blob/main/README.md).

A Takeout watch-history entry records a viewing event; it does not reliably provide how long the viewer watched. TubeLens deliberately reports **watch events**, not hours watched or total watch time. It also cannot recover entries missing from the export, deleted history, or videos that were not included by Google Takeout. Channel matching may be incomplete if a channel's identity/name changed or the export lacks channel metadata. Music classification is necessarily heuristic: the current Takeout fields and the existing subscription integration do not provide a universal Official Artist Channel flag or video category for every past view. Some music may be missed and some titles may be false positives; users can override labels locally.

## Requirements

- Node.js 20 or newer
- A Google Cloud project only if you want to connect your subscriptions
- A modern browser with Web Worker support

## Run locally

1. Extract the project folder and open a terminal in it.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env`.

   **To use demo data and import watch history, OAuth credentials are optional.** You can skip the next setup steps and run the app immediately.

4. To connect subscriptions, configure Google OAuth:
   - Open the [Google Cloud Console](https://console.cloud.google.com/).
   - Create/select a project and enable **YouTube Data API v3**.
   - Configure the OAuth consent screen. While the app is in testing, add the Google account you will use as a test user.
   - Create an **OAuth client ID** of type **Web application**.
   - Add this exact authorised redirect URI: `http://localhost:3000/auth/google/callback`
   - Copy the client ID and client secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Keep the secret on the server; never put it in frontend JavaScript.
   - Leave `GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback` for local development.

   The app requests only `https://www.googleapis.com/auth/youtube.readonly`, and the server uses it to fetch the authenticated user's subscription list. Google may require additional OAuth consent-screen configuration or verification before a public production launch, depending on the final audience and configuration.

5. Start the app:

   ```bash
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000).

For local development with Node's watch mode, run `npm run dev` (on Windows, `npm run dev` may need a shell that supports the environment assignment; `npm start` works without it).

## Import watch history

1. Open [Google Takeout](https://takeout.google.com/).
2. Deselect everything, then select **YouTube and YouTube Music**.
3. In the YouTube export options, include **history** and choose JSON format where available.
4. Create/download the export and extract the ZIP.
5. Select `Takeout/YouTube and YouTube Music/history/watch-history.json` in TubeLens.

Exports can vary slightly. Select the JSON file whose contents are a list of activity records with fields such as `title`, `titleUrl`, `subtitles`, and `time`.

TubeLens parses the selected file inside a browser Web Worker and sends only calculated aggregates to the page's UI thread. **The watch-history file is not sent to the Express server, Google, or any third-party analytics service.** Data exists only in the active page/worker memory; refreshing or closing the tab clears it, so select the file again for a new session. The starter app limits imports to 250 MB and 1 million top-level records. If your export exceeds these limits, work with a smaller JSON file or filter the export locally before importing it.

Chart.js and Google Fonts are loaded from public CDNs, so a network connection is required for those assets. No chart data or history file is sent to those CDNs.

## Endpoints

- `GET /auth/google` — begins Google OAuth
- `GET /auth/google/callback` — validates OAuth state and creates an ephemeral server session
- `GET /api/status` — reports whether a session is connected and whether credentials are configured
- `GET /api/subscriptions` — returns the authenticated account's subscriptions, cached in memory for five minutes
- `POST /auth/logout` — attempts to revoke Google credentials and destroys the current in-memory session
- `GET /health` — basic health check

## Privacy policy

The app serves its privacy policy at `/privacy.html` and links to it from the homepage and the subscription-connection area. Before making the site public, replace `[REPLACE WITH YOUR CONTACT EMAIL]` in `public/privacy.html` with a monitored address, and confirm that the policy continues to match the deployed code and hosting configuration. The policy describes the current implementation: browser-only watch-history processing, read-only subscription retrieval, in-memory OAuth sessions/cache, CDN assets, and the disconnect/revocation flow.

## Privacy and security notes

- OAuth tokens remain server-side and are not returned to the browser.
- The imported viewing history remains in the browser and is not uploaded to the server.
- OAuth sessions and subscription cache are held in memory and expire; restarting the server clears them.
- The history importer limits file size and record count, filters to recognised YouTube video URLs, and escapes imported text before displaying it.
- The server uses Helmet security headers, rate-limits authentication/API routes, and uses an HTTP-only, `SameSite=Lax` session cookie. Set `COOKIE_SECURE=true` only when HTTPS is configured.

**This is a starter project, not a production-hardened multi-user deployment.** Before making it public, use HTTPS, replace the in-memory session/cache Maps with a secure server-side store, define a privacy policy and retention/deletion process, configure OAuth consent/verification as required, review Google's current API Services User Data Policy and branding requirements, and test session handling behind your deployment's proxy. Never commit `.env`.

## Checks

```bash
npm run check
```

This performs JavaScript syntax checks for the server, app, and history worker.


## Progressive list views

List cards show a compact four-item preview. Choose **Show more** to reveal up to eight items in the card, then **Show all** to open the searchable, paginated details panel. The panel supports keyboard dismissal (Escape), outside-click dismissal, and pagination for large subscription lists. Creator, daily, monthly, and heatmap cards also provide detail links so they can be explored without making the dashboard page excessively long. The frontend retains up to 120 top-video and repeat-video entries for responsive rendering; the full subscription list returned by the app is browsable in the modal.
