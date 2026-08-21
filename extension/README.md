# Real Estate Booster Capture — Chrome extension

Captures land listings from ANY page you're viewing (real-estate portals, Facebook group posts) into your local Real Estate Booster database. No scraping bots, no ban risk — you browse, it saves.

## Install (once)

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `extension` folder
4. Pin the icon (puzzle icon → pin "Real Estate Booster Capture")

## Use

Two shortcuts (make sure the app is running: `npm start` → http://localhost:3210):

**Alt+S — capture the page.** Opens the popup pre-filled with whatever it could parse (price, size, coordinates from map embeds). **If coordinates were found it saves automatically** — the popup shows "Auto-saved ✓" with the computed road distance and future price; edit any field and press Save to update the same record. Without coordinates, fill what's missing and press Save.

**Alt+D — capture selected text.** Select the interesting part of a page (e.g. a Facebook post body), press Alt+D — it parses price/size/phone/coordinates from the selection and **saves directly, no popup**. Watch the extension icon badge: **✓** saved, **?** nothing selected, **!** failed (server not running?).

After changing the extension files, reload it: `chrome://extensions` → ⟳ on the extension card.

**If Alt+D doesn't react**: Chrome reserves Alt+D for the address bar and may refuse to bind it. Go to `chrome://extensions/shortcuts` and assign the "Capture the selected text" command manually (e.g. Alt+X or Ctrl+Shift+D).

Works best on: halooglasi.com (exact coordinates!), 4zida.rs, estitor.com, 2home.me, and any site with structured data. On Facebook it grabs the post text — fill in price/size by hand.

Without coordinates the app can't compute road distance — you can add lat/lon later in the Land database page (right-click the spot in Google Maps → "What's here?" → copy the numbers).
