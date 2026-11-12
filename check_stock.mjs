import { chromium } from 'playwright';

const PRODUCT_URL =
  process.env.PRODUCT_URL ||
  'https://www.cos.com/en-gb/men/accessories/bagswallets/totebags/product/trullo-oversized-flap-bag-leather-ebony-1361103002';
const PRODUCT_NAME = 'COS Trullo Oversized Flap Bag (Leather, Ebony - 1361103002)';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FORCE_NOTIFY = process.env.FORCE_NOTIFY === 'true';

/**
 * Sends a notification message via Telegram Bot API.
 */
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(
      'Skipping Telegram notification: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set.'
    );
    return;
  }

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API error (${response.status}): ${errText}`);
  }

  console.log('Telegram notification sent successfully.');
}

/**
 * Extracts stock status and price from the loaded COS product page.
 */
async function evaluateProductPage(page) {
  return await page.evaluate(() => {
    const title = document.title || '';
    const bodyText = document.body ? document.body.innerText : '';

    // 1. Detect if the site refused the request (Akamai "Access Denied" page)
    if (
      title.toLowerCase().includes('access denied') ||
      bodyText.includes('errors.edgesuite.net')
    ) {
      return {
        blocked: true,
        inStock: false,
        reason: 'cos.com refused the request (Access Denied)',
        price: null,
      };
    }

    // 2. Check JSON-LD structured data (<script type="application/ld+json">)
    const ldJsonScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    let schemaAvailability = null;
    let price = null;

    for (const script of ldJsonScripts) {
      try {
        const parsed = JSON.parse(script.textContent || '{}');
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item['@type'] === 'Product' && item.offers) {
            const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
            for (const offer of offers) {
              if (offer.price) {
                price = `${offer.price} ${offer.priceCurrency || 'GBP'}`;
              }
              if (offer.availability) {
                schemaAvailability = String(offer.availability);
              }
            }
          }
        }
      } catch {
        // Ignore malformed JSON-LD blocks
      }
    }

    if (schemaAvailability) {
      const lowerAvail = schemaAvailability.toLowerCase();
      if (lowerAvail.includes('instock')) {
        return {
          blocked: false,
          inStock: true,
          reason: `JSON-LD schema availability: ${schemaAvailability}`,
          price,
        };
      }
      if (
        lowerAvail.includes('outofstock') ||
        lowerAvail.includes('soldout') ||
        lowerAvail.includes('discontinued')
      ) {
        return {
          blocked: false,
          inStock: false,
          reason: `JSON-LD schema availability: ${schemaAvailability}`,
          price,
        };
      }
    }

    // 3. Fallback: Check visible buttons and stock labels on the page
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
      text: (b.innerText || b.textContent || '').trim().toUpperCase(),
      disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
    }));

    const addToBagBtn = buttons.find(
      (b) => b.text.includes('ADD TO BAG') || b.text.includes('ADD TO CART')
    );
    if (addToBagBtn && !addToBagBtn.disabled) {
      return {
        blocked: false,
        inStock: true,
        reason: `Found active "${addToBagBtn.text}" button`,
        price,
      };
    }

    const upperBody = bodyText.toUpperCase();
    if (
      upperBody.includes('OUT OF STOCK') ||
      upperBody.includes('SOLD OUT') ||
      upperBody.includes('COMING SOON')
    ) {
      return {
        blocked: false,
        inStock: false,
        reason: 'Page text indicates Out of Stock / Sold Out',
        price,
      };
    }

    return {
      blocked: false,
      inStock: false,
      reason: `Loaded page ("${title}"), no active Add to Bag button found`,
      price,
    };
  });
}

async function runCheck() {
  console.log(`Checking stock for: ${PRODUCT_NAME}`);
  console.log(`URL: ${PRODUCT_URL}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  let result;
  try {
    const context = await browser.newContext({
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    result = await evaluateProductPage(page);
  } finally {
    await browser.close();
  }

  console.log('Check result:', JSON.stringify(result, null, 2));

  if (result.inStock) {
    const priceLine = result.price ? `\n💰 <b>Price:</b> ${result.price}` : '';
    const message =
      `🟢 <b>IN STOCK ALERT!</b>\n\n` +
      `👜 <b>${PRODUCT_NAME}</b> is now available!${priceLine}\n` +
      `ℹ️ <i>${result.reason}</i>\n\n` +
      `🔗 <a href="${PRODUCT_URL}">Buy now on COS UK</a>`;
    await sendTelegramMessage(message);
  } else if (FORCE_NOTIFY) {
    const statusIcon = result.blocked ? '⚠️' : '🔴';
    const message =
      `${statusIcon} <b>COS Stock Check (Test Notification)</b>\n\n` +
      `👜 <b>${PRODUCT_NAME}</b>\n` +
      `📌 <b>Status:</b> ${result.blocked ? 'Could not check (blocked)' : 'Not in stock'}\n` +
      `ℹ️ <i>${result.reason}</i>\n\n` +
      `🔗 <a href="${PRODUCT_URL}">View product page</a>`;
    await sendTelegramMessage(message);
  } else {
    console.log(
      result.blocked
        ? 'Could not check stock: request was refused by cos.com.'
        : 'Item is not in stock. No Telegram alert sent.'
    );
  }
}

runCheck().catch((err) => {
  console.error('Stock check failed:', err);
  process.exit(1);
});
