const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const parser = new Parser();

app.use(cors());
app.use(express.json());

const configDir = path.resolve(__dirname, "config");
const sourcesPath = path.join(configDir, "sources.json");
const signalsPath = path.join(configDir, "signals.json");

let cachedNews = [];
let cachedSignals = [];
let sources = [];
let signalRules = [];

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (error) {
    console.error("Failed to write config file", filePath, error);
    return false;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "news.ycombinator.com";
  }
}

function toRelativeTime(dateValue) {
  if (!dateValue) return "just now";

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "just now";

  const diffMinutes = Math.max(1, Math.floor((Date.now() - date.getTime()) / 60000));

  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function scoreFromText(text, seed = 0) {
  const chars = `${text}-${seed}`;
  let sum = 0;

  for (let i = 0; i < chars.length; i += 1) {
    sum = (sum + chars.charCodeAt(i) * (i + 1)) % 1000;
  }

  return 20 + (sum % 480);
}

function commentsFromText(text, seed = 0) {
  const score = scoreFromText(text, seed);
  return Math.max(0, Math.floor(score / 4) + (seed % 7));
}

function buildNewsItem(item, feedTitle, index) {
  const url = item.link || item.guid || `https://news.google.com/search?q=${encodeURIComponent(item.title || feedTitle || "news")}`;
  const title = item.title || "Untitled story";
  const publishedAt = item.pubDate || item.isoDate || null;
  const combinedText = `${title} ${item.contentSnippet || item.summary || ""}`.toLowerCase();

  return {
    id: `${getDomain(url)}-${index}-${scoreFromText(title, index)}`,
    rank: index + 1,
    title,
    url,
    domain: getDomain(url),
    source: feedTitle || "News",
    points: scoreFromText(combinedText, index),
    comments: commentsFromText(combinedText, index),
    age: toRelativeTime(publishedAt),
    publishedAt,
    summary: item.contentSnippet || item.summary || "",
  };
}

function buildFallbackNews() {
  const fallbackStories = [
    {
      title: "Fed minutes hint at slower cuts as inflation cools",
      url: "https://www.google.com/search?q=Fed+minutes+slower+cuts+inflation+cools",
      source: "Simulated Market Feed",
      age: "12m ago",
    },
    {
      title: "Oil traders price in tighter supply after refinery outage",
      url: "https://www.google.com/search?q=oil+traders+tighter+supply+refinery+outage",
      source: "Simulated Market Feed",
      age: "28m ago",
    },
    {
      title: "Tech stocks rebound as yields ease from weekly highs",
      url: "https://www.google.com/search?q=tech+stocks+rebound+yields+ease+weekly+highs",
      source: "Simulated Market Feed",
      age: "41m ago",
    },
    {
      title: "Gold firms on growth worries and softer dollar",
      url: "https://www.google.com/search?q=gold+firms+growth+worries+softer+dollar",
      source: "Simulated Market Feed",
      age: "1h ago",
    },
    {
      title: "Bank earnings beat estimates, but credit costs rise",
      url: "https://www.google.com/search?q=bank+earnings+beat+estimates+credit+costs+rise",
      source: "Simulated Market Feed",
      age: "2h ago",
    },
  ];

  return fallbackStories.map((story, index) => ({
    id: `fallback-${index + 1}`,
    rank: index + 1,
    title: story.title,
    url: story.url,
    domain: getDomain(story.url),
    source: story.source,
    points: 100 - index * 7,
    comments: 24 + index * 3,
    age: story.age,
    publishedAt: null,
    summary: "Simulated headline for the UI when live RSS data is unavailable.",
  }));
}

function loadConfig() {
  sources = readJson(sourcesPath, [
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://feeds.marketwatch.com/marketwatch/topstories/",
    "https://www.chinanews.com.cn/rss/finance.xml",
    "http://www.people.com.cn/rss/politics.xml",
    "http://www.chinadaily.com.cn/rss/china_rss.xml",
    "https://www.36kr.com/feed-newsflash",
  ]);

  signalRules = readJson(signalsPath, [
    {
      keyword: "oil",
      asset: "Crude Oil",
      direction: "bullish",
      reason: "Oil-related news",
    },
    {
      keyword: "inflation",
      asset: "Gold",
      direction: "bullish",
      reason: "Inflation hedge",
    },
    {
      keyword: "rate",
      asset: "NASDAQ",
      direction: "bearish",
      reason: "Rate pressure",
    },
  ]);
}

function saveConfig() {
  writeJson(sourcesPath, sources);
  writeJson(signalsPath, signalRules);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function generateSignals() {
  const signalMap = {};

  cachedNews.forEach((item) => {
    const text = `${item.title} ${item.summary || ""} ${item.domain || ""}`.toLowerCase();

    signalRules.forEach((rule) => {
      if (!rule.keyword || !rule.asset) return;
      if (text.includes(rule.keyword.toLowerCase())) {
        signalMap[rule.asset] = {
          asset: rule.asset,
          direction: rule.direction || "neutral",
          reason: rule.reason || `Matched keyword: ${rule.keyword}`,
        };
      }
    });
  });

  cachedSignals = Object.values(signalMap);
}

async function fetchNews() {
  const settledFeeds = await Promise.allSettled(
    sources.map(async (url) => {
      const feed = await parser.parseURL(url);
      return { url, feed };
    }),
  );

  const stories = [];

  settledFeeds.forEach((result) => {
    if (result.status !== "fulfilled") {
      return;
    }

    const { url, feed } = result.value;
    if (!feed || !Array.isArray(feed.items)) {
      return;
    }

    const feedTitle = feed.title || getDomain(url) || "News";

    feed.items.forEach((item, itemIndex) => {
      const publishedAt = item.pubDate || item.isoDate || null;
      const key = item.link || item.guid || `${feedTitle}-${item.title || "item"}-${itemIndex}`;

      stories.push({
        key,
        item,
        feedTitle,
        publishedAt,
        order: itemIndex,
      });
    });
  });

  if (stories.length === 0) {
    cachedNews = buildFallbackNews();
    generateSignals();
    return;
  }

  const dedupedStories = [];
  const seenKeys = new Set();

  stories
    .sort((a, b) => {
      const diff = parseTimestamp(b.publishedAt) - parseTimestamp(a.publishedAt);
      if (diff !== 0) {
        return diff;
      }

      if (a.feedTitle !== b.feedTitle) {
        return a.feedTitle.localeCompare(b.feedTitle);
      }

      return a.order - b.order;
    })
    .forEach((story) => {
      if (seenKeys.has(story.key)) {
        return;
      }

      seenKeys.add(story.key);
      dedupedStories.push(story);
    });

  cachedNews = dedupedStories.slice(0, 20).map((story, index) => buildNewsItem(story.item, story.feedTitle, index));
  generateSignals();
}

function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const ADMIN_USER = process.env.ADMIN_USER || "admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "password";

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic realm=\"Admin\"");
    return res.status(401).send("Authentication required");
  }

  const base64 = authHeader.split(" ")[1];
  const [user, pass] = Buffer.from(base64, "base64").toString().split(":");

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return next();
  }

  res.setHeader("WWW-Authenticate", "Basic realm=\"Admin\"");
  return res.status(401).send("Authentication failed");
}

loadConfig();
fetchNews();
setInterval(fetchNews, 5 * 60 * 1000);

app.get("/news", (req, res) => {
  res.json(cachedNews);
});

app.get("/signals", (req, res) => {
  res.json(cachedSignals);
});

app.get("/admin/sources", basicAuth, (req, res) => {
  res.json({ sources });
});

app.post("/admin/sources", basicAuth, (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ message: "url is required" });
  }

  if (!sources.includes(url)) {
    sources.push(url);
    saveConfig();
  }

  return res.json({ sources });
});

app.delete("/admin/sources", basicAuth, (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ message: "url is required" });
  }

  sources = sources.filter((item) => item !== url);
  saveConfig();

  return res.json({ sources });
});

app.get("/admin/rules", basicAuth, (req, res) => {
  res.json({ rules: signalRules });
});

app.post("/admin/rules", basicAuth, (req, res) => {
  const { keyword, asset, direction, reason } = req.body;
  if (!keyword || !asset) {
    return res.status(400).json({ message: "keyword and asset are required" });
  }

  const normalizedKeyword = keyword.toLowerCase();
  const existingIndex = signalRules.findIndex((rule) => rule.keyword.toLowerCase() === normalizedKeyword);

  if (existingIndex >= 0) {
    signalRules[existingIndex] = { keyword: normalizedKeyword, asset, direction: direction || "neutral", reason: reason || "" };
  } else {
    signalRules.push({ keyword: normalizedKeyword, asset, direction: direction || "neutral", reason: reason || "" });
  }

  saveConfig();
  generateSignals();

  return res.json({ rules: signalRules });
});

app.delete("/admin/rules", basicAuth, (req, res) => {
  const { keyword } = req.body;
  if (!keyword) {
    return res.status(400).json({ message: "keyword is required" });
  }

  signalRules = signalRules.filter((rule) => rule.keyword.toLowerCase() !== keyword.toLowerCase());
  saveConfig();

  return res.json({ rules: signalRules });
});

app.post("/admin/refresh", basicAuth, async (req, res) => {
  await fetchNews();
  return res.json({ newsCount: cachedNews.length, signalCount: cachedSignals.length });
});

app.listen(3001, () => {
  console.log("API running on 3001");
});
