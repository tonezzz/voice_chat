export interface DetectionResult {
  class_name?: string
  confidence?: number
  bbox?: number[]
  class_id?: number
}

export interface DetectionTestPayload {
  image: string
  results: DetectionResult[]
}

export interface YoloTestHooks {
  setPrimaryDetections(payload: DetectionTestPayload): void
  setLinkedDetections(payload: DetectionTestPayload): void
}
