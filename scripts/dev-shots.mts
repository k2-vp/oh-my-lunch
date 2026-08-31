import { chromium } from "playwright";
const out = process.argv[2] ?? "/tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:5173/harness.html");
await page.waitForFunction(() => Boolean((window as any).__HARNESS__));
for (const [label, file, settle] of [
  ["countdown", "align-countdown.png", 400],
  ["reveal", "align-reveal.png", 2600],
  ["confirmed", "align-confirmed.png", 600],
] as const) {
  await page.evaluate((l) => (window as any).__HARNESS__.show(l), label);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${out}/${file}` });
}
await browser.close();
console.log("shots done");
