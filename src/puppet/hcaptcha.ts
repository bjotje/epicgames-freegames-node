import fs from 'fs-extra';
import { ElementHandle, Protocol } from 'puppeteer';
import path from 'path';
import puppeteer, { getDevtoolsUrl } from '../common/puppeteer';
import { config, CONFIG_DIR } from '../common/config';
import L from '../common/logger';

const HCAPTCHA_ACCESSIBILITY_CACHE_FILE = path.join(
  CONFIG_DIR,
  'hcaptcha-accessibility-cache.json'
);

const CACHE_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

const getCookieCache = async (): Promise<Protocol.Network.Cookie[] | null> => {
  try {
    await fs.access(HCAPTCHA_ACCESSIBILITY_CACHE_FILE, fs.constants.O_RDWR);
    const cookieData: Protocol.Network.Cookie[] = await fs.readJSON(
      HCAPTCHA_ACCESSIBILITY_CACHE_FILE
    );
    const cookieExpiryString = cookieData.find((c) => c.name === 'hc_accessibility')?.expires;
    if (!cookieExpiryString) return null;
    if (new Date(cookieExpiryString * 1000).getTime() < Date.now() + CACHE_BUFFER_MS) return null;
    return cookieData;
  } catch (err) {
    return null;
  }
};

const setCookieCache = async (cookies: Protocol.Network.Cookie[]): Promise<void> => {
  await fs.writeJSON(HCAPTCHA_ACCESSIBILITY_CACHE_FILE, cookies);
};

export const getHcaptchaCookies = async (): Promise<Protocol.Network.Cookie[]> => {
  const { hcaptchaAccessibilityUrl } = config;
  if (!hcaptchaAccessibilityUrl) {
    L.warn(
      'hcaptchaAccessibilityUrl not configured, captchas are less likely to be bypassed. Follow this guide to set it up: https://github.com/claabs/epicgames-freegames-node#hcaptcha-accessibility-cookies'
    );
    return [];
  }
  let cookieData = await getCookieCache();
  if (!cookieData) {
    try {
      L.debug('Setting hCaptcha accessibility cookies');
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();

      L.trace(getDevtoolsUrl(page));
      L.trace(`Navigating to ${hcaptchaAccessibilityUrl}`);
      await Promise.all([
        page.goto(hcaptchaAccessibilityUrl),
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
      ]);
      L.trace(`Waiting for setAccessibilityCookie button`);
      const setCookieButton = (await page.waitForSelector(
        `button[data-cy='setAccessibilityCookie']:not([disabled])`
      )) as ElementHandle<HTMLButtonElement>;
      L.trace(`Clicking setAccessibilityCookie button`);
      const [statusAlert] = await Promise.all([
        page.waitForSelector(`span[data-cy='fetchStatus']`) as Promise<
          ElementHandle<HTMLSpanElement>
        >,
        setCookieButton.click({ delay: 100 }),
      ]);
      const setCookieMessage = await statusAlert.evaluate((el) => el.innerText);
      L.trace({ setCookieMessage }, 'hCaptcha set cookie response');
      if (setCookieMessage !== 'Cookie set.') {
        L.warn({ setCookieMessage }, 'Unexpected set cookie response from hCaptcha');
      }

      L.trace(`Saving new cookies`);
      const cdpClient = await page.target().createCDPSession();
      const currentUrlCookies = (await cdpClient.send('Network.getAllCookies')) as {
        cookies: Protocol.Network.Cookie[];
      };
      await browser.close();
      cookieData = currentUrlCookies.cookies;
      await setCookieCache(cookieData);
    } catch (err) {
      L.warn(err);
      L.warn(
        'Setting the hCaptcha accessibility cookies encountered an error. Continuing without them...'
      );
      return [];
    }
  }
  return cookieData;
};