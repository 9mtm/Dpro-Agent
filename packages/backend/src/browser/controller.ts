import { safeConsole } from '../services/safe-error-log.js';
/**
 * Browser Controller
 * Manages browser instances and sessions
 */

import { dataPathOr } from '../config/data-root.js';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync } from 'fs';
import {
  type BrowserConfig,
  type BrowserSession,
  type BrowserStatus,
  type BrowserStats,
  type ElementInfo,
  type NavigationOptions,
  type ClickOptions,
  type TypeOptions,
  type SelectOptions,
  type WaitOptions,
  type ScreenshotOptions,
  type PdfOptions,
  type ScriptResult,
  type NetworkRequest,
  type NetworkResponse,
  type ConsoleMessage,
  type PageMetrics,
  type BrowserAction,
  type BoundingBox,
  DEFAULT_BROWSER_CONFIG,
} from './types.js';
import { checkBrowserUrl, guardPage } from './url-guard.js';

// Puppeteer types (dynamic import)
type Browser = any;
type Page = any;

interface SessionData {
  session: BrowserSession;
  browser: Browser | null;
  pages: Map<string, Page>;
  currentPageId: string | null;
  actions: BrowserAction[];
  networkRequests: NetworkRequest[];
  networkResponses: NetworkResponse[];
  consoleMessages: ConsoleMessage[];
  /** BROWSER-01: requests the URL guard refused (newest last, bounded). */
  blockedRequests: Array<{ url: string; reason: string; at: Date }>;
}

export class BrowserController {
  private sessions: Map<string, SessionData> = new Map();
  private screenshotDir: string = dataPathOr('./.data/browser/screenshots', 'browser', 'screenshots');
  private downloadDir: string = dataPathOr('./.data/browser/downloads', 'browser', 'downloads');
  private startTime: Date = new Date();
  private stats: BrowserStats = {
    activeSessions: 0,
    totalSessions: 0,
    totalNavigations: 0,
    totalActions: 0,
    failedActions: 0,
    totalScreenshots: 0,
    uptime: 0,
  };

  constructor() {
    // Ensure directories exist
    if (!existsSync(this.screenshotDir)) {
      mkdirSync(this.screenshotDir, { recursive: true });
    }
    if (!existsSync(this.downloadDir)) {
      mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Create a new browser session
   */
  async createSession(config: Partial<BrowserConfig> = {}): Promise<BrowserSession> {
    const puppeteer = await this.loadPuppeteer();
    if (!puppeteer) {
      throw new Error('Puppeteer is not available. Install puppeteer package.');
    }

    const sessionId = `browser_${uuidv4()}`;
    const fullConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, ...config };

    const launchOptions: any = {
      headless: fullConfig.headless,
      args: [
        // SECURITY: Removed --no-sandbox and --disable-setuid-sandbox for better security
        // Only disable /dev/shm usage for stability in containerized environments
        '--disable-dev-shm-usage',
        `--window-size=${fullConfig.viewportWidth},${fullConfig.viewportHeight}`,
      ],
      acceptInsecureCerts: fullConfig.ignoreHttpsErrors,
    };

    // SECURITY: Validate proxy configuration to prevent SSRF (H-10)
    if (fullConfig.proxy) {
      const proxyServer = fullConfig.proxy.server;

      // Validate proxy format and block internal/private IPs
      if (!this.isValidProxyServer(proxyServer)) {
        throw new Error(
          `SECURITY: Invalid or unsafe proxy server rejected: ${proxyServer}. ` +
          `Proxy must be external (no localhost, 127.0.0.1, 192.168.x.x, 10.x.x.x, 172.16-31.x.x, [::1])`
        );
      }

      launchOptions.args.push(`--proxy-server=${proxyServer}`);
    }

    const browser = await puppeteer.launch(launchOptions);
    // BROWSER-01: every page may only load public http(s) (or data:/about:);
    // pop-ups and new tabs are guarded as soon as they appear.
    const blockedRequests: SessionData['blockedRequests'] = [];
    const onBlocked = (url: string, reason: string) => {
      blockedRequests.push({ url, reason, at: new Date() });
      if (blockedRequests.length > 200) blockedRequests.splice(0, 50);
      console.warn(`[Browser] Blocked request (${reason})`);
    };
    browser.on('targetcreated', async (target: any) => {
      try {
        const opened = await target.page();
        if (opened) await guardPage(opened, onBlocked);
      } catch {
        // Not a page target, or it closed already.
      }
    });
    const page = await browser.newPage();
    await guardPage(page, onBlocked);
    const pageId = `page_${uuidv4()}`;

    // Configure page
    await page.setViewport({
      width: fullConfig.viewportWidth,
      height: fullConfig.viewportHeight,
      deviceScaleFactor: fullConfig.device?.deviceScaleFactor || 1,
      isMobile: fullConfig.device?.isMobile || false,
      hasTouch: fullConfig.device?.hasTouch || false,
    });

    if (fullConfig.userAgent || fullConfig.device?.userAgent) {
      await page.setUserAgent(fullConfig.userAgent || fullConfig.device?.userAgent);
    }

    if (fullConfig.extraHeaders) {
      await page.setExtraHTTPHeaders(fullConfig.extraHeaders);
    }

    await page.setJavaScriptEnabled(fullConfig.javascript);

    // Set default timeouts
    page.setDefaultTimeout(fullConfig.timeout);
    page.setDefaultNavigationTimeout(fullConfig.navigationTimeout);

    const now = new Date();
    const session: BrowserSession = {
      id: sessionId,
      createdAt: now,
      lastActivity: now,
      status: 'idle',
      config: fullConfig,
      pageCount: 1,
      cookiesCount: 0,
    };

    const sessionData: SessionData = {
      session,
      browser,
      pages: new Map([[pageId, page]]),
      currentPageId: pageId,
      actions: [],
      networkRequests: [],
      networkResponses: [],
      consoleMessages: [],
      blockedRequests,
    };

    // Set up event listeners
    this.setupPageListeners(sessionData, page);

    this.sessions.set(sessionId, sessionData);
    this.stats.activeSessions++;
    this.stats.totalSessions++;

    console.log(`[Browser] Created session: ${sessionId}`);
    return session;
  }

  /** The current (Puppeteer) page of a session, for the page helpers of the browser tools. */
  getPage(sessionId: string): Page | null {
    const sessionData = this.sessions.get(sessionId);
    return sessionData ? this.getCurrentPage(sessionData) : null;
  }

  /** BROWSER-01: requests the URL guard refused in this session. */
  getBlockedRequests(sessionId: string): Array<{ url: string; reason: string; at: Date }> {
    return [...(this.sessions.get(sessionId)?.blockedRequests ?? [])];
  }

  /**
   * Close a browser session
   */
  async closeSession(sessionId: string): Promise<boolean> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;

    try {
      if (sessionData.browser) {
        await sessionData.browser.close();
      }
    } catch (error) {
      console.error(`[Browser] Error closing browser:`, error);
    }

    sessionData.session.status = 'closed';
    this.sessions.delete(sessionId);
    this.stats.activeSessions--;

    safeConsole.log(`[Browser] Closed session: ${sessionId}`);
    return true;
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): BrowserSession | null {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return null;

    // Update cookies count
    this.updateSessionInfo(sessionId);
    return sessionData.session;
  }

  /**
   * List all sessions
   */
  listSessions(): BrowserSession[] {
    return Array.from(this.sessions.values()).map((sd) => sd.session);
  }

  /**
   * Navigate to URL
   */
  async navigate(
    sessionId: string,
    url: string,
    options: NavigationOptions = {}
  ): Promise<{ success: boolean; finalUrl?: string; title?: string; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    // BROWSER-01: a clear refusal instead of net::ERR_BLOCKED_BY_CLIENT.
    const verdict = await checkBrowserUrl(url);
    if (!verdict.ok) return { success: false, error: `Blocked: ${verdict.reason}` };

    const action = this.startAction(sessionData, 'navigate', undefined, url);
    sessionData.session.status = 'navigating';

    try {
      const waitUntil = options.waitUntil || 'domcontentloaded';
      const response = await page.goto(url, {
        waitUntil,
        timeout: options.timeout || sessionData.session.config.navigationTimeout,
        referer: options.referer,
      });

      const finalUrl = page.url();
      const title = await page.title();

      sessionData.session.currentUrl = finalUrl;
      sessionData.session.pageTitle = title;
      sessionData.session.status = 'idle';
      sessionData.session.lastActivity = new Date();

      this.endAction(action, true);
      this.stats.totalNavigations++;

      return { success: true, finalUrl, title };
    } catch (error: any) {
      sessionData.session.status = 'error';
      sessionData.session.error = error.message;
      this.endAction(action, false, error.message);

      return { success: false, error: error.message };
    }
  }

  /**
   * Click an element
   */
  async click(
    sessionId: string,
    selector: string,
    options: ClickOptions = {}
  ): Promise<{ success: boolean; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    const action = this.startAction(sessionData, 'click', selector);
    sessionData.session.status = 'interacting';

    try {
      const clickOpts: any = {
        button: options.button || 'left',
        clickCount: options.clickCount || 1,
        delay: options.delay,
      };

      if (options.position) {
        clickOpts.position = options.position;
      }

      if (options.force) {
        await page.click(selector, { ...clickOpts, force: true });
      } else {
        await page.click(selector, clickOpts);
      }

      sessionData.session.status = 'idle';
      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);

      return { success: true };
    } catch (error: any) {
      sessionData.session.status = 'error';
      this.endAction(action, false, error.message);

      return { success: false, error: error.message };
    }
  }

  /**
   * Type text into an element
   */
  async type(
    sessionId: string,
    selector: string,
    text: string,
    options: TypeOptions = {}
  ): Promise<{ success: boolean; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    const action = this.startAction(sessionData, 'type', selector, text);
    sessionData.session.status = 'interacting';

    try {
      if (options.clear) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
      }

      await page.type(selector, text, { delay: options.delay || 0 });

      sessionData.session.status = 'idle';
      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);

      return { success: true };
    } catch (error: any) {
      sessionData.session.status = 'error';
      this.endAction(action, false, error.message);

      return { success: false, error: error.message };
    }
  }

  /**
   * Select option from dropdown
   */
  async select(
    sessionId: string,
    selector: string,
    options: SelectOptions
  ): Promise<{ success: boolean; selected?: string[]; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    const action = this.startAction(sessionData, 'select', selector, JSON.stringify(options));
    sessionData.session.status = 'interacting';

    try {
      let selected: string[] = [];

      if (options.value) {
        const values = Array.isArray(options.value) ? options.value : [options.value];
        selected = await page.select(selector, ...values);
      } else if (options.label) {
        // Select by label requires evaluate
        const labels = Array.isArray(options.label) ? options.label : [options.label];
        selected = await page.evaluate(
          (sel: string, labels: string[]) => {
            const select = document.querySelector(sel) as HTMLSelectElement;
            if (!select) return [];
            const selectedValues: string[] = [];
            for (const option of select.options) {
              if (labels.includes(option.text)) {
                option.selected = true;
                selectedValues.push(option.value);
              }
            }
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return selectedValues;
          },
          selector,
          labels
        );
      }

      sessionData.session.status = 'idle';
      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);

      return { success: true, selected };
    } catch (error: any) {
      sessionData.session.status = 'error';
      this.endAction(action, false, error.message);

      return { success: false, error: error.message };
    }
  }

  /**
   * Wait for element
   */
  async waitForElement(
    sessionId: string,
    selector: string,
    options: WaitOptions = {}
  ): Promise<{ success: boolean; found: boolean; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, found: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, found: false, error: 'No active page' };

    const action = this.startAction(sessionData, 'wait', selector);
    sessionData.session.status = 'waiting';

    try {
      const waitOpts: any = {
        timeout: options.timeout || sessionData.session.config.timeout,
      };

      if (options.visible) waitOpts.visible = true;
      if (options.hidden) waitOpts.hidden = true;

      await page.waitForSelector(selector, waitOpts);

      sessionData.session.status = 'idle';
      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);

      return { success: true, found: true };
    } catch (error: any) {
      sessionData.session.status = 'idle';
      this.endAction(action, false, error.message);

      return { success: false, found: false, error: error.message };
    }
  }

  /**
   * Get element info
   */
  async getElementInfo(sessionId: string, selector: string): Promise<ElementInfo | null> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return null;

    const page = this.getCurrentPage(sessionData);
    if (!page) return null;

    try {
      const info = await page.evaluate((sel: string) => {
        const element = document.querySelector(sel);
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        const styles = window.getComputedStyle(element);

        const info: any = {
          tagName: element.tagName.toLowerCase(),
          id: element.id || undefined,
          classes: Array.from(element.classList),
          textContent: element.textContent?.trim().slice(0, 500),
          innerHTML: element.innerHTML?.slice(0, 1000),
          attributes: {},
          boundingBox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          isVisible: styles.display !== 'none' && styles.visibility !== 'hidden' && rect.width > 0,
          isEnabled: !(element as HTMLElement).hasAttribute('disabled'),
          isEditable:
            element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            (element as HTMLElement).isContentEditable,
        };

        // Get attributes
        for (const attr of element.attributes) {
          info.attributes[attr.name] = attr.value;
        }

        // Checkbox/radio checked state
        if (element.tagName === 'INPUT') {
          const input = element as HTMLInputElement;
          if (input.type === 'checkbox' || input.type === 'radio') {
            info.isChecked = input.checked;
          }
        }

        // Select selected option
        if (element.tagName === 'SELECT') {
          const select = element as HTMLSelectElement;
          info.selectedOption = select.options[select.selectedIndex]?.text;
        }

        return info;
      }, selector);

      return info;
    } catch {
      return null;
    }
  }

  /**
   * Take screenshot
   */
  async screenshot(
    sessionId: string,
    options: ScreenshotOptions = {}
  ): Promise<{ success: boolean; path?: string; base64?: string; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    const action = this.startAction(sessionData, 'screenshot');

    try {
      const filename = `screenshot_${sessionId}_${Date.now()}.${options.format || 'png'}`;
      const path = `${this.screenshotDir}/${filename}`;

      const screenshotOpts: any = {
        path,
        type: options.format || 'png',
        fullPage: options.fullPage || false,
        omitBackground: options.omitBackground || false,
      };

      if (options.quality && (options.format === 'jpeg' || options.format === 'webp')) {
        screenshotOpts.quality = options.quality;
      }

      if (options.clip) {
        screenshotOpts.clip = options.clip;
      }

      const buffer = await page.screenshot(screenshotOpts);
      const base64 = buffer.toString('base64');

      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);
      action.screenshotPath = path;
      this.stats.totalScreenshots++;

      // Index in storage manifest (best-effort, never blocks)
      void import('../services/storage-manager.js').then(({ getStorageManager }) => {
        const pageUrl = page.url?.() ?? 'browser';
        void getStorageManager().indexExistingFile({
          zone: 'cache',
          category: 'screenshots',
          filepath: path,
          filename,
          mimeType: options.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          description: `Browser screenshot — ${pageUrl}`,
          tags: ['screenshot', 'browser', sessionId],
          ttl: 'session',
          createdBy: 'agent',
        });
      }).catch(() => { /* storage index is optional */ });

      return { success: true, path, base64 };
    } catch (error: any) {
      this.endAction(action, false, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate PDF
   */
  async pdf(
    sessionId: string,
    options: PdfOptions = {}
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    try {
      const filename = `page_${sessionId}_${Date.now()}.pdf`;
      const path = `${this.screenshotDir}/${filename}`;

      await page.pdf({
        path,
        format: options.format || 'a4',
        landscape: options.landscape || false,
        scale: options.scale || 1,
        printBackground: options.printBackground || true,
        margin: options.margin,
        headerTemplate: options.headerTemplate,
        footerTemplate: options.footerTemplate,
      });

      sessionData.session.lastActivity = new Date();
      return { success: true, path };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute JavaScript
   */
  async evaluate(
    sessionId: string,
    script: string,
    args: unknown[] = []
  ): Promise<ScriptResult> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found', duration: 0 };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page', duration: 0 };

    const action = this.startAction(sessionData, 'script', undefined, script);
    const startTime = Date.now();

    try {
      // Create function from script string
      const fn = new Function(...args.map((_, i) => `arg${i}`), script);
      const result = await page.evaluate(fn, ...args);

      const duration = Date.now() - startTime;
      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);

      return { success: true, value: result, duration };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.endAction(action, false, error.message);

      return { success: false, error: error.message, duration };
    }
  }

  /**
   * Scroll page
   */
  async scroll(
    sessionId: string,
    options: { x?: number; y?: number; selector?: string; direction?: 'up' | 'down' }
  ): Promise<{ success: boolean; error?: string }> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { success: false, error: 'Session not found' };

    const page = this.getCurrentPage(sessionData);
    if (!page) return { success: false, error: 'No active page' };

    const action = this.startAction(sessionData, 'scroll', options.selector);

    try {
      if (options.selector) {
        await page.evaluate((sel: string) => {
          document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, options.selector);
      } else if (options.x !== undefined || options.y !== undefined) {
        await page.evaluate(
          (x: number, y: number) => {
            window.scrollTo({ left: x, top: y, behavior: 'smooth' });
          },
          options.x || 0,
          options.y || 0
        );
      } else if (options.direction) {
        const delta = options.direction === 'down' ? 500 : -500;
        await page.evaluate((d: number) => {
          window.scrollBy({ top: d, behavior: 'smooth' });
        }, delta);
      }

      sessionData.session.lastActivity = new Date();
      this.endAction(action, true);
      return { success: true };
    } catch (error: any) {
      this.endAction(action, false, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get page metrics
   */
  async getMetrics(sessionId: string): Promise<PageMetrics | null> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return null;

    const page = this.getCurrentPage(sessionData);
    if (!page) return null;

    try {
      const metrics = await page.metrics();
      const performanceData = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return {
          domContentLoaded: perf?.domContentLoadedEventEnd - perf?.domContentLoadedEventStart || 0,
          loadTime: perf?.loadEventEnd - perf?.loadEventStart || 0,
          domNodes: document.getElementsByTagName('*').length,
        };
      });

      return {
        domContentLoaded: performanceData.domContentLoaded,
        loadTime: performanceData.loadTime,
        domNodes: performanceData.domNodes,
        jsHeapUsed: metrics.JSHeapUsedSize || 0,
        layoutCount: metrics.LayoutCount || 0,
        scriptDuration: metrics.ScriptDuration || 0,
        resourceCount: sessionData.networkRequests.length,
        bytesTransferred: sessionData.networkResponses.reduce((sum, r) => sum + r.bodySize, 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get action history
   */
  getActions(sessionId: string, limit: number = 50): BrowserAction[] {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return [];

    return sessionData.actions.slice(-limit);
  }

  /**
   * Get console messages
   */
  getConsoleMessages(sessionId: string, limit: number = 100): ConsoleMessage[] {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return [];

    return sessionData.consoleMessages.slice(-limit);
  }

  /**
   * Get network requests
   */
  getNetworkRequests(sessionId: string, limit: number = 100): NetworkRequest[] {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return [];

    return sessionData.networkRequests.slice(-limit);
  }

  /**
   * Get stats
   */
  getStats(): BrowserStats {
    return {
      ...this.stats,
      uptime: Date.now() - this.startTime.getTime(),
    };
  }

  // ============ Private Methods ============

  private async loadPuppeteer(): Promise<any> {
    try {
      // Dynamic import to handle optional dependency
      const puppeteerModule = await (async () => {
        try {
          // @ts-ignore - puppeteer is optional
          return await import('puppeteer');
        } catch {
          return null;
        }
      })();
      return puppeteerModule?.default || puppeteerModule;
    } catch {
      console.warn('[Browser] Puppeteer not available');
      return null;
    }
  }

  private getCurrentPage(sessionData: SessionData): Page | null {
    if (!sessionData.currentPageId) return null;
    return sessionData.pages.get(sessionData.currentPageId) || null;
  }

  private async updateSessionInfo(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;

    const page = this.getCurrentPage(sessionData);
    if (!page) return;

    try {
      const cookies = await page.cookies();
      sessionData.session.cookiesCount = cookies.length;
      sessionData.session.currentUrl = page.url();
      sessionData.session.pageTitle = await page.title();
    } catch {
      // Ignore errors during info update
    }
  }

  private setupPageListeners(sessionData: SessionData, page: Page): void {
    // Console messages
    page.on('console', (msg: any) => {
      sessionData.consoleMessages.push({
        type: msg.type() as ConsoleMessage['type'],
        text: msg.text(),
        location: msg.location(),
        timestamp: new Date(),
      });

      // Limit console messages
      if (sessionData.consoleMessages.length > 500) {
        sessionData.consoleMessages.splice(0, 100);
      }
    });

    // Network requests
    page.on('request', (request: any) => {
      sessionData.networkRequests.push({
        id: request.url() + Date.now(),
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
        resourceType: request.resourceType(),
        timestamp: new Date(),
      });

      // Limit requests
      if (sessionData.networkRequests.length > 500) {
        sessionData.networkRequests.splice(0, 100);
      }
    });

    // Network responses
    page.on('response', (response: any) => {
      sessionData.networkResponses.push({
        requestId: response.request().url() + Date.now(),
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        headers: response.headers(),
        contentType: response.headers()['content-type'],
        bodySize: 0, // Can't get this synchronously
        responseTime: 0,
        timestamp: new Date(),
      });

      // Limit responses
      if (sessionData.networkResponses.length > 500) {
        sessionData.networkResponses.splice(0, 100);
      }
    });

    // Page errors
    page.on('pageerror', (error: Error) => {
      sessionData.consoleMessages.push({
        type: 'error',
        text: error.message,
        timestamp: new Date(),
      });
    });
  }

  private startAction(
    sessionData: SessionData,
    type: BrowserAction['type'],
    selector?: string,
    value?: string
  ): BrowserAction {
    const action: BrowserAction = {
      id: `action_${uuidv4()}`,
      type,
      selector,
      value,
      timestamp: new Date(),
      success: false,
    };

    sessionData.actions.push(action);
    this.stats.totalActions++;

    return action;
  }

  private endAction(action: BrowserAction, success: boolean, error?: string): void {
    action.success = success;
    action.error = error;
    action.duration = Date.now() - action.timestamp.getTime();

    if (!success) {
      this.stats.failedActions++;
    }
  }

  /**
   * Validate proxy server URL to prevent SSRF attacks (H-10)
   * Blocks: localhost, private IPs, link-local, loopback
   */
  private isValidProxyServer(proxyUrl: string): boolean {
    try {
      // Parse proxy URL
      const url = new URL(proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`);
      const hostname = url.hostname.toLowerCase();

      // Block localhost variants
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
        return false;
      }

      // Block private IPv4 ranges
      const privateRanges = [
        /^10\./,                   // 10.0.0.0/8
        /^192\.168\./,             // 192.168.0.0/16
        /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
        /^169\.254\./,             // 169.254.0.0/16 (link-local)
      ];

      if (privateRanges.some(pattern => pattern.test(hostname))) {
        return false;
      }

      // Block private IPv6 ranges
      if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
        return false;
      }

      return true;
    } catch {
      // Invalid URL format
      return false;
    }
  }

  /**
   * Cleanup all sessions
   */
  async cleanup(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.closeSession(sessionId);
    }
    console.log('[Browser] All sessions cleaned up');
  }
}

// Singleton
let browserController: BrowserController | null = null;

export function getBrowserController(): BrowserController {
  if (!browserController) {
    browserController = new BrowserController();
  }
  return browserController;
}
