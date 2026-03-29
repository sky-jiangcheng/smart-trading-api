const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");

const app = express();
const parser = new Parser();

app.use(cors());

let cachedNews = [];
let cachedSignals = [];

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
        cachedNews = [];
        cachedSignals = [];
        return;
    }

    cachedNews = feed.items.slice(0, 10).map(item => ({
        title: item.title,
        source: feed.title || "News",
        time: item.pubDate ? new Date(item.pubDate).toLocaleTimeString() : "",
    }));

    generateSignals();
}

// 🧠 规则引擎（核心）
function generateSignals() {
  const signalMap = {}; // 去重

  cachedNews.forEach(n => {
    const text = n.title.toLowerCase();

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
