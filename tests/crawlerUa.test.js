/**
 * utils/crawlerUa.js: which user agents get no ad session. Every string here is a
 * real one from the checker's access log (2026-11-09/10), versions left as seen.
 */
const { isCrawlerUa } = require('../utils/crawlerUa');

describe('crawlers that ran the player and took ad sessions', () => {
  test.each([
    ['Applebot', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)'],
    ['Googlebot smartphone', 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['GoogleOther', 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 (compatible; GoogleOther)'],
    ['GoogleOther bare', 'GoogleOther'],
    ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['meta-webindexer bare', 'meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'],
    ['meta-webindexer in a browser string', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))'],
    ['meta-externalads', 'meta-externalads/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'],
    ['Baiduspider-render', 'Mozilla/5.0 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)'],
    ['Bytespider (no version, no URL)', 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)'],
    ['TikTokSpider', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; TikTokSpider; ttspider-feedback@tiktok.com)'],
    ['ShapBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/1.0'],
    ['Lightpanda ShapBot', 'Lightpanda/1.0 ShapBot/1.0'],
    ['bingbot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36'],
    ['Sogou', 'Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)'],
    ['Sogou bare', 'Sogou web spider/4.0'],
    ['OAI-SearchBot', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot'],
    ['Reflectionbot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Reflectionbot/1.0; +https://reflection.ai/bot) Chrome/120.0.0.0 Safari/537.36'],
    ['DuckAssistBot', 'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)'],
    ['Google-Read-Aloud', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)'],
    ['HeadlessChrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36'],
    ['curl', 'curl/8.5.0'],
  ])('%s', (_name, ua) => {
    expect(isCrawlerUa(ua)).toBe(true);
  });
});

describe('people keep their ads', () => {
  test.each([
    ['desktop Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'],
    ['Android Chrome', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'],
    ['Android WebView', 'Mozilla/5.0 (Linux; Android 16; SM-A546E Build/BP4A.251205.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36'],
    ['iPhone Chrome', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1'],
    ['Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0'],
    ['Opera on Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 OPR/93.0.0.0'],
    // A phone brand with "bot" in its name: why there is no bare /bot/.
    ['CUBOT phone', 'Mozilla/5.0 (Linux; Android 13; CUBOT P80 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'],
    // A plain browser string from a scraper is the datacenter gate's job, not this one's.
    ['plain Linux Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'],
  ])('%s', (_name, ua) => {
    expect(isCrawlerUa(ua)).toBe(false);
  });

  test('a missing user agent is not treated as a crawler', () => {
    expect(isCrawlerUa(undefined)).toBe(false);
    expect(isCrawlerUa('')).toBe(false);
    expect(isCrawlerUa(null)).toBe(false);
  });
});
