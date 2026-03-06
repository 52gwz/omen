import { chromium, type Browser, type Page, type BrowserContext } from 'playwright'

class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null

  private async ensurePage(): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: false })
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
      })
      this.page = await this.context.newPage()
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context!.newPage()
    }
    return this.page
  }

  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const title = await page.title()
    return `已导航到: ${page.url()}\n页面标题: ${title}`
  }

  async screenshot(fullPage = false): Promise<{ text: string; base64: string }> {
    const page = await this.ensurePage()
    const buffer = await page.screenshot({ fullPage, type: 'png' })
    const title = await page.title()
    const url = page.url()
    const viewport = page.viewportSize() || { width: 1280, height: 720 }
    return {
      text: `已截取页面截图\nURL: ${url}\n标题: ${title}\n视口: ${viewport.width}x${viewport.height}\n点击坐标范围: x(0-${viewport.width}), y(0-${viewport.height})`,
      base64: buffer.toString('base64'),
    }
  }

  async click(options: { x?: number; y?: number; selector?: string }): Promise<string> {
    const page = await this.ensurePage()
    if (typeof options.x === 'number' && typeof options.y === 'number') {
      await page.mouse.click(options.x, options.y)
      await page.waitForTimeout(500)
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      const title = await page.title()
      return `已点击坐标 (${options.x}, ${options.y})\n当前页面: ${page.url()}\n标题: ${title}`
    }
    if (options.selector) {
      await page.click(options.selector, { timeout: 10_000 })
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      const title = await page.title()
      return `已点击元素: ${options.selector}\n当前页面: ${page.url()}\n标题: ${title}`
    }
    return '[error] 需要提供坐标 (x, y) 或 selector'
  }

  async type(text: string, options: { x?: number; y?: number; selector?: string }): Promise<string> {
    const page = await this.ensurePage()
    if (typeof options.x === 'number' && typeof options.y === 'number') {
      await page.mouse.click(options.x, options.y)
      await page.waitForTimeout(200)
      await page.keyboard.type(text)
      return `已在坐标 (${options.x}, ${options.y}) 输入文本`
    }
    if (options.selector) {
      await page.fill(options.selector, text, { timeout: 10_000 })
      return `已在 ${options.selector} 中输入文本`
    }
    return '[error] 需要提供坐标 (x, y) 或 selector'
  }

  async getText(selector?: string): Promise<string> {
    const page = await this.ensurePage()
    if (selector) {
      const el = page.locator(selector).first()
      const text = await el.textContent({ timeout: 10_000 })
      return text || '(无文本内容)'
    }
    const title = await page.title()
    const url = page.url()
    const bodyText = await page.evaluate(() => {
      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT
          const text = node.textContent?.trim()
          return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
        },
      })
      const parts: string[] = []
      let total = 0
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent!.trim()
        parts.push(text)
        total += text.length
        if (total > 50_000) break
      }
      return parts.join(' ')
    })
    return `URL: ${url}\n标题: ${title}\n\n${bodyText}`
  }

  async select(selector: string, values: string[]): Promise<string> {
    const page = await this.ensurePage()
    const selected = await page.selectOption(selector, values, { timeout: 10_000 })
    return `已选择 ${selected.length} 个选项: ${selected.join(', ')}`
  }

  async scroll(direction: 'up' | 'down', amount = 500): Promise<string> {
    const page = await this.ensurePage()
    const delta = direction === 'down' ? amount : -amount
    await page.mouse.wheel(0, delta)
    await page.waitForTimeout(300)
    return `已向${direction === 'down' ? '下' : '上'}滚动 ${amount}px`
  }

  async waitForSelector(selector: string, timeout = 10_000): Promise<string> {
    const page = await this.ensurePage()
    await page.waitForSelector(selector, { timeout })
    return `元素已出现: ${selector}`
  }

  async evaluate(script: string): Promise<string> {
    const page = await this.ensurePage()
    const result = await page.evaluate(script)
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  }

  async close(): Promise<string> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      this.context = null
      this.page = null
    }
    return '浏览器已关闭'
  }

  isActive(): boolean {
    return this.browser !== null && this.browser.isConnected()
  }
}

export const browserManager = new BrowserManager()
