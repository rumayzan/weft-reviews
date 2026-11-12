# WEFT product reviews feed for Google

Every day, `.github/workflows/feed.yml` reads the product reviews customers wrote on
[weftrug.com](https://weftrug.com), builds a Google Product Reviews feed (schema 2.4) with
`build-feed.mjs`, and publishes it here:

https://rumayzan.github.io/weft-reviews/google-product-reviews.xml

Google Merchant Center fetches that address on a schedule (Product reviews source: "Link to a file"), so new
reviews reach Google without any manual upload. `status.json` records the last run.

- Only public store data is read. Reviewer names are shortened to a first name and an initial, and links,
  e-mail addresses and phone numbers are removed from the text.
- If the new file would remove more than 5 of the reviews already published, or has none, the run stops
  and the published file stays as it is (GitHub e-mails the owner about the failed run). To publish anyway,
  run the workflow by hand with "force" ticked.
- To run it now: Actions > Google reviews feed > Run workflow.
