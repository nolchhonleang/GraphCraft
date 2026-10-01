/**
 * Capture a clean GraphCraft screenshot for README.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const OUT = path.resolve(__dirname, "../docs/screenshot.png");
const URL = "http://127.0.0.1:5174/";
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function waitForUi(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(URL, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
            resolve(undefined);
          } else {
            reject(new Error("bad status"));
          }
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("UI not reachable");
}

async function main() {
  await waitForUi();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    execFileSync("npm", ["install", "--no-save", "puppeteer-core@23.11.1"], {
      stdio: "inherit",
      cwd: path.resolve(__dirname, "../frontend"),
      shell: true,
    });
    puppeteer = require(path.resolve(__dirname, "../frontend/node_modules/puppeteer-core"));
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
    args: ["--hide-scrollbars", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Dismiss first-run overlays / error banners for a clean hero shot
    await page.evaluate(() => {
      try {
        localStorage.setItem("graphcraft.welcome.dismissed", "1");
      } catch {
        // ignore
      }
      document.querySelectorAll(".banner-error .ghost-btn, .help-banner .ghost-btn, .hint-dismiss").forEach((el) => {
        if (el instanceof HTMLElement) {
          el.click();
        }
      });
    });

    await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(".graph-canvas", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    // Click Fit so the graph fills the canvas
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const fit = buttons.find((b) => b.textContent?.trim() === "Fit");
      fit?.click();
      document.querySelectorAll(".banner-error .ghost-btn, .help-banner .ghost-btn, .hint-dismiss").forEach((el) => {
        if (el instanceof HTMLElement) {
          el.click();
        }
      });
    });

    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: OUT, type: "png", fullPage: false });
    console.log("wrote", OUT, fs.statSync(OUT).size, "bytes");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
