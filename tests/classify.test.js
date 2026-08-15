import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPage } from "../server/classify.js";
import { groupResults, parseUrlList } from "../server/detect.js";
import { isPrivateIp, normalizeUrl } from "../server/fetchPage.js";

function page(title, extra = "") {
  return {
    url: "https://shop.example/",
    html: `<html><head><title>${title}</title><meta name="description" content="${title}"></head><body>${extra}</body></html>`,
  };
}

describe("classifyPage", () => {
  it("groups gift cards, game keys, CD keys, and top-up together", () => {
    const gift = classifyPage(page("Buy Steam gift cards and Xbox gift cards"));
    const keys = classifyPage(page("Cheap CD keys and Steam game keys instant delivery"));
    const topup = classifyPage(page("Game top-up for Mobile Legends and PUBG UC"));
    assert.equal(gift.group.id, "digital_goods");
    assert.equal(keys.group.id, "digital_goods");
    assert.equal(topup.group.id, "digital_goods");
  });

  it("detects eSIM stores", () => {
    const result = classifyPage(page("Travel eSIM data plans", "Activate eSIM with QR code. Airalo alternative."));
    assert.equal(result.group.id, "esim");
  });

  it("detects clothing stores", () => {
    const result = classifyPage(page("Streetwear clothing boutique", "Hoodies, jeans, sneakers, and new apparel arrivals."));
    assert.equal(result.group.id, "clothing");
  });

  it("detects VPS and server hosts", () => {
    const result = classifyPage(page("Cloud VPS hosting", "Linux VPS, dedicated servers, KVM VPS, NVMe VPS."));
    assert.equal(result.group.id, "hosting");
  });

  it("detects casino and gambling sites", () => {
    const result = classifyPage(page("Online casino and sportsbook", "Slots, roulette, blackjack, live dealer, place a bet."));
    assert.equal(result.group.id, "gambling");
  });

  it("detects donation pages", () => {
    const result = classifyPage(page("Donate now to our charity", "Make a donation. Tax-deductible fundraising nonprofit."));
    assert.equal(result.group.id, "donation");
  });

  it("returns unknown when nothing matches", () => {
    const result = classifyPage(page("Personal blog about hiking trails"));
    assert.equal(result.group.id, "unknown");
  });
});

describe("normalizeUrl", () => {
  it("adds https when missing", () => {
    assert.equal(normalizeUrl("example.com"), "https://example.com/");
  });

  it("rejects private hosts", () => {
    assert.throws(() => normalizeUrl("http://127.0.0.1"), /not allowed/);
    assert.throws(() => normalizeUrl("http://localhost"), /not allowed/);
  });
});

describe("parseUrlList", () => {
  it("splits lines, commas, and spaces, then dedupes", () => {
    const { urls, invalid } = parseUrlList(
      "eneba.com\nhttps://airalo.com, gap.com gap.com\nhttp://127.0.0.1",
    );
    assert.deepEqual(urls, [
      "https://eneba.com/",
      "https://airalo.com/",
      "https://gap.com/",
    ]);
    assert.equal(invalid.length, 1);
    assert.match(invalid[0].error, /not allowed/);
  });

  it("rejects more than 40 URLs", () => {
    const text = Array.from({ length: 41 }, (_, i) => `https://shop${i}.example`).join("\n");
    assert.throws(() => parseUrlList(text), /At most 40/);
  });
});

describe("groupResults", () => {
  it("puts URLs into seller groups", () => {
    const grouped = groupResults(
      [
        { requestedUrl: "https://eneba.com/", group: { id: "digital_goods", label: "Digital" } },
        { requestedUrl: "https://airalo.com/", group: { id: "esim", label: "eSIM" } },
        { requestedUrl: "https://gap.com/", group: { id: "clothing", label: "Clothes" } },
      ],
      [{ url: "https://bad.example/", error: "timeout" }],
    );
    assert.equal(grouped.ok, 3);
    assert.equal(grouped.failed, 1);
    assert.equal(grouped.groups.find((g) => g.id === "digital_goods").items.length, 1);
    assert.equal(grouped.groups.find((g) => g.id === "esim").items[0].requestedUrl, "https://airalo.com/");
    assert.equal(grouped.groups.find((g) => g.id === "hosting").items.length, 0);
  });
});

describe("isPrivateIp", () => {
  it("allows public IPv4 and IPv6, including Cloudflare 172.66", () => {
    assert.equal(isPrivateIp("104.20.23.154"), false);
    assert.equal(isPrivateIp("172.66.147.243"), false);
    assert.equal(isPrivateIp("2606:4700:10::6814:179a"), false);
  });

  it("blocks loopback, RFC1918, and link-local", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("10.0.0.8"), true);
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("169.254.169.254"), true);
    assert.equal(isPrivateIp("::1"), true);
  });
});
