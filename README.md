# Data Entry Bot

Opens the Online Data Portal in Chrome, reads each website, fills the form, and logs every entry.

## Set up (once)

1. Install Node.js 20.12 or newer, and Google Chrome.
2. In VS Code, open this folder, then open the terminal and run:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` (`cp .env.example .env`) and put a free Groq key in it (get one at https://console.groq.com):
   ```
   GROQ_API_KEY=gsk_...
   ```
   (Without a key the bot still runs in review mode, but you choose Kind of Business yourself.
   A paid Claude key also works: set `ANTHROPIC_API_KEY` instead and leave the Groq line empty.)

## Run

```
npm start
```

Open **http://localhost:3000** and click **Start working**.

1. Chrome opens the portal. **The first time, log in yourself.** The login is saved in `browser-profile/` and the bot never sees your password.
2. For each website the portal shows, the bot opens the site, reads the Home, Contact, About and Product pages, and fills the form.
3. **Review mode (default):** you check the form in Chrome and click **submit**. The bot clicks OK on the "Record Updated" popup and moves on.
   **Auto mode:** the bot submits by itself, but only when everything was verified. Anything doubtful waits for you.

Every entry is saved in `output/results.csv` (opens in Excel). `output/results.jsonl` has the evidence for each entry, and `output/screens/` has a screenshot of each site.

## How it decides

| Step | How |
|---|---|
| Website Status | Site does not open / blank / parked or for-sale page → Not Working. Expired → Domain Expired. Under construction, Flash, not English → those statuses. |
| Kind of Business | AI (Groq by default) reads the page text and picks one of the portal's kinds. |
| Status from Kind | Manufacturer, Industrial Services, Exporter, Trader, Distributer, Supplier, Wholesaler → **Working**. Service Provider, Online Shopping, Restricted Site, Other → **Not Working** (all other fields left empty / N / 0). |
| Email, phone | Plain code finds every email and number on the pages. The AI may only choose one of those. |
| Country | USA / UK rules applied. Needs a quote that really appears on the pages. |
| Phone format | Spaces removed: `+44 1554 779090` → `+441554779090`. |
| Address, City, State, Company Profile | Y only when the text is really on the pages, otherwise N. |
| Name / Image / Desc of Prod | Counts 0-3. A product counts only if its name is written on the pages. |

**Nothing is guessed.** If the AI returns an email, number, country or product that is not on the pages, the bot drops it, flags the site, and (in auto mode) leaves it for you instead of submitting.

## Things to know

- **Check that your account may use automation.** Some data-entry portals do not allow it. Use review mode until you are sure. Auto mode submits real entries under your account.
- **Country:** England, Scotland, Wales, Northern Ireland and Great Britain are also written as `UK`. Change this in `src/rules.js` (`COUNTRY_MAP`) if you do not want that.
- **Parked / for-sale domains** are entered as Not Working. Change with `PARKED_STATUS` in `.env`.
- **Redirects** are not a status by default. Set `REDIRECT_AS_STATUS=true` to use "Redirect Site".
- **Image counts are approximate.** The bot checks image names and alt text against product names.
- If the portal changes its form, only `src/portal.js` needs updating.
- **Groq free tier has limits** (requests and text per minute). The bot waits and retries when Groq says slow down. If Groq reports "too large", lower `AI_MAX_CHARS` in `.env` (for example 10000). Free models make more mistakes than paid ones, so expect more sites marked "needs you".
- Safety stops: the bot stops if the portal shows the same URL twice, if a submit is not confirmed, or if you press Stop.

## Files

```
src/server.js     control page + API (only reachable from this computer)
src/worker.js     the loop: portal -> website -> extract -> fill -> submit -> log
src/visitor.js    opens websites with Chrome, decides Website Status
src/extractor.js  finds emails/phones in code, asks the AI, verifies every answer
src/rules.js      USA/UK, phone format, Kind -> Status table
src/portal.js     reads and fills the portal form
public/index.html the control page
test/             unit tests + end-to-end test against a mock portal (npm test)
```

## Tests

```
npm test
```
