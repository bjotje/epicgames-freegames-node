import { TOTP } from 'otpauth';
import { Logger } from 'pino';
import { ElementHandle, Page, Response } from 'puppeteer';
import logger from '../common/logger';
import puppeteer, {
  puppeteerCookieToToughCookieFileStore,
  toughCookieFileStoreToPuppeteerCookie,
} from '../common/puppeteer';
import { getCookiesRaw, mergeCookiesRaw } from '../common/request';
import { setHcaptchaCookies } from './hcaptcha';

const NOTIFICATION_TIMEOUT = 24 * 60 * 60 * 1000; // TODO: Add to config

export default class PuppetLogin {
  private L: Logger;

  private email: string;

  private password: string;

  private totp?: string;

  constructor(email: string, password: string, totp?: string) {
    this.L = logger.child({
      user: email,
    });
    this.email = email;
    this.password = password;
    this.totp = totp;
  }

  async login(): Promise<void> {
    await setHcaptchaCookies(this.email);
    const userCookies = await getCookiesRaw(this.email);
    const puppeteerCookies = toughCookieFileStoreToPuppeteerCookie(userCookies);
    this.L.debug('Logging in with puppeteer');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    page.setCookie(...puppeteerCookies);
    this.L.trace('Navigating to Epic Games login page');
    await Promise.all([
      page.goto('https://www.epicgames.com/id/login/epic'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    this.L.trace('Waiting for email field');
    const emailElem = await page.waitForSelector('#email');
    this.L.trace('Filling email field');
    await emailElem.type(this.email);
    this.L.trace('Waiting for password field');
    const passElem = await page.waitForSelector('#password');
    this.L.trace('Filling password field');
    await passElem.type(this.password);
    this.L.trace('Waiting for sign-in button');
    const signInElem = await page.waitForSelector('#sign-in:not([disabled]');
    // Remember me should be checked by default
    this.L.trace('Clicking sign-in button');
    try {
      await Promise.all([
        await signInElem.click({ delay: 100 }),
        await this.handleLoginClick(page),
      ]);
    } catch (err) {
      await page.screenshot({ path: 'test.png' });
      throw err;
    }
    this.L.trace('Saving new cookies');
    const currentUrlCookies = await page.cookies();
    await browser.close();
    const cookieData = puppeteerCookieToToughCookieFileStore(currentUrlCookies);
    await mergeCookiesRaw(this.email, cookieData);
  }

  // eslint-disable-next-line class-methods-use-this
  private async handleLoginClick(page: Page): Promise<void> {
    this.L.trace('Waiting for sign-in result');
    const result = await Promise.race([
      page.waitForSelector(`iframe[src*='hcaptcha']`), // TODO: this isn't detecting for some reason?
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
    ]);
    if (!(result instanceof Response)) {
      this.L.trace('Captcha detected');
      const portalUrl = await page.openPortal();
      this.L.info({ portalUrl }, 'Go to this URL and do something');
      // TODO: Notify with url
      await this.handleMfa(page);
      await page.closePortal();
    }
  }

  private async handleMfa(page: Page): Promise<void> {
    this.L.trace('Waiting for MFA possibility');
    const result = await Promise.race([
      page.waitForSelector(`input[name="code-input-0]`, {
        timeout: NOTIFICATION_TIMEOUT,
      }),
      page.waitForNavigation({
        waitUntil: 'networkidle0',
        timeout: NOTIFICATION_TIMEOUT,
      }),
    ]);
    if (!(result instanceof Response)) {
      this.L.trace('MFA detected');
      if (!this.totp) throw new Error('TOTP required for MFA login');
      const totp = new TOTP({ secret: this.totp });
      const mfaCode = totp.generate();
      this.L.trace('Filling MFA field');
      await (result as ElementHandle<Element>).type(mfaCode);
      this.L.trace('Waiting for continue button');
      const continueButton = await page.waitForSelector(`button#continue`);
      this.L.trace('Clicking continue button');
      await Promise.all([
        await continueButton.click({ delay: 100 }),
        await page.waitForNavigation({ waitUntil: 'networkidle0' }),
      ]);
    }
  }
}
