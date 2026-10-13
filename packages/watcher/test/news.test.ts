// [sunshine:watcher]
import { describe, expect, it } from "vitest";
import { decodeEntities, editionParams, fetchHeadlines, googleNewsUrl, parseRss } from "../src/news.js";
import { feeds, publicLookup } from "./helpers.js";

describe("Google News feeds", () => {
  it("knows the editions people here read, and any language-COUNTRY pair", () => {
    expect(editionParams("no-NO")).toEqual({ hl: "no", gl: "NO", ceid: "NO:no" });
    expect(editionParams("en-GB")).toEqual({ hl: "en-GB", gl: "GB", ceid: "GB:en" });
    expect(editionParams("de-DE")).toEqual({ hl: "de", gl: "DE", ceid: "DE:de" });
    for (const bad of ["norway", "NO", "en_us", ""]) expect(editionParams(bad), bad).toBeUndefined();
  });

  it("asks for the last day only, in the chosen edition", () => {
    const url = new URL(googleNewsUrl("SK Brann", "no-NO"));
    expect(url.host).toBe("news.google.com");
    expect(url.searchParams.get("q")).toBe("SK Brann when:1d");
    expect(url.searchParams.get("ceid")).toBe("NO:no");
  });

  it("reads items: entities, CDATA, the source, and drops the ' - Source' suffix", () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Brann signs striker &amp; more - Bergens Tidende]]></title><link>https://news.google.com/rss/articles/A1</link>
        <pubDate>Tue, 13 Oct 2026 08:00:00 GMT</pubDate><source url="https://bt.no">Bergens Tidende</source></item>
      <item><title>Taylor Swift adds Oslo date - NRK</title><link>https://news.google.com/rss/articles/B2</link></item>
      <item><title>No link here</title></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;
    expect(parseRss(xml)).toEqual([
      { title: "Brann signs striker & more", link: "https://news.google.com/rss/articles/A1", source: "Bergens Tidende", publishedAt: "2026-10-13T08:00:00.000Z" },
      { title: "Taylor Swift adds Oslo date", link: "https://news.google.com/rss/articles/B2", source: "NRK" },
    ]);
    expect(decodeEntities("&#248;l &#x26; br&oslash;d")).toBe("øl & br&oslash;d");
  });

  it("fetches a search through the public-host guard and tags each headline", async () => {
    const { fetchImpl, urls } = feeds({ "SK Brann": [{ title: "Brann wins", link: "https://news.google.com/a", source: "NRK" }] });
    const got = await fetchHeadlines({ topic: "Brann, the Bergen football club", query: "SK Brann", edition: "no-NO" }, { fetchImpl, lookup: publicLookup });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ title: "Brann wins", topic: "Brann, the Bergen football club", edition: "no-NO" });
    expect(urls[0]).toContain("ceid=NO%3Ano");
  });

  it("says plainly when a feed fails", async () => {
    const { fetchImpl } = feeds({ "SK Brann": 503 });
    await expect(fetchHeadlines({ topic: "Brann", query: "SK Brann", edition: "no-NO" }, { fetchImpl, lookup: publicLookup })).rejects.toThrow(/HTTP 503/);
  });
});
