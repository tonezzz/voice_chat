import { test, expect, type Page, type Route } from '@playwright/test'

const API_BASE = (process.env.VITE_API_BASE_URL || 'http://127.0.0.1:3002').replace(/\/$/, '')
const HEALTH_URL = `${API_BASE}/health`
const MCP_PROVIDERS_URL = `${API_BASE}/mcp/providers`
const VOICE_CHAT_URL = `${API_BASE}/voice-chat`

const gotoApp = async (page: Page) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

const mockHealth = async (page: Page, services: { name: string; status: string }[]) => {
  await page.route('**/health*', async (route: Route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ status: 'ok', services })
    })
  })
}

const mockMcpProviders = async (page: Page, providers: Array<{ name: string }>) => {
  await page.route('**/mcp/providers*', async (route: Route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify(providers)
    })
  })
}

test.describe('LLM provider selector', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('about:blank')
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    }).catch(() => {})
  })

  test('persists selection in localStorage', async ({ page }) => {
    await mockHealth(page, [
      { name: 'ollama', status: 'ok' },
      { name: 'ollamaGpu', status: 'ok' },
      { name: 'anthropic', status: 'ok' },
      { name: 'openai', status: 'ok' }
    ])
    await mockMcpProviders(page, [])

    await gotoApp(page)
    const select = page.getByTestId('llm-provider-select')
    await select.selectOption('openai')
    await expect(select).toHaveValue('openai')

    await page.reload()
    await page.waitForLoadState('networkidle')
    const selectAfterReload = page.getByTestId('llm-provider-select')
    await expect(selectAfterReload).toHaveValue('openai')
  })

  test('disables unavailable providers and falls back to healthy option', async ({ page }) => {
    await mockHealth(page, [
      { name: 'ollama', status: 'error' },
      { name: 'ollamaGpu', status: 'error' },
      { name: 'anthropic', status: 'ok' },
      { name: 'openai', status: 'error' }
    ])
    await mockMcpProviders(page, [])

    await gotoApp(page)
    const select = page.getByTestId('llm-provider-select')
    await expect(async () => {
      const value = await select.inputValue()
      expect(value).toBe('anthropic')
    }).toPass()
    const ollamaOption = select.locator('option[value="ollama"]')
    await expect(ollamaOption).toHaveAttribute('disabled', '')
    const openAiOption = select.locator('option[value="openai"]')
    await expect(openAiOption).toHaveAttribute('disabled', '')
  })

  test('sends provider in chat request body', async ({ page }) => {
    let interceptedPayload: any = null
    await mockHealth(page, [])
    await mockMcpProviders(page, [])

    await page.route('**/voice-chat-stream', async (route) => {
      interceptedPayload = JSON.parse(route.request().postData() || '{}')
      const body =
        'data: {"type":"delta","delta":"hi","full":"hi"}\n\n' +
        'data: {"type":"complete","reply":"hi","session":{}}\n\n'
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body
      })
    })
    await page.route(`${VOICE_CHAT_URL}`, async (route) => {
      interceptedPayload = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({ status: 200, body: JSON.stringify({ reply: 'hi', session: {} }) })
    })

    await gotoApp(page)
    const select = page.getByTestId('llm-provider-select')
    await select.selectOption('anthropic')
    const input = page.getByPlaceholder('Type a message or use voice controls…')
    await input.fill('hello')
    await input.press('Enter')

    await expect.poll(() => interceptedPayload?.provider).toBe('anthropic')
  })

  test('shows GitHub Models option when MCP provider is available', async ({ page }) => {
    await mockHealth(page, [
      { name: 'ollama', status: 'ok' },
      { name: 'anthropic', status: 'ok' },
      { name: 'openai', status: 'ok' }
    ])
    await mockMcpProviders(page, [{ name: 'githubModel' }])

    await gotoApp(page)

    const select = page.getByTestId('llm-provider-select')
    const githubOption = select.locator('option[value="github"]')
    await expect(githubOption).toHaveCount(1)
  })
})
