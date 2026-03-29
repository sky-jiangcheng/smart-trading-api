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
const thresholdsPath = path.join(configDir, "thresholds.json");
const settingsPath = path.join(configDir, "settings.json");
const CONFIG_STORE_KEY = process.env.CONFIG_STORE_KEY || "investment-dashboard:config";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const NEWS_LIMIT_OPTIONS = [50, 100, 200];
const DEFAULT_SETTINGS = { newsLimit: 200 };
const THRESHOLD_MARKET_TTL_MS = 60 * 1000;

const SOURCE_PRESETS = [
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", label: "CNBC - Top Stories" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", label: "MarketWatch - Top Stories" },
  { url: "https://www.chinanews.com.cn/rss/finance.xml", label: "中国新闻网 - 财经" },
  { url: "http://www.people.com.cn/rss/politics.xml", label: "人民网 - 时政" },
  { url: "http://www.chinadaily.com.cn/rss/china_rss.xml", label: "中国日报 - 中国新闻" },
  { url: "https://rsshub.app/cctv/china", label: "央视新闻 - 国内" },
  { url: "https://rsshub.app/zyw/hot/toutiao", label: "今日头条 - 热榜" },
  { url: "https://rsshub.app/zyw/hot/weibo", label: "微博 - 热搜榜" },
  { url: "https://rsshub.app/zhihu/hot", label: "知乎 - 热榜" },
  { url: "https://rsshub.app/zyw/hot/douyin", label: "抖音 - 热榜" },
  { url: "https://www.36kr.com/feed-newsflash", label: "36氪 - 最新快讯" },
  { url: "https://rsshub.app/caixinglobal/latest", label: "Caixin Global - Latest" },
];

const SOURCE_LABELS = new Map(SOURCE_PRESETS.map((preset) => [preset.url, preset.label]));

let cachedNews = [];
let cachedSignals = [];
let sources = [];
let signalRules = [];
let thresholds = [];
let settings = { ...DEFAULT_SETTINGS };
let cachedConfigSignature = "";
let thresholdMarketSnapshotAt = 0;
let thresholdMarketRefreshPromise = null;

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeSettings(value) {
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === "object" ? value : {}),
  };

  const parsedLimit = Number(nextSettings.newsLimit);
  nextSettings.newsLimit = NEWS_LIMIT_OPTIONS.includes(parsedLimit)
    ? parsedLimit
    : DEFAULT_SETTINGS.newsLimit;

  return nextSettings;
}

function normalizeSettingsPayload(value) {
  return normalizeSettings(value && typeof value === "object" ? value : DEFAULT_SETTINGS);
}

function normalizeThreshold(value, index = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const symbol = typeof value.symbol === "string" ? value.symbol.trim() : "";
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : symbol;
  const category = ["stock", "currency", "futures", "crypto", "macro"].includes(value.category)
    ? value.category
    : "stock";
  const direction = value.direction === "below" ? "below" : "above";
  const currentValue = Number(value.currentValue);
  const thresholdValue = Number(value.thresholdValue);
  const unit = typeof value.unit === "string" && value.unit.trim() ? value.unit.trim() : "USD";
  const note = typeof value.note === "string" ? value.note.trim() : "";
  const marketSymbol =
    typeof value.marketSymbol === "string" && value.marketSymbol.trim()
      ? value.marketSymbol.trim().toUpperCase()
      : symbol;
  const priority = ["P0", "P1", "P2"].includes(value.priority) ? value.priority : "P1";
  const tags = Array.isArray(value.tags)
    ? Array.from(
        new Set(
          value.tags
            .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
            .filter((tag) => tag.length > 0),
        ),
      ).slice(0, 6)
    : [];
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt.trim() : new Date(Date.now() - index * 60000).toISOString();

  if (!symbol || !Number.isFinite(currentValue) || !Number.isFinite(thresholdValue)) {
    return null;
  }

  return {
    symbol,
    name,
    category,
    direction,
    currentValue,
    thresholdValue,
    unit,
    note,
    marketSymbol,
    priority,
    tags,
    updatedAt,
  };
}

function normalizeThresholds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => normalizeThreshold(item, index))
    .filter((item) => Boolean(item));
}

const BOARD_DIMENSIONS = [
  {
    key: "macro",
    label: "Macro",
    labelZh: "宏观",
    keywords: ["fed", "cpi", "pmi", "rate", "yield", "inflation", "macro", "policy", "利率", "通胀", "宏观", "政策"],
    assets: ["US10Y", "DXY", "SPX"],
    tone: "#1d4ed8",
    description: "Rates, inflation, policy and the curve.",
  },
  {
    key: "liquidity",
    label: "Liquidity",
    labelZh: "流动性",
    keywords: ["liquidity", "flow", "funding", "volume", "turnover", "资金", "流动性", "成交", "换手"],
    assets: ["SPX", "QQQ", "BTC"],
    tone: "#0f766e",
    description: "Funding, depth and trade flow.",
  },
  {
    key: "valuation",
    label: "Valuation",
    labelZh: "估值",
    keywords: ["valuation", "multiple", "pe", "pb", "eps", "估值", "倍数"],
    assets: ["QQQ", "AAPL", "NVDA"],
    tone: "#7c3aed",
    description: "Re-rating, compression and premium pricing.",
  },
  {
    key: "risk",
    label: "Risk",
    labelZh: "风险偏好",
    keywords: ["risk", "vix", "volatility", "hedge", "drawdown", "risk off", "风险", "波动", "避险"],
    assets: ["VIX", "GLD", "SPX"],
    tone: "#b91c1c",
    description: "Volatility, hedging and positioning.",
  },
  {
    key: "event",
    label: "Event",
    labelZh: "事件驱动",
    keywords: ["earnings", "guidance", "event", "policy", "catalyst", "财报", "事件", "催化", "政策"],
    assets: ["AAPL", "TSLA", "NVDA"],
    tone: "#b45309",
    description: "Earnings, policy changes and catalysts.",
  },
  {
    key: "flow",
    label: "Flow",
    labelZh: "资金流",
    keywords: ["buying", "selling", "inflow", "outflow", "order", "flow", "资金", "流入", "流出", "订单"],
    assets: ["SPX", "BTC", "XAU"],
    tone: "#0891b2",
    description: "Money movement and market participation.",
  },
  {
    key: "sentiment",
    label: "Sentiment",
    labelZh: "情绪",
    keywords: ["sentiment", "panic", "euphoria", "fear", "mood", "情绪", "恐慌", "乐观"],
    assets: ["VIX", "SPX", "BTC"],
    tone: "#db2777",
    description: "Tone, fear and crowding.",
  },
  {
    key: "technical",
    label: "Technical",
    labelZh: "技术位",
    keywords: ["breakout", "support", "resistance", "trend", "technical", "突破", "支撑", "阻力", "趋势"],
    assets: ["SPX", "QQQ", "BTC"],
    tone: "#2563eb",
    description: "Structure, levels and trend confirmations.",
  },
  {
    key: "industry",
    label: "Industry",
    labelZh: "产业链",
    keywords: ["semiconductor", "energy", "bank", "health", "industry", "产业", "链条", "半导体"],
    assets: ["NVDA", "XLE", "XLF"],
    tone: "#14b8a6",
    description: "Sector leadership and supply-chain context.",
  },
  {
    key: "earnings",
    label: "Earnings",
    labelZh: "报表",
    keywords: ["earnings", "revenue", "margin", "profit", "guidance", "财报", "营收", "利润", "毛利"],
    assets: ["AAPL", "NVDA", "TSLA"],
    tone: "#f97316",
    description: "Results, margins and guidance revisions.",
  },
];

function classifyTextDimensions(text) {
  const haystack = String(text || "").toLowerCase();
  const matches = BOARD_DIMENSIONS.filter((dimension) =>
    dimension.keywords.some((keyword) => haystack.includes(keyword.toLowerCase())),
  );

  if (matches.length > 0) {
    return matches;
  }

  return [BOARD_DIMENSIONS[0]];
}

function buildWhyItMatters(dimensions, title) {
  const primary = dimensions[0];
  return `${title} primarily maps to ${primary.labelZh}, so it matters for ${primary.assets.slice(0, 2).join(" and ")}.`;
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

function hasRemoteConfigStore() {
  return Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
}

async function readRemoteConfig() {
  if (!hasRemoteConfigStore()) {
    return null;
  }

  const response = await fetch(
    `${UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/get/${encodeURIComponent(CONFIG_STORE_KEY)}`,
    {
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Remote config read failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload || payload.result == null) {
    return null;
  }

  if (typeof payload.result === "string") {
    try {
      return JSON.parse(payload.result);
    } catch (error) {
      console.error("Failed to parse remote config JSON", error);
      return null;
    }
  }

  return payload.result;
}

async function writeRemoteConfig(data) {
  if (!hasRemoteConfigStore()) {
    return false;
  }

  const response = await fetch(
    `${UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/set/${encodeURIComponent(CONFIG_STORE_KEY)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: JSON.stringify(data),
    },
  );

  if (!response.ok) {
    throw new Error(`Remote config write failed: ${response.status} ${response.statusText}`);
  }

  return true;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "news.ycombinator.com";
  }
}

function getSourceLabel(url) {
  return SOURCE_LABELS.get(url) || getDomain(url);
}

function buildSourceMeta(url) {
  return {
    url,
    label: getSourceLabel(url),
  };
}

function buildMarketSymbolMap() {
  return {
    AAPL: "AAPL",
    "USD/CNY": "CNY=X",
    "USD/CNH": "CNH=X",
    GC: "GC=F",
    CL: "CL=F",
    NASDAQ: "^NDX",
    SPX: "^GSPC",
  };
}

async function refreshThresholdMarketData(items, force = false) {
  if (!force && thresholdMarketSnapshotAt && Date.now() - thresholdMarketSnapshotAt < THRESHOLD_MARKET_TTL_MS) {
    return Array.isArray(items) ? items : [];
  }

  if (thresholdMarketRefreshPromise) {
    return thresholdMarketRefreshPromise;
  }

  const thresholdsList = Array.isArray(items) ? items : [];
  const marketSymbols = Array.from(
    new Set(
      thresholdsList
        .map((item) => item.marketSymbol || buildMarketSymbolMap()[item.symbol] || item.symbol)
        .filter((value) => typeof value === "string" && value.trim().length > 0),
    ),
  );

  if (marketSymbols.length === 0) {
    thresholdMarketSnapshotAt = Date.now();
    return thresholdsList;
  }

  thresholdMarketRefreshPromise = (async () => {
    try {
      const response = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(marketSymbols.join(","))}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0",
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Market quote fetch failed: ${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      const quoteMap = new Map(
        Array.isArray(payload?.quoteResponse?.result)
          ? payload.quoteResponse.result
              .filter((item) => item && typeof item.symbol === "string" && Number.isFinite(item.regularMarketPrice))
              .map((item) => [item.symbol, item])
          : [],
      );

      return thresholdsList.map((item, index) => {
        const marketSymbol = item.marketSymbol || buildMarketSymbolMap()[item.symbol] || item.symbol;
        const quote = quoteMap.get(marketSymbol);

        if (!quote || !Number.isFinite(quote.regularMarketPrice)) {
          return item;
        }

        return normalizeThreshold(
          {
            ...item,
            currentValue: Number(quote.regularMarketPrice),
            updatedAt: quote.regularMarketTime ? new Date(quote.regularMarketTime * 1000).toISOString() : item.updatedAt,
          },
          index,
        ) || item;
    });
    } catch (error) {
      console.error("Failed to refresh market thresholds", error);
      return thresholdsList;
    } finally {
      thresholdMarketSnapshotAt = Date.now();
      thresholdMarketRefreshPromise = null;
    }
  })();

  return thresholdMarketRefreshPromise;
}

function buildDefaultThresholds() {
  return [
    {
      symbol: "AAPL",
      name: "Apple",
      category: "stock",
      currentValue: 210.42,
      thresholdValue: 205,
      direction: "above",
      unit: "USD",
      note: "Breakout above resistance keeps the trend constructive.",
      marketSymbol: "AAPL",
      priority: "P0",
      tags: ["earnings", "tech"],
      updatedAt: new Date().toISOString(),
    },
    {
      symbol: "USD/CNY",
      name: "US Dollar / Chinese Yuan",
      category: "currency",
      currentValue: 7.18,
      thresholdValue: 7.2,
      direction: "above",
      unit: "CNY",
      note: "Rising USD/CNY usually pressures risk assets and import costs.",
      marketSymbol: "CNY=X",
      priority: "P1",
      tags: ["fx", "china"],
      updatedAt: new Date().toISOString(),
    },
    {
      symbol: "GC",
      name: "Gold Futures",
      category: "futures",
      currentValue: 2328,
      thresholdValue: 2300,
      direction: "above",
      unit: "USD/oz",
      note: "Above the threshold, gold keeps its hedge profile.",
      marketSymbol: "GC=F",
      priority: "P1",
      tags: ["inflation", "hedge"],
      updatedAt: new Date().toISOString(),
    },
    {
      symbol: "CL",
      name: "Crude Oil Futures",
      category: "futures",
      currentValue: 82.6,
      thresholdValue: 85,
      direction: "below",
      unit: "USD",
      note: "Below the alert level, energy inflation pressure is easing.",
      marketSymbol: "CL=F",
      priority: "P2",
      tags: ["energy", "inflation"],
      updatedAt: new Date().toISOString(),
    },
    {
      symbol: "NASDAQ",
      name: "NASDAQ 100",
      category: "macro",
      currentValue: 19520,
      thresholdValue: 19200,
      direction: "above",
      unit: "pts",
      note: "The index holding above the threshold supports risk-on sentiment.",
      marketSymbol: "^NDX",
      priority: "P0",
      tags: ["risk-on", "growth"],
      updatedAt: new Date().toISOString(),
    },
  ];
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

function buildNewsItem(item, sourceLabel, sourceUrl, index, fallbackPublishedAt = null) {
  const title = item.title || "Untitled story";
  const url = item.link || item.guid || `https://news.google.com/search?q=${encodeURIComponent(title || "news")}`;
  const publishedAt = item.pubDate || item.isoDate || item.updated || item.date || fallbackPublishedAt || null;
  const combinedText = `${title} ${item.contentSnippet || item.summary || ""}`.toLowerCase();
  const dimensions = classifyTextDimensions(`${title} ${item.contentSnippet || item.summary || ""} ${sourceLabel}`);
  const primaryDimension = dimensions[0];

  return {
    id: `${getDomain(url)}-${index}-${scoreFromText(title, index)}`,
    rank: index + 1,
    title,
    url,
    domain: getDomain(url),
    sourceUrl: sourceUrl || "",
    source: sourceLabel || "News",
    points: scoreFromText(combinedText, index),
    comments: commentsFromText(combinedText, index),
    age: toRelativeTime(publishedAt),
    publishedAt,
    summary: item.contentSnippet || item.summary || "",
    dimensions: dimensions.map((dimension) => dimension.key),
    dimensionLabel: primaryDimension.label,
    dimensionLabelZh: primaryDimension.labelZh,
    dimensionTone: primaryDimension.tone,
    relatedAssets: primaryDimension.assets,
    whyItMatters: buildWhyItMatters(dimensions, title),
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

async function loadConfig() {
  const fallbackSources = SOURCE_PRESETS.map((preset) => preset.url);
  const fallbackSignalRules = [
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
  ];
  const fallbackThresholds = buildDefaultThresholds();

  const loadedRemote = await readRemoteConfig();
  const loadedSources = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.sources : null;
  const loadedSignalRules = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.signalRules : null;
  const loadedThresholds = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.thresholds : null;
  const loadedSettings = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.settings : null;

  sources = Array.isArray(loadedSources) ? loadedSources : readJson(sourcesPath, fallbackSources);
  if (!Array.isArray(sources)) {
    sources = fallbackSources;
  }

  signalRules = Array.isArray(loadedSignalRules) ? loadedSignalRules : readJson(signalsPath, fallbackSignalRules);
  if (!Array.isArray(signalRules)) {
    signalRules = fallbackSignalRules;
  }

  thresholds = Array.isArray(loadedThresholds)
    ? normalizeThresholds(loadedThresholds)
    : normalizeThresholds(readJson(thresholdsPath, fallbackThresholds));
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    thresholds = fallbackThresholds;
  }

  settings = normalizeSettings(loadedSettings || readJson(settingsPath, DEFAULT_SETTINGS));
  cachedConfigSignature = createConfigSignature();
}

function createConfigSignature() {
  return JSON.stringify({
    sources,
    signalRules,
    thresholds,
    settings,
  });
}

async function loadLatestConfigBundle() {
  const fallbackSources = SOURCE_PRESETS.map((preset) => preset.url);
  const fallbackSignalRules = [
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
  ];
  const fallbackThresholds = buildDefaultThresholds();

  if (hasRemoteConfigStore()) {
    try {
      const loadedRemote = await readRemoteConfig();
      const loadedSources = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.sources : null;
      const loadedSignalRules = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.signalRules : null;
      const loadedThresholds = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.thresholds : null;
      const loadedSettings = loadedRemote && typeof loadedRemote === "object" ? loadedRemote.settings : null;

      sources = Array.isArray(loadedSources) ? loadedSources : sources;
      if (!Array.isArray(sources) || sources.length === 0) {
        sources = readJson(sourcesPath, fallbackSources);
      }

      signalRules = Array.isArray(loadedSignalRules) ? loadedSignalRules : signalRules;
      if (!Array.isArray(signalRules) || signalRules.length === 0) {
        signalRules = readJson(signalsPath, fallbackSignalRules);
      }

      thresholds = Array.isArray(loadedThresholds) ? normalizeThresholds(loadedThresholds) : thresholds;
      if (!Array.isArray(thresholds) || thresholds.length === 0) {
        thresholds = normalizeThresholds(readJson(thresholdsPath, fallbackThresholds));
      }

      settings = normalizeSettingsPayload(loadedSettings || settings);
      return { sources, signalRules, thresholds, settings };
    } catch (error) {
      console.error("Failed to refresh remote config", error);
    }
  }

  sources = Array.isArray(sources) && sources.length > 0 ? sources : readJson(sourcesPath, fallbackSources);
  signalRules = Array.isArray(signalRules) && signalRules.length > 0 ? signalRules : readJson(signalsPath, fallbackSignalRules);
  thresholds = Array.isArray(thresholds) && thresholds.length > 0 ? thresholds : normalizeThresholds(readJson(thresholdsPath, fallbackThresholds));
  settings = normalizeSettingsPayload(readJson(settingsPath, settings));
  return { sources, signalRules, thresholds, settings };
}

async function saveConfig() {
  const bundle = {
    sources,
    signalRules,
    thresholds,
    settings,
  };

  if (hasRemoteConfigStore()) {
    try {
      await writeRemoteConfig(bundle);
      return;
    } catch (error) {
      console.error("Remote config save failed, falling back to local files", error);
    }
  }

  writeJson(sourcesPath, sources);
  writeJson(signalsPath, signalRules);
  writeJson(thresholdsPath, thresholds);
  writeJson(settingsPath, settings);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function generateSignals() {
  const signalMap = {};

  cachedNews.forEach((item) => {
    const text = `${item.title} ${item.summary || ""} ${item.domain || ""}`.toLowerCase();
    const dimensions = classifyTextDimensions(text);
    const primaryDimension = dimensions[0];

    signalRules.forEach((rule) => {
      if (!rule.keyword || !rule.asset) return;
      if (text.includes(rule.keyword.toLowerCase())) {
        signalMap[rule.asset] = {
          asset: rule.asset,
          direction: rule.direction || "neutral",
          reason: rule.reason || `Matched keyword: ${rule.keyword}`,
          dimension: primaryDimension.key,
          dimensionLabel: primaryDimension.label,
          dimensionLabelZh: primaryDimension.labelZh,
          tone: primaryDimension.tone,
          relatedAssets: primaryDimension.assets,
          relatedNewsIds: [item.id],
          whyItMatters: buildWhyItMatters(dimensions, rule.asset),
          confidence: Math.min(0.98, 0.62 + (scoreFromText(text, rule.keyword.length) % 33) / 100),
        };
      }
    });
  });

  cachedSignals = Object.values(signalMap);
}

function buildBoardSummary() {
  const newsDimensionCounts = {};
  const signalDimensionCounts = {};
  const thresholdDimensionCounts = {};

  cachedNews.forEach((item) => {
    const dimensions = Array.isArray(item.dimensions) && item.dimensions.length > 0 ? item.dimensions : ["macro"];
    dimensions.forEach((dimension) => {
      newsDimensionCounts[dimension] = (newsDimensionCounts[dimension] || 0) + 1;
    });
  });

  cachedSignals.forEach((item) => {
    const dimension = item.dimension || "macro";
    signalDimensionCounts[dimension] = (signalDimensionCounts[dimension] || 0) + 1;
  });

  thresholds.forEach((item) => {
    const dimension = classifyTextDimensions(`${item.symbol} ${item.name} ${item.category} ${item.note} ${item.tags.join(" ")}`)[0].key;
    thresholdDimensionCounts[dimension] = (thresholdDimensionCounts[dimension] || 0) + 1;
  });

  const dimensions = BOARD_DIMENSIONS.map((dimension) => {
    const newsCount = newsDimensionCounts[dimension.key] || 0;
    const signalCount = signalDimensionCounts[dimension.key] || 0;
    const thresholdCount = thresholdDimensionCounts[dimension.key] || 0;
    const intensity = signalCount + thresholdCount + newsCount;
    const state = intensity >= 8 ? "hot" : intensity >= 5 ? "warming" : thresholdCount >= 2 ? "cooling" : "neutral";

    return {
      ...dimension,
      state,
      newsCount,
      signalCount,
      thresholdCount,
      representativeAssets: dimension.assets,
    };
  });

  const topNews = cachedNews.slice(0, 3).map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    sourceUrl: item.sourceUrl,
    domain: item.domain,
    summary: item.summary,
    publishedAt: item.publishedAt,
    age: item.age,
    points: item.points,
    comments: item.comments,
    dimensions: item.dimensions || [],
    dimensionLabel: item.dimensionLabel,
    dimensionLabelZh: item.dimensionLabelZh,
    dimensionTone: item.dimensionTone,
    relatedAssets: item.relatedAssets || [],
    whyItMatters: item.whyItMatters,
    url: item.url,
  }));

  const topSignals = cachedSignals.slice(0, 3).map((item) => ({
    ...item,
  }));

  const reportBriefs = [
    {
      label: "Market Pulse",
      labelZh: "市场脉冲",
      value: `${cachedSignals.filter((item) => item.direction === "bullish").length}/${cachedSignals.filter((item) => item.direction === "bearish").length}`,
      meta: "Bullish / bearish balance",
    },
    {
      label: "Threshold Pressure",
      labelZh: "阈值压力",
      value: `${thresholds.filter((item) => {
        const triggered = item.direction === "above" ? item.currentValue >= item.thresholdValue : item.currentValue <= item.thresholdValue;
        return triggered;
      }).length}/${thresholds.length}`,
      meta: "Triggered vs total thresholds",
    },
    {
      label: "Coverage",
      labelZh: "覆盖范围",
      value: `${cachedNews.length}`,
      meta: "News items in view",
    },
  ];

  const marketState = cachedSignals.some((item) => item.direction === "bearish")
    ? "risk"
    : cachedSignals.some((item) => item.direction === "bullish")
      ? "warming"
      : "neutral";

  return {
    marketState,
    generatedAt: new Date().toISOString(),
    topNews,
    topSignals,
    dimensions,
    reportBriefs,
  };
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

    const sourceLabel = getSourceLabel(url);
    const feedFetchedAt = Date.now();

    feed.items.forEach((item, itemIndex) => {
      const publishedAt =
        item.pubDate ||
        item.isoDate ||
        item.updated ||
        item.date ||
        new Date(feedFetchedAt - itemIndex * 1000).toISOString();
      const key = item.link || item.guid || `${sourceLabel}-${item.title || "item"}-${itemIndex}`;

      stories.push({
        key,
        item,
        url,
        sourceLabel,
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
      return a.order - b.order;
    })
    .forEach((story) => {
      if (seenKeys.has(story.key)) {
        return;
      }

      seenKeys.add(story.key);
      dedupedStories.push(story);
    });

  dedupedStories.sort((a, b) => {
    const diff = parseTimestamp(b.publishedAt) - parseTimestamp(a.publishedAt);
    if (diff !== 0) {
      return diff;
    }
    return a.order - b.order;
  });

  cachedNews = dedupedStories
    .slice(0, 200)
    .map((story, index) =>
      buildNewsItem(story.item, story.sourceLabel || "News", story.url, index, story.publishedAt),
    );
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

const bootstrapPromise = (async () => {
  await loadConfig();
  await fetchNews();
})().catch((error) => {
  console.error("Initial news refresh failed", error);
});

if (require.main === module && !process.env.VERCEL) {
  bootstrapPromise.finally(() => {
    setInterval(() => {
      fetchNews().catch((error) => {
        console.error("Scheduled news refresh failed", error);
      });
    }, 5 * 60 * 1000);
  });
}

app.get("/news", async (req, res) => {
  await bootstrapPromise;
  const previousSignature = cachedConfigSignature;
  await loadLatestConfigBundle();
  const latestSignature = createConfigSignature();
  if (latestSignature !== previousSignature) {
    await fetchNews();
    cachedConfigSignature = latestSignature;
  }
  const limit = NEWS_LIMIT_OPTIONS.includes(Number(settings.newsLimit))
    ? Number(settings.newsLimit)
    : DEFAULT_SETTINGS.newsLimit;

  res.json(cachedNews.slice(0, limit));
});

app.get("/signals", async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json(cachedSignals);
});

app.get("/board", async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json(buildBoardSummary());
});

app.get("/sources", async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json({ sources: sources.map((url) => buildSourceMeta(url)) });
});

app.get("/thresholds", async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const liveThresholds = await refreshThresholdMarketData(thresholds);
  thresholds = liveThresholds;
  res.json({ thresholds: liveThresholds });
});

app.get("/settings", async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json(settings);
});

app.get("/admin/sources", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json({ sources });
});

app.post("/admin/sources", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ message: "url is required" });
  }

  if (!sources.includes(url)) {
    sources.push(url);
    await saveConfig();
    await fetchNews();
    cachedConfigSignature = createConfigSignature();
  }

  return res.json({ sources });
});

app.delete("/admin/sources", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ message: "url is required" });
  }

  sources = sources.filter((item) => item !== url);
  await saveConfig();
  await fetchNews();
  cachedConfigSignature = createConfigSignature();

  return res.json({ sources });
});

app.get("/admin/rules", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json({ rules: signalRules });
});

app.get("/admin/thresholds", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const liveThresholds = await refreshThresholdMarketData(thresholds);
  thresholds = liveThresholds;
  res.json({ thresholds: liveThresholds });
});

app.post("/admin/rules", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
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

  await saveConfig();
  generateSignals();
  await fetchNews();
  cachedConfigSignature = createConfigSignature();

  return res.json({ rules: signalRules });
});

app.delete("/admin/rules", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const { keyword } = req.body;
  if (!keyword) {
    return res.status(400).json({ message: "keyword is required" });
  }

  signalRules = signalRules.filter((rule) => rule.keyword.toLowerCase() !== keyword.toLowerCase());
  await saveConfig();
  generateSignals();
  await fetchNews();
  cachedConfigSignature = createConfigSignature();

  return res.json({ rules: signalRules });
});

app.post("/admin/thresholds", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const nextThreshold = normalizeThreshold(req.body);

  if (!nextThreshold) {
    return res.status(400).json({
      message: "symbol, currentValue, thresholdValue, and a valid category are required",
    });
  }

  const existingIndex = thresholds.findIndex((item) => {
    return item.symbol.toLowerCase() === nextThreshold.symbol.toLowerCase() && item.category === nextThreshold.category;
  });

  if (existingIndex >= 0) {
    thresholds[existingIndex] = nextThreshold;
  } else {
    thresholds.push(nextThreshold);
  }

  await saveConfig();
  thresholds = await refreshThresholdMarketData(thresholds, true);
  cachedConfigSignature = createConfigSignature();

  return res.json({ thresholds });
});

app.delete("/admin/thresholds", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const { symbol, category } = req.body || {};

  if (!symbol || typeof symbol !== "string") {
    return res.status(400).json({ message: "symbol is required" });
  }

  thresholds = thresholds.filter((item) => {
    if (item.symbol.toLowerCase() !== symbol.toLowerCase()) {
      return true;
    }

    if (category && typeof category === "string") {
      return item.category !== category;
    }

    return false;
  });

  await saveConfig();
  thresholds = await refreshThresholdMarketData(thresholds, true);
  cachedConfigSignature = createConfigSignature();

  return res.json({ thresholds });
});

app.get("/admin/settings", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  res.json({ settings });
});

app.post("/admin/settings", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await loadLatestConfigBundle();
  const { newsLimit } = req.body || {};
  const parsedLimit = Number(newsLimit);

  if (!NEWS_LIMIT_OPTIONS.includes(parsedLimit)) {
    return res.status(400).json({ message: "newsLimit must be one of 50, 100, 200" });
  }

  settings = normalizeSettings({ newsLimit: parsedLimit });
  await saveConfig();
  await loadLatestConfigBundle();

  if (settings.newsLimit !== parsedLimit) {
    return res.status(503).json({
      message: "newsLimit save did not persist. Check production config storage for the API project.",
      settings,
    });
  }

  return res.json({ settings });
});

app.post("/admin/refresh", basicAuth, async (req, res) => {
  await bootstrapPromise;
  await fetchNews();
  thresholds = await refreshThresholdMarketData(thresholds, true);
  await saveConfig();
  cachedConfigSignature = createConfigSignature();
  return res.json({ newsCount: cachedNews.length, signalCount: cachedSignals.length, thresholdCount: thresholds.length });
});

module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  app.listen(3001, () => {
    console.log("API running on 3001");
  });
}
