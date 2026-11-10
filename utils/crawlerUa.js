/**
 * Is this user agent an automated client rather than a person's browser?
 *
 * Used by POST /m/session (routes/adServe.js) so crawlers that render watch pages
 * are not handed ads. Measured 2026-11-09/10: Meta's indexers, Applebot, Googlebot,
 * Bytespider, Baiduspider-render, AhrefsBot and others ran the player, took ad
 * sessions and recorded thousands of "impressions" with no play behind them. That
 * dilutes every real creator's share of the pool and inflates what an advertiser
 * is told was delivered.
 *
 * Deliberately narrow: only agents that SAY they are automated. A plain browser
 * string from a scraper is the datacenter gate's job (utils/datacenterIp.js), not
 * this one's. Things this must NOT match, and the tests pin:
 *   - phone models with "bot" in the name (CUBOT, Robotics...), so no bare /bot/;
 *   - a missing user agent: real traffic never had one, and treating it as a
 *     crawler would also catch server-side callers we have not looked at.
 */
const PATTERNS = [
  // The contact URL crawlers put in their agent ("+http://www.google.com/bot.html",
  // "+https://developers.facebook.com/docs/sharing/webmasters/crawler"). No browser
  // sends one.
  /\+https?:\/\//i,
  // "Googlebot/2.1", "AhrefsBot/7.0", "bingbot/2.0", "ShapBot/1.0", "Baiduspider-render/2.0".
  /[a-z]*(?:bot|spider|crawler)(?:-[a-z]+)?\/\d/i,
  // "(compatible; Bytespider; ...)": a crawler token inside the compatible block.
  /compatible;[^)]*(?:bot|spider|crawler|indexer)\b/i,
  // Named agents that carry none of the above, plus headless browsers and HTTP libraries.
  /facebookexternalhit|meta-(?:webindexer|externalagent|externalads|externalfetcher)|google-(?:read-aloud|inspectiontool|extended)|googleother|headlesschrome|phantomjs|chrome-lighthouse|python-requests|python-urllib|aiohttp|scrapy|go-http-client|^curl\/|^wget\//i,
];

function isCrawlerUa(ua) {
  if (typeof ua !== 'string' || !ua) return false;
  return PATTERNS.some((re) => re.test(ua));
}

module.exports = { isCrawlerUa };
