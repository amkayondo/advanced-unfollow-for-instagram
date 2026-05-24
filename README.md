# Advanced Unfollow for Instagram

Browser-console script for reviewing the accounts you follow, identifying non-followers, and unfollowing selected accounts with built-in pauses and safety limits.

## What it does

- Scans the accounts you follow
- Detects which of them follow you back
- Lets you filter by non-followers, followers, verified accounts, and private accounts
- Supports search, pagination, CSV export, and whitelisting
- Unfollows selected accounts with delays, cooldowns, retry handling, and a daily cap

## Requirements

- A logged-in Instagram session in your browser
- A modern desktop browser with Developer Tools
- The script from `/home/runner/work/advanced-unfollow-for-instagram/advanced-unfollow-for-instagram/instagram.js`

## How to use

1. Open `https://www.instagram.com/` and make sure you are logged in.
2. Open your browser Developer Tools.
3. Go to the **Console** tab.
4. Copy the full contents of `instagram.js`.
5. Paste the script into the console and run it.
6. Click **SCAN**.
7. Wait for the script to load your followers and following lists.
8. Review the results:
   - Use the filters on the left
   - Search by username
   - Select accounts manually, by page, or by the first N results
9. Optionally:
   - Add selected accounts to the whitelist so they are excluded
   - Export the current filtered list as CSV
10. Click **UNFOLLOW** and confirm to start the unfollow session.

## Interface notes

- **Non-followers** are shown by default after scanning
- **Followers too** includes mutual follows in the results
- **Whitelist** is stored in browser local storage and persists between runs
- **Today's unfollows** tracks the current day's total in browser local storage
- **Pause** pauses scanning so you can resume without starting over

## Guidelines

- Review selections carefully before unfollowing; the action is not automatically reversible.
- Start with a small batch before trying larger selections.
- Keep important accounts in the whitelist.
- Avoid running repeated sessions back to back.
- If Instagram rate-limits requests or the script stops after repeated failures, wait before trying again.
- Respect the built-in daily limit and cooldowns; they exist to reduce account risk.
- Use the CSV export if you want a record of the accounts currently shown in the filtered list.
- Run the script only while logged into your own account and only on `instagram.com`.

## Safety behavior already built in

- Retries failed follow-list fetches with backoff
- Adds delays between fetches and unfollows
- Pauses after each unfollow batch
- Stops when the daily unfollow limit is reached
- Stops early on rate limiting or repeated failures

## Project files

- `instagram.js` — the main script

## Disclaimer

Use this at your own risk. Instagram can change its private endpoints, UI behavior, and rate limits at any time.
