import express, { Request, Response, NextFunction } from 'express';
import bodyParser from "body-parser";
import cors from "cors";
import axios from "axios";
import { load } from "cheerio";
import { Results, ImageResult, NewsResult, VideoResult } from "./results";
import * as iconv from 'iconv-lite';
import * as http from 'http';
import * as https from 'https';
import { randomInt } from 'crypto';

const rateLimit = require('express-rate-limit');

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

const httpClient = axios.create({
    httpAgent: keepAliveHttp,
    httpsAgent: keepAliveHttps,
    timeout: 10000,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 400
});

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function requestWithRetry<T>(request: () => Promise<{ status: number; headers: any; data: T }>): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await request();
            if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxAttempts) {
                return response.data;
            }

            const retryAfter = Number.parseInt(String(response.headers["retry-after"] || ""), 10);
            const delayMs = Number.isFinite(retryAfter)
                ? Math.min(2000, retryAfter * 1000)
                : 250 * 2 ** (attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        } catch (error: any) {
            const status = error?.response?.status;
            const isRetryable = !status || RETRYABLE_STATUS_CODES.has(status);
            if (!isRetryable || attempt === maxAttempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
    }

    throw new Error("Request failed after retries");
}

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry { value: any; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.value as T;
}

function cacheSet(key: string, value: any, ttl: number = CACHE_TTL_MS): void {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    if (cache.size > 500) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
    }
}

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

const app = express();

let requestCount = 0;
const REQUEST_THRESHOLD = 100;
const RESET_INTERVAL = 5 * 60 * 60 * 1000;

const requestCounter = (req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith('/api')) {
        requestCount++;
        console.log(`Request count: ${requestCount}`);
    }
    next();
};

app.use(requestCounter);
app.use(cors());
app.use(bodyParser.json());
app.use('/api', limiter);

const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
};

const BING_TR_PARAMS = { setlang: "tr", cc: "TR", mkt: "tr-TR" };
function normalizeDisplayUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
        return url;
    }
}

function decodeBingRedirectUrl(url: string): string {
    if (!url) return url;
    if (url.includes("bing.com/news/apiclick.aspx") || url.includes("bing.com/ck/a")) {
        const urlMatch = url.match(/[?&]url=([^&]+)/);
        if (urlMatch?.[1]) {
            try { return decodeURIComponent(urlMatch[1]); } catch { }
        }
    }
    if (!url.includes("bing.com/ck/a")) return url;
    const match = url.match(/[?&]u=([^&]+)/);
    if (!match?.[1]) return url;

    let candidate = match[1];
    try {
        candidate = decodeURIComponent(candidate);
    } catch {
    }

    if (/^a\d/.test(candidate)) {
        candidate = candidate.slice(2);
    }

    try {
        const normalized = candidate.replace(/-/g, "+").replace(/_/g, "/");
        const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
        const decoded = Buffer.from(normalized + padding, "base64").toString("utf8");
        if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
            return decoded;
        }
    } catch {
    }

    return candidate;
}

async function getGoogle(q: string, n: number): Promise<Results[]> {
    const limit = Math.max(1, Math.min(50, Number.isFinite(n) ? n : 10));
    const cacheKey = `google:${q}:${limit}`;
    const cached = cacheGet<Results[]>(cacheKey);
    if (cached) return cached;

    const results: Results[] = [];
    const seenUrls = new Set<string>();

    try {
        const html = await requestWithRetry<string>(() => httpClient.post(
            "https://www.startpage.com/sp/search",
            new URLSearchParams({ q, num: String(limit) }).toString(),
            {
                headers: {
                    ...REQUEST_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": "https://www.startpage.com/"
                }
            }
        ));
        const $ = load(html);

        const cleanText = (el: any): string =>
            $(el).clone().find("style").remove().end().text().trim();

        $("a.result-title.result-link").each((_, element) => {
            if (results.length >= limit) return false;

            const title = cleanText(element);
            const url = $(element).attr("href") || "";

            if (!title || !url || seenUrls.has(url)) return;

            const container = $(element).parent();
            const description = cleanText(container.find("p.description").first());
            seenUrls.add(url);
            results.push({
                title,
                description,
                displayUrl: normalizeDisplayUrl(url),
                url,
                source: "Google"
            });
        });

    } catch (error) {
        console.error("Error fetching from Startpage (Google):", (error as Error).message);
    }

    if (results.length) cacheSet(cacheKey, results);
    return results;
}

async function getYandex(q: string, n: number): Promise<Results[]> {
    const limit = Math.max(1, Math.min(50, Number.isFinite(n) ? n : 10));
    const cacheKey = `yandex:${q}:${limit}`;
    const cached = cacheGet<Results[]>(cacheKey);
    if (cached) return cached;

    const results: Results[] = [];
    const seenUrls = new Set<string>();

    try {
        const pageCount = Math.ceil(limit / 10);
        const pages = await Promise.all(Array.from({ length: pageCount }, (_, page) =>
            requestWithRetry<string>(() => httpClient.get("https://yandex.com.tr/search/", {
                params: { text: q, lr: 983, lang: "tr", p: page },
                headers: REQUEST_HEADERS
            }))
        ));

        const html = pages.join("\n");
        const $ = load(html);

        $(".serp-item").each((_, element) => {
            if (results.length >= limit) return false;

            const titleElement = $(element).find(".OrganicTitle-Link").first();
            const title = titleElement.text().trim();
            const url = titleElement.attr("href") || "";
            const description = $(element).find(".OrganicText").first().text().trim();

            if (!title || !url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) return;

            seenUrls.add(url);
            results.push({
                title,
                description,
                displayUrl: normalizeDisplayUrl(url),
                url,
                source: "Yandex TR"
            });
        });
    } catch (error) {
        console.error("Error fetching from Yandex Turkey:", (error as Error).message);
    }

    if (results.length) cacheSet(cacheKey, results);
    return results;
}

function mergeResults(a: Results[], b: Results[]): Results[] {
    const map = new Map<string, Results>();
    for (const item of a) map.set(item.title, item);
    for (const item of b) if (!map.has(item.title)) map.set(item.title, item);
    return Array.from(map.values());
}

type ResultSort = "relevance" | "random";

function sortResults(results: Results[], query: string, sort: ResultSort): Results[] {
    if (sort === "random") {
        const shuffled = [...results];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    const terms = query.toLocaleLowerCase("tr-TR").split(/\s+/).filter(Boolean);
    const score = (result: Results): number => {
        const title = result.title.toLocaleLowerCase("tr-TR");
        const text = `${title} ${result.description.toLocaleLowerCase("tr-TR")}`;
        return terms.reduce((total, term) =>
            total + (title.includes(term) ? 5 : 0) + (text.includes(term) ? 1 : 0), 0);
    };

    return [...results].sort((a, b) => score(b) - score(a));
}


async function getImages(q: string, n: number): Promise<ImageResult[]> {
    const limit = Math.max(1, Math.min(50, Number.isFinite(n) ? n : 10));
    const cacheKey = `images:${q}:${limit}`;
    const cached = cacheGet<ImageResult[]>(cacheKey);
    if (cached) return cached;

    const results: ImageResult[] = [];

    try {
        const html = await requestWithRetry<string>(() => httpClient.post(
            "https://www.startpage.com/sp/search",
            new URLSearchParams({ q, cat: "pics", num: String(limit) }).toString(),
            {
                headers: {
                    ...REQUEST_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": "https://www.startpage.com/"
                }
            }
        ));
        const $ = load(html);

        $(".image-result").each((_, element) => {
            if (results.length >= limit) return false;

            const noscriptHtml = $(element).find("noscript").first().html() || "";
            const ns$ = load(noscriptHtml);
            const img = ns$("img").first();
            const title = (img.attr("alt") || "").trim();
            let url = img.attr("src") || "";

            if (!url) return;
            if (url.startsWith("/")) {
                url = "https://www.startpage.com" + url;
            }

            results.push({
                title,
                url,
                thumbnailUrl: url,
                sourceUrl: "",
                source: "Startpage"
            });
        });

    } catch (error) {
        console.error("Error fetching images from Startpage:", (error as Error).message);
    }

    if (results.length) cacheSet(cacheKey, results);
    return results;
}

async function getNews(q: string, n: number): Promise<NewsResult[]> {
    const limit = Math.max(1, Math.min(50, Number.isFinite(n) ? n : 10));
    const cacheKey = `news:${q}:${limit}`;
    const cached = cacheGet<NewsResult[]>(cacheKey);
    if (cached) return cached;

    const results: NewsResult[] = [];

    try {
        const xml = await requestWithRetry(() => httpClient.get("https://www.bing.com/news/search", {
            params: { q, count: limit, format: "rss", ...BING_TR_PARAMS },
            headers: REQUEST_HEADERS,
            responseType: "arraybuffer"
        }));

        const decodedXml = iconv.decode(Buffer.from(xml as any), "utf-8");
        const $ = load(decodedXml, { xmlMode: true });

        $("item").each((_, element) => {
            if (results.length >= limit) return false;

            const title = $(element).find("title").first().text().trim();
            const rawUrl = $(element).find("link").first().text().trim();
            const description = $(element).find("description").first().text().trim();
            const publishedAt = $(element).find("pubDate").first().text().trim();
            const newsSource = $(element).find("News\\:Source, source").first().text().trim();
            const thumbnailUrl = $(element).find("News\\:Image, enclosure").first().text().trim()
                || $(element).find("News\\:Image, enclosure").first().attr("url") || "";

            const url = decodeBingRedirectUrl(rawUrl);
            if (!title || !url) return;

            results.push({
                title,
                description,
                url,
                displayUrl: normalizeDisplayUrl(url),
                publishedAt,
                newsSource,
                thumbnailUrl,
                source: "Bing"
            });
        });

    } catch (error) {
        console.error("Error fetching news from Bing:", (error as Error).message);
    }

    if (results.length) cacheSet(cacheKey, results);
    return results;
}

async function getVideos(q: string, n: number): Promise<VideoResult[]> {
    const limit = Math.max(1, Math.min(50, Number.isFinite(n) ? n : 10));
    const cacheKey = `videos:${q}:${limit}`;
    const cached = cacheGet<VideoResult[]>(cacheKey);
    if (cached) return cached;

    const results: VideoResult[] = [];

    try {
        const html = await requestWithRetry<string>(() => httpClient.get("https://www.youtube.com/results", {
            params: { search_query: q },
            headers: REQUEST_HEADERS
        }));
        const match = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});/);
        if (!match) {
            console.error("Could not find ytInitialData");
            return results;
        }

        const data = JSON.parse(match[1]);
        const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

        for (const section of contents) {
            const items = section?.itemSectionRenderer?.contents || [];
            for (const item of items) {
                const vr = item?.videoRenderer;
                if (!vr) continue;

                const videoId = vr.videoId || "";
                const title = vr.title?.runs?.[0]?.text || "";
                const duration = vr.lengthText?.simpleText || "";
                const publisher = vr.ownerText?.runs?.[0]?.text || "";

                if (!videoId || !title) continue;

                results.push({
                    title,
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                    duration,
                    publisher,
                    source: "YouTube"
                });

                if (results.length >= limit) break;
            }
            if (results.length >= limit) break;
        }

    } catch (error) {
        console.error("Error fetching videos from YouTube:", (error as Error).message);
    }

    if (results.length) cacheSet(cacheKey, results);
    return results;
}

interface EngineStatus { name: string; ok: boolean; latencyMs: number; checkedAt: number; }
let engineStatusCache: { entries: EngineStatus[]; expiresAt: number } = { entries: [], expiresAt: 0 };
const STATUS_CACHE_TTL_MS = 30 * 1000;

async function checkEngine(name: string, fn: () => Promise<any[]>): Promise<EngineStatus> {
    const start = Date.now();
    try {
        const out = await fn();
        return { name, ok: out.length > 0, latencyMs: Date.now() - start, checkedAt: Date.now() };
    } catch {
        return { name, ok: false, latencyMs: Date.now() - start, checkedAt: Date.now() };
    }
}

async function getEngineStatuses(force = false): Promise<EngineStatus[]> {
    if (!force && Date.now() < engineStatusCache.expiresAt && engineStatusCache.entries.length) {
        return engineStatusCache.entries;
    }
    const entries = await Promise.all([
        checkEngine("Google (Web)", () => getGoogle("test", 3)),
        checkEngine("Yandex TR (Web)", () => getYandex("test", 3)),
        checkEngine("Bing (Images)", () => getImages("test", 3)),
        checkEngine("Bing (News)", () => getNews("test", 3)),
        checkEngine("Bing (Videos)", () => getVideos("test", 3))
    ]);
    engineStatusCache = { entries, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
    return entries;
}

app.get("/", async (req, res) => {
    try {
        const statuses = await getEngineStatuses();
        const rows = statuses.map(s => `
            <tr>
                <td>${s.name}</td>
                <td><span class="badge ${s.ok ? "ok" : "down"}">${s.ok ? "Çalışıyor" : "Hata"}</span></td>
                <td>${s.latencyMs} ms</td>
            </tr>`).join("");
        const allOk = statuses.every(s => s.ok);
        const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>Artado Proxy — Hızlı ve Özel Arama</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --line:#e2e5e9; --text:#202124; --muted:#6b7280; --accent:#315efb; }
  * { box-sizing:border-box; } body { margin:0; min-height:100vh; font-family:Arial,Helvetica,sans-serif; color:var(--text); background:var(--bg); }
  .wrap { max-width:1000px; margin:0 auto; padding:0 24px 42px; } .hero { padding:28px 0 46px; text-align:center; }
  .logo { display:inline-flex; align-items:center; gap:9px; font-size:.95rem; font-weight:700; letter-spacing:.08em; color:#30343b; } .logo i { display:grid; place-items:center; width:28px; height:28px; border-radius:7px; background:var(--accent); color:#fff; font-style:normal; font-size:1rem; }
  h1 { margin:60px 0 10px; font-size:clamp(2rem,5vw,3.2rem); letter-spacing:-.04em; line-height:1.1; } .lead { margin:0 auto; max-width:520px; color:var(--muted); line-height:1.5; }
  .search { display:flex; max-width:760px; margin:28px auto 0; padding:5px; gap:5px; border:1px solid #cfd4dc; border-radius:9px; background:var(--panel); box-shadow:0 2px 8px #17203312; }
  input,select,button { border:0; border-radius:6px; font:inherit; } input { flex:1; min-width:0; padding:12px 13px; outline:none; color:var(--text); } select { padding:0 9px; color:#4b5563; background:#f1f3f5; } button { padding:0 20px; color:#fff; cursor:pointer; background:var(--accent); font-weight:600; }
  .summary { display:flex; justify-content:space-between; align-items:center; gap:16px; margin:0 0 12px; padding:13px 16px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--muted); font-size:.9rem; } .summary strong { color:var(--text); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; } .engine { padding:15px 16px; border:1px solid var(--line); border-radius:8px; background:var(--panel); } .engine b { display:block; margin-bottom:10px; font-size:.95rem; } .state { color:#16803c; font-size:.88rem; } .state.down { color:#c62828; } .latency { float:right; color:var(--muted); font-size:.8rem; }
  .links { margin-top:26px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:.9rem; } code { color:#4057a8; } @media(max-width:620px){.search{flex-wrap:wrap}.search input{flex-basis:100%; border-bottom:1px solid var(--line)}.search button,.search select{height:40px}.search button{flex:1}}
</style>
</head>
<body>
  <main class="wrap"><section class="hero"><div class="logo"><i>A</i> ARTADO PROXY</div><h1>Web'de arayın.</h1><p class="lead">Hızlı, sade ve gizlilik odaklı arama.</p><form class="search" action="/api" method="get"><input name="q" placeholder="Aramak istediğinizi yazın" autofocus><select name="source"><option value="all">Tüm motorlar</option><option value="google">Google</option><option value="yandex">Yandex TR</option></select><select name="sort"><option value="relevance">Alaka</option><option value="random">Rastgele</option></select><button type="submit">Ara</button></form></section><section><div class="summary"><span><strong>Motor durumu</strong> · Canlı bağlantı kontrolü</span><span>${allOk ? "● Tümü aktif" : "● Bazı motorlar sorunlu"}</span></div><div class="grid">${statuses.map(s => `<article class="engine"><b>${s.name}</b><span class="state ${s.ok ? "" : "down"}">${s.ok ? "● Çalışıyor" : "● Hata"}</span><span class="latency">${s.latencyMs} ms</span></article>`).join("")}</div><div class="links"><strong>API uç noktaları</strong><p><code>GET /api?q=...&number=10&source=all&sort=relevance</code></p><p>Desteklenen sıralama: <code>relevance</code> (varsayılan) veya <code>random</code>.</p></div>
    </div>
  </section></main>
</body>
</html>`;
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        return res.status(200).send(html);
    } catch (error) {
        console.error(error);
        return res.status(500).send("Internal Server Error");
    }
});

app.get("/api", async (req, res) => {
    try {
        const query = req.query.q as string;
        const nRaw = req.query.number as string;
        const n = Number.parseInt(nRaw || "10", 10);

        if (!query || !query.trim()) {
            return res.status(400).json({ error: "Missing required parameter: q" });
        }

        const querysource = req.query.source as string;
        const source = (querysource || "").toLowerCase();
        const requestedSort = String(req.query.sort || "relevance").toLowerCase();
        const sort: ResultSort = requestedSort === "random" ? "random" : "relevance";

        if (!source) {
            return res.status(400).json({ error: "Missing required parameter: source" });
        }

        if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: "Invalid parameter: number" });
        }

        let results: Results[] = [];

        switch (source) {
            case "google":
                results = await getGoogle(query, n);
                break;
            case "yandex":
            case "turkey":
                results = await getYandex(query, n);
                break;
            case "all": {
                const [google, yandex] = await Promise.all([
                    getGoogle(query, n),
                    getYandex(query, n)
                ]);
                results = mergeResults(google, yandex);
                break;
            }
            default:
                return res.status(400).json({ error: "Invalid source. Use google, yandex, turkey or all." });
        }

        res.setHeader('Content-Type', 'application/json; charset=UTF-8');
        return res.status(200).json(sortResults(results, query.trim(), sort));
    } catch (error) {
        console.error(error);
        return res.status(500).send("Internal Server Error");
    }
})

app.get("/api/images", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || !query.trim()) {
            return res.status(400).json({ error: "Missing required parameter: q" });
        }
        const n = Number.parseInt((req.query.number as string) || "10", 10);
        if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: "Invalid parameter: number" });
        }
        const results = await getImages(query, n);
        res.setHeader("Content-Type", "application/json; charset=UTF-8");
        return res.status(200).json(results);
    } catch (error) {
        console.error(error);
        return res.status(500).send("Internal Server Error");
    }
});

app.get("/api/news", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || !query.trim()) {
            return res.status(400).json({ error: "Missing required parameter: q" });
        }
        const n = Number.parseInt((req.query.number as string) || "10", 10);
        if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: "Invalid parameter: number" });
        }
        const results = await getNews(query, n);
        res.setHeader("Content-Type", "application/json; charset=UTF-8");
        return res.status(200).json(results);
    } catch (error) {
        console.error(error);
        return res.status(500).send("Internal Server Error");
    }
});

app.get("/api/videos", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || !query.trim()) {
            return res.status(400).json({ error: "Missing required parameter: q" });
        }
        const n = Number.parseInt((req.query.number as string) || "10", 10);
        if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: "Invalid parameter: number" });
        }
        const results = await getVideos(query, n);
        res.setHeader("Content-Type", "application/json; charset=UTF-8");
        return res.status(200).json(results);
    } catch (error) {
        console.error(error);
        return res.status(500).send("Internal Server Error");
    }
});

app.get('/status', (req: Request, res: Response) => {
    const status = requestCount > REQUEST_THRESHOLD ? 'BUSY' : 'OK';
    res.send(status);
});

setInterval(() => {
    requestCount = 0;
    console.log('Request count reset to 0');
}, RESET_INTERVAL);

const configuredPort = Number.parseInt(process.env.PORT || "3000", 10);
const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});