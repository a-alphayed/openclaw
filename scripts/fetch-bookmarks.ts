/**
 * Scrape bookmarked tweets from X.com using Playwright.
 *
 * Usage:
 *   npx tsx scripts/fetch-bookmarks.ts
 *
 * Launches a visible Chromium browser with a persistent profile so you only
 * need to log in once. On subsequent runs the saved session is reused.
 *
 * Output: scripts/bookmarks.json
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "bookmarks.json");
const PROFILE_DIR = join(__dirname, ".playwright-profile");
const BOOKMARKS_URL = "https://x.com/i/bookmarks";

// Delay between scroll actions (ms) to avoid rate limiting
const SCROLL_DELAY = 2000;
// How many consecutive scrolls with no new tweets before we consider it done
const MAX_IDLE_SCROLLS = 5;

interface ScrapedTweet {
  id: string;
  authorName: string;
  authorHandle: string;
  text: string;
  timestamp: string | null;
  urls: string[];
  hasMedia: boolean;
  isRetweet: boolean;
  retweetedFrom: string | null;
}

/**
 * Wait for the user to be logged in. If X redirects to a login page or shows
 * a login prompt, we pause and poll until bookmark content appears.
 */
async function waitForLogin(page: Page): Promise<void> {
  console.log("Navigating to bookmarks page...");
  await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded" });

  // Give the page a moment to settle and potentially redirect
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  const needsLogin =
    currentUrl.includes("/login") ||
    currentUrl.includes("/i/flow/login") ||
    currentUrl.includes("/account/access");

  if (needsLogin) {
    console.log("\n=== Login required ===");
    console.log("Please log in to X.com in the browser window.");
    console.log("The script will continue automatically once you're logged in.\n");
  }

  // Wait until we're on the bookmarks page and tweet articles appear.
  // Timeout is generous (10 min) to give the user time to log in manually.
  const maxWait = 10 * 60 * 1000;
  const pollInterval = 2000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    // Re-check: if we drifted away from bookmarks, navigate back
    const url = page.url();
    if (
      url.includes("/login") ||
      url.includes("/i/flow/login") ||
      url.includes("/account/access")
    ) {
      await page.waitForTimeout(pollInterval);
      continue;
    }

    // After login X may redirect to home — go back to bookmarks
    if (!url.includes("/i/bookmarks")) {
      try {
        await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);
      } catch {
        // Navigation may fail transiently
      }
    }

    // Check for tweet articles on the page
    const articleCount = await page.locator('article[data-testid="tweet"]').count();
    if (articleCount > 0) {
      console.log("Bookmarks page loaded. Starting scrape...\n");
      return;
    }

    // Also check for an "empty bookmarks" state
    const emptyState = await page
      .locator('text="You haven\'t added any posts to your Bookmarks yet"')
      .count();
    if (emptyState > 0) {
      console.log("Bookmarks page is empty — no tweets to collect.");
      await writeFile(OUTPUT_PATH, JSON.stringify([], null, 2), "utf-8");
      process.exit(0);
    }

    await page.waitForTimeout(pollInterval);
  }

  throw new Error("Timed out waiting for login / bookmarks to load (10 min).");
}

/**
 * Extract tweet data from all currently-visible article elements.
 * Runs inside the browser via page.evaluate.
 */
async function extractVisibleTweets(page: Page): Promise<ScrapedTweet[]> {
  return page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const results: ScrapedTweet[] = [];

    for (const article of articles) {
      try {
        // --- Tweet ID from the permalink ---
        let id = "";
        const timeLink = article.querySelector('a[href*="/status/"] time')
          ?.parentElement as HTMLAnchorElement | null;
        if (timeLink) {
          const match = timeLink.href.match(/\/status\/(\d+)/);
          if (match) {
            id = match[1];
          }
        }
        // Fallback: any link containing /status/
        if (!id) {
          const statusLink = article.querySelector('a[href*="/status/"]');
          if (statusLink) {
            const match = statusLink.href.match(/\/status\/(\d+)/);
            if (match) {
              id = match[1];
            }
          }
        }
        if (!id) {
          continue;
        } // skip if we can't identify the tweet

        // --- Retweet detection ---
        let isRetweet = false;
        let retweetedFrom: string | null = null;
        const socialContext = article.querySelector('[data-testid="socialContext"]');
        if (socialContext) {
          const text = socialContext.textContent || "";
          if (text.includes("reposted") || text.includes("Retweeted")) {
            isRetweet = true;
            // The name before "reposted" is the person who retweeted
            retweetedFrom =
              text
                .replace(/\s*reposted\s*/i, "")
                .replace(/\s*Retweeted\s*/i, "")
                .trim() || null;
          }
        }

        // --- Author ---
        let authorName = "";
        let authorHandle = "";
        // The user cell usually contains the display name and @handle
        const userNameEl = article.querySelector('[data-testid="User-Name"]');
        if (userNameEl) {
          // Display name is typically the first text-containing span
          const spans = userNameEl.querySelectorAll("span");
          for (const span of spans) {
            const t = (span.textContent || "").trim();
            if (t.startsWith("@")) {
              authorHandle = t;
            } else if (t && !authorName && !t.includes("·") && !/^\d+[hms]$/.test(t) && t !== "…") {
              authorName = t;
            }
          }
          // Fallback: grab handle from link
          if (!authorHandle) {
            const handleLink = userNameEl.querySelector('a[href^="/"]');
            if (handleLink) {
              const href = handleLink.getAttribute("href") || "";
              if (href && !href.includes("/status/")) {
                authorHandle = "@" + href.replace(/^\//, "");
              }
            }
          }
        }

        // --- Text content ---
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const text = tweetTextEl?.textContent?.trim() || "";

        // --- Timestamp ---
        const timeEl = article.querySelector("time");
        const timestamp = timeEl?.getAttribute("datetime") || null;

        // --- URLs ---
        const urls: string[] = [];
        if (tweetTextEl) {
          const links = tweetTextEl.querySelectorAll("a");
          for (const link of links) {
            const href = link.getAttribute("href") || "";
            // Skip internal twitter links like hashtags/mentions unless they wrap a url
            if (href.startsWith("http") && !href.includes("x.com/search")) {
              urls.push(href);
            }
          }
        }
        // Also grab card links
        const cardLink = article.querySelector('[data-testid="card.wrapper"] a');
        if (cardLink?.href && cardLink.href.startsWith("http")) {
          urls.push(cardLink.href);
        }

        // --- Media ---
        const hasMedia =
          article.querySelector('[data-testid="tweetPhoto"]') !== null ||
          article.querySelector('[data-testid="videoPlayer"]') !== null ||
          article.querySelector('[data-testid="tweetMediaGif"]') !== null ||
          article.querySelector("video") !== null;

        results.push({
          id,
          authorName,
          authorHandle,
          text,
          timestamp,
          urls: [...new Set(urls)],
          hasMedia,
          isRetweet,
          retweetedFrom,
        });
      } catch {
        // Skip malformed articles
      }
    }

    return results;
  });
}

/**
 * Scroll through the bookmarks feed, collecting tweets until no new ones appear.
 */
async function scrollAndCollect(page: Page): Promise<ScrapedTweet[]> {
  const seenIds = new Set<string>();
  const allTweets: ScrapedTweet[] = [];
  let idleScrolls = 0;

  while (idleScrolls < MAX_IDLE_SCROLLS) {
    const tweets = await extractVisibleTweets(page);
    let newCount = 0;

    for (const tweet of tweets) {
      if (!seenIds.has(tweet.id)) {
        seenIds.add(tweet.id);
        allTweets.push(tweet);
        newCount++;
      }
    }

    if (newCount > 0) {
      idleScrolls = 0;
      console.log(`  Collected ${newCount} new tweets (total: ${allTweets.length})`);
    } else {
      idleScrolls++;
      if (idleScrolls < MAX_IDLE_SCROLLS) {
        console.log(`  No new tweets found (attempt ${idleScrolls}/${MAX_IDLE_SCROLLS})`);
      }
    }

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(SCROLL_DELAY);

    // Wait for network to settle a bit — new tweets load via XHR
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // networkidle may not fire if the page keeps polling — that's fine
    }
  }

  return allTweets;
}

async function main(): Promise<void> {
  console.log("Launching browser...");
  console.log(`Using profile directory: ${PROFILE_DIR}\n`);

  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const page = context.pages()[0] || (await context.newPage());

    await waitForLogin(page);

    const tweets = await scrollAndCollect(page);

    console.log(`\nDone. Total bookmarks collected: ${tweets.length}`);

    // Sort by timestamp descending (newest first), null timestamps last
    tweets.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) {
        return 0;
      }
      if (!a.timestamp) {
        return 1;
      }
      if (!b.timestamp) {
        return -1;
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    await writeFile(OUTPUT_PATH, JSON.stringify(tweets, null, 2), "utf-8");
    console.log(`Saved to ${OUTPUT_PATH}`);
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    if (context) {
      await context.close();
    }
  }
}

void main();
