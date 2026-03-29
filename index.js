const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");

const app = express();
const parser = new Parser();

app.use(cors());

let cachedNews = [];
let cachedSignals = [];

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

// 📰 抓新闻
async function fetchNews() {
    const sources = [
        "https://www.cnbc.com/id/100003114/device/rss/rss.html",
        "https://feeds.marketwatch.com/marketwatch/topstories/",
    ];

    let feed = null;

    for (let url of sources) {
        try {
            feed = await parser.parseURL(url);
            break;
        } catch (e) {
            console.log("fail:", url);
        }
    }

    if (!feed || !Array.isArray(feed.items)) {
        cachedNews = buildFallbackNews();
        cachedSignals = [];
        return;
    }

    cachedNews = feed.items.slice(0, 10).map((item, index) => buildNewsItem(item, feed.title || "News", index));

    generateSignals();
}

// 🧠 规则引擎（核心）
function generateSignals() {
  const signalMap = {}; // 去重

  cachedNews.forEach(n => {
    const text = `${n.title} ${n.summary || ""} ${n.domain || ""}`.toLowerCase();

    if (text.includes("oil")) {
      signalMap["Crude Oil"] = {
        asset: "Crude Oil",
        direction: "bullish",
        reason: "Oil-related news",
      };
    }

    if (text.includes("inflation")) {
      signalMap["Gold"] = {
        asset: "Gold",
        direction: "bullish",
        reason: "Inflation hedge",
      };
    }

    if (text.includes("rate")) {
      signalMap["NASDAQ"] = {
        asset: "NASDAQ",
        direction: "bearish",
        reason: "Rate pressure",
      };
    }
  });

  cachedSignals = Object.values(signalMap);
}

// ⏱ 初始化 + 每5分钟更新
fetchNews();
setInterval(fetchNews, 5 * 60 * 1000);

// API
app.get("/news", (req, res) => {
    res.json(cachedNews);
});

app.get("/signals", (req, res) => {
    res.json(cachedSignals);
});

app.listen(3001, () => {
    console.log("API running on 3001");
});
