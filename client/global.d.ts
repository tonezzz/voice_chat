import type { YoloTestHooks } from './src/types/yolo'

declare global {
  interface Window {
    __YOLO_TEST_HOOKS__?: YoloTestHooks
  }
}

export {}
