export type LocalComputeTaskKind = 'noop' | 'tokenize-basic' | 'fft-basic'

export interface LocalComputeTaskRequest<TPayload = Record<string, unknown>> {
  kind: LocalComputeTaskKind
  payload?: TPayload
  maxSliceMs?: number
}

export interface LocalComputeTaskResult<TData = unknown> {
  kind: LocalComputeTaskKind
  data: TData
  durationMs: number
}

export interface FftBasicResult {
  bins: { bin: number; frequency: number; value: number }[]
  peakFrequency: number
  peakMagnitude: number
  averageMagnitude: number
  sampleRate: number
  sampleCount: number
  spectralCentroidHz: number
  rms: number
  melBands: {
    band: number
    startFrequency: number
    endFrequency: number
    centerFrequency: number
    value: number
  }[]
  nyquistFrequency: number
}

export type LocalComputeHostMessage =
  | { type: 'init'; options?: { warmup?: boolean } }
  | { type: 'task'; id: string; task: LocalComputeTaskRequest }

export type LocalComputeWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: string; result: LocalComputeTaskResult }
  | { type: 'error'; id?: string; error: string }
