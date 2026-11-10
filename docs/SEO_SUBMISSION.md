# SEO submission — do this AFTER the GitHub Pages site is live

The site itself carries the on-page SEO (title, meta description, Open Graph,
JSON-LD WebApplication + FAQPage schema, canonical, `robots.txt`,
`sitemap.xml` — all pointing at the Pages URL below). Search engines still
have to *discover and index* it: that part only happens through the steps
below, on accounts the site owner controls.

**Site URL:** https://abdulrehmansqae.github.io/dymo-label-xml-viewer/
**Sitemap:** https://abdulrehmansqae.github.io/dymo-label-xml-viewer/sitemap.xml

> Honest expectations: indexing typically takes a few days after submission.
> Ranking for competitive terms ("dymo label viewer", "dymo viewer") builds
> over weeks as the page earns visits and links. No step here — and no SEO
> service — can guarantee a #1 position. A page that is never submitted and
> has no links pointing to it may never appear at all.

## 1. Google Search Console

1. Go to https://search.google.com/search-console and sign in with the
   Google account that should own the site.
2. **Add property → URL prefix** → enter the site URL exactly:
   `https://abdulrehmansqae.github.io/dymo-label-xml-viewer/`
3. Verify ownership with the **HTML tag** method: Google shows a tag like
   `<meta name="google-site-verification" content="...">`.
   - In this repo, open `index.html`: there is a commented-out placeholder
     for exactly this tag near the top of `<head>`. Replace
     `PASTE_YOUR_VERIFICATION_CODE_HERE` with the code from Google,
     uncomment the tag, commit, push, and wait for the Pages workflow to
     redeploy (~1 minute).
   - Back in Search Console, click **Verify**.
4. **Sitemaps** (left menu) → enter `sitemap.xml` → **Submit**. Status
   should become "Success" within a day or so.
5. **URL Inspection** (top bar) → paste the homepage URL → after the test,
   click **Request Indexing**. Repeat once for the homepage only; there are
   no other pages.
6. Check back in **Pages** (Indexing) after a few days: the homepage should
   move from "Discovered/Crawled – currently not indexed" to "Indexed".

## 2. Bing Webmaster Tools

1. Go to https://www.bing.com/webmasters and sign in.
2. Easiest path: **Import from Google Search Console** (offered on the
   dashboard) — it copies the verified site and its sitemap.
   Or add the site manually and verify with the same HTML-tag method
   (Bing's tag is `msvalidate.01`; paste it next to the Google one in
   `index.html`, redeploy, verify).
3. **Sitemaps** → submit `https://abdulrehmansqae.github.io/dymo-label-xml-viewer/sitemap.xml`
   if the import didn't already.
4. **URL Submission** → submit the homepage URL once.

## 3. Links that help it get found

- This repo's README already links the Pages URL as the primary **Live
  demo** — once the repo is public, that alone gives the site a real
  inbound link from github.com.
- The Muse-hosted mirror of the app exists; treat the Pages URL as the one
  to share publicly (it is the canonical URL in the page, the sitemap, and
  the README), so search engines consolidate ranking signals on it.
- Share the Pages link wherever DYMO users actually ask "how do I view a
  .label file?" (DYMO forums, Reddit r/DYMO, lab/QA communities) — relevant
  links and real visits are what move ranking over time.

## 4. What NOT to expect / not to do

- Do not submit the muse.ai mirror URL to Search Console as the property —
  it is not a domain you control and its canonical points here anyway.
- Do not buy "SEO submission" services or bulk backlinks; they do not help
  a single-page tool and can harm it.
- If the URL changes later (e.g. a custom domain), update the canonical in
  `index.html`, `public/sitemap.xml`, `public/robots.txt`, and this file —
  they must all name the same URL.
