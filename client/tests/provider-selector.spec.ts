import { test, expect, type Page, type Route } from '@playwright/test'

const mockHealth = async (page: Page, services: { name: string; status: string }[]) => {
  await page.route('**/health', async (route: Route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ status: 'ok', services })
    })
  })
}

test.describe('LLM provider selector', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
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

    await page.goto('/')
    await page.waitForResponse('**/health')
    const select = page.getByLabel('Provider')
    await select.selectOption('openai')
    await expect(select).toHaveValue('openai')

    await page.reload()
    await page.waitForResponse('**/health')
    const selectAfterReload = page.getByLabel('Provider')
    await expect(selectAfterReload).toHaveValue('openai')
  })

  test('disables unavailable providers and falls back to healthy option', async ({ page }) => {
    await mockHealth(page, [
      { name: 'ollama', status: 'error' },
      { name: 'ollamaGpu', status: 'error' },
      { name: 'anthropic', status: 'ok' },
      { name: 'openai', status: 'error' }
    ])

    await page.goto('/')
    await page.waitForResponse('**/health')
    const select = page.getByLabel('Provider')
    await expect(select).toHaveValue('anthropic')
    const ollamaOption = select.locator('option[value="ollama"]')
    await expect(ollamaOption).toHaveAttribute('disabled', '')
    const openAiOption = select.locator('option[value="openai"]')
    await expect(openAiOption).toHaveAttribute('disabled', '')
  })

  test('sends provider in chat request body', async ({ page }) => {
    let interceptedPayload: any = null
    await mockHealth(page, [])

    await page.route('**/voice-chat', async (route) => {
      interceptedPayload = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({ status: 200, body: JSON.stringify({ reply: 'hi', session: {} }) })
    })

    await page.goto('/')
    await page.waitForResponse('**/health')
    const select = page.getByLabel('Provider')
    await select.selectOption('anthropic')
    const input = page.getByPlaceholder('Type a message or use voice controls…')
    await input.fill('hello')
    await input.press('Enter')

    await expect.poll(() => interceptedPayload?.provider).toBe('anthropic')
  })
})
