# Aion 2 Craft Market

Which recipes pay, on your server, right now. Live at https://amazo197.github.io/aion2-craft/

Fork of https://github.com/shizukaziye/aion2-craft.

- Recipes and icons: the gamers4.life crafting graph (1,466 items, 2,442 recipes).
- Prices: aion2.exchange cheapest listings per server, plus the 28-day sales statistics the game publishes for materials and consumables.
- Cleared bands: for gear and accessories the game publishes no sales, so the bake infers what cleared from listings that vanished between 10-minute snapshots.
- Beyond kina/min, each recipe gets expected days to sell (Little's law), kina/day and ROI/day, the chance of loss and CVaR10 over the fail/plain/Splendent outcomes, and the break-even success rate.
- The Plan tab solves `max Σ profit·x` under a budget and an hours budget (LP dual). With a horizon in days it also caps each recipe by how fast the market clears it (turnover from days-to-sell), so the plan does not assume selling more than the market absorbs.

`tools/fetch_data.py` bakes everything into `data/` and runs hourly from GitHub Actions. Add server ids to `data/config.json` to track more servers; `history_servers` gets the cleared-band bake, which costs one request per recipe-relevant item.

Static page, no build step: `index.html`, `styles.css`, `app.js`, `model/craft.js`.
