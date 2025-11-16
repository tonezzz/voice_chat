import { test, expect } from '@playwright/test'

const SAMPLE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAGgwJ/lpAoNwAAAABJRU5ErkJggg=='

const primaryPayload = {
  image: SAMPLE_IMAGE,
  results: [
    {
      class_name: 'person',
      confidence: 0.87,
      bbox: [10, 12, 120, 220]
    },
    {
      class_name: 'cell phone',
      confidence: 0.64,
      bbox: [140, 40, 200, 120]
    }
  ]
}

const linkedPayload = {
  image: SAMPLE_IMAGE,
  results: [
    {
      class_name: 'face',
      confidence: 0.92,
      bbox: [40, 30, 90, 90]
    }
  ]
}

test.describe('YOLO detection panels', () => {
  test('primary and linked panels render and highlight detections', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'YOLO detection' }).click()

    await page.evaluate(({ primaryPayload, linkedPayload }) => {
      window.__YOLO_TEST_HOOKS__?.setPrimaryDetections(primaryPayload)
      window.__YOLO_TEST_HOOKS__?.setLinkedDetections(linkedPayload)
    }, { primaryPayload, linkedPayload })

    await expect(page.getByTestId('primary-detection-image')).toBeVisible()
    await expect(page.getByTestId('linked-detection-image')).toBeVisible()

    await expect(page.getByTestId('primary-detection-count')).toHaveText('Detections (2)')
    await expect(page.getByTestId('linked-detection-count')).toHaveText('Detections (1 / 1)')

    const linkedItem = page.getByTestId('linked-detection-item').first()
    await linkedItem.hover()
    await expect(page.locator('.vision-panel-alt .vision-box.highlighted')).toBeVisible()
  })
})
