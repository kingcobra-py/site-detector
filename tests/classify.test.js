import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPage } from "../server/classify.js";
import { extractUrlCandidates, groupResults, parseUrlList } from "../server/detect.js";
import { isPrivateIp, normalizeUrl } from "../server/fetchPage.js";

function page(title, extra = "") {
  return {
    url: "https://shop.example/",
    html: `<html><head><title>${title}</title><meta name="description" content="${title}"></head><body>${extra}</body></html>`,
  };
}

describe("classifyPage", () => {
  it("groups gift cards, video games, Xbox, Apple, CD keys, and top-up together", () => {
    const gift = classifyPage(page("Buy Steam gift cards and Xbox gift cards"));
    const apple = classifyPage(page("Apple Gift Card and iTunes gift cards"));
    const xbox = classifyPage(page("Xbox Game Pass and Xbox gift card store"));
    const games = classifyPage(page("Buy video games and PC games digital download"));
    const keys = classifyPage(page("Cheap CD keys and Steam game keys instant delivery"));
    const topup = classifyPage(page("Game top-up for Mobile Legends and PUBG UC"));
    assert.equal(gift.group.id, "digital_goods");
    assert.equal(apple.group.id, "digital_goods");
    assert.equal(xbox.group.id, "digital_goods");
    assert.equal(games.group.id, "digital_goods");
    assert.equal(keys.group.id, "digital_goods");
    assert.equal(topup.group.id, "digital_goods");
  });

  it("detects gift-card and video-game shops in other languages", () => {
    const french = classifyPage(page("Cartes cadeaux Apple et jeux vidéo", "Clé Steam et boutique de jeux numériques."));
    const spanish = classifyPage(page("Tarjetas de regalo Xbox y videojuegos", "Clave de juego y recarga de juegos."));
    const german = classifyPage(page("Geschenkkarten und Videospiele kaufen", "Steam Spielkey und Produktschlüssel."));
    const arabic = classifyPage(page("بطاقة هدية أبل", "شحن الألعاب ومفتاح ستيم."));
    const chinese = classifyPage(page("苹果礼品卡", "游戏密钥和游戏充值。"));
    const russian = classifyPage(page("Подарочная карта Xbox", "Видеоигры и ключи Steam."));
    assert.equal(french.group.id, "digital_goods");
    assert.equal(spanish.group.id, "digital_goods");
    assert.equal(german.group.id, "digital_goods");
    assert.equal(arabic.group.id, "digital_goods");
    assert.equal(chinese.group.id, "digital_goods");
    assert.equal(russian.group.id, "digital_goods");
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

  it("accepts more than 40 URLs", () => {
    const text = Array.from({ length: 41 }, (_, i) => `https://shop${i}.example`).join("\n");
    const { urls } = parseUrlList(text);
    assert.equal(urls.length, 41);
  });

  it("pulls http URLs out of an HTML dump instead of treating every word as a URL", () => {
    const html = `<!DOCTYPE html><html><body><a href="https://www.airalo.com/">eSIM</a> and https://contabo.com extra words</body></html>`;
    const candidates = extractUrlCandidates(html);
    assert.ok(candidates.every((item) => item.startsWith("http")));
    const { urls } = parseUrlList(html);
    assert.deepEqual(urls, ["https://www.airalo.com/", "https://contabo.com/"]);
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
