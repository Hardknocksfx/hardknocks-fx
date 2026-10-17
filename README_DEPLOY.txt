HARDKNOCKS FX - NETLIFY DEPLOYMENT NOTES

Included:
- public/index.html: dashboard frontend
- server.js: your Express API, adapted to export the app for serverless use
- netlify/functions/api.js: Netlify Function adapter
- netlify.toml: API rewrite and deploy configuration
- package.json: dependencies

DEPLOY:
1. Upload/push the contents of this folder to the Git repository connected to Netlify.
2. In Netlify Project configuration > Environment variables, set:
   JSONBIN_BIN_ID = your JSONBin bin ID
   JSONBIN_MASTER_KEY = your JSONBin master key
   Make sure the variables are available to Functions. Never put the master key in frontend code or commit it.
3. Trigger a new deploy after setting the environment variables.
4. Test:
   https://YOUR-SITE.netlify.app/api/health
   https://YOUR-SITE.netlify.app/api/signals
   https://YOUR-SITE.netlify.app/api/signals/live
   https://YOUR-SITE.netlify.app/api/track-record

Expected:
- /api/health returns JSON with status "Online".
- /api/signals returns JSON with success:true and signals:[...].
- If JSONBin credentials are absent/incorrect, signal endpoints return HTTP 500 and Netlify function logs will show the backend error.

IMPORTANT:
- Netlify Functions are serverless; setInterval is not a reliable scheduler there.
  The pending-expiration timer only runs for local node server mode in this adaptation.
  If automatic expiry must run on Netlify, add a Netlify Scheduled Function or
  trigger expiry checks during API requests.
- The market-price endpoint currently marks trades based on sampled prices. It cannot
  prove whether TP or SL was hit first between price updates. For reliable trade outcomes,
  use broker/tick/candle data and a proper execution/lifecycle model.
- Review your existing order-type trigger logic before live trading. The current
  pending BUY/SELL rules are not correct for every limit/stop order.
