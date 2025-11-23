/// <reference lib="webworker" />

import type {
  LocalComputeHostMessage,
  LocalComputeTaskRequest,
  LocalComputeTaskResult,
  LocalComputeWorkerMessage
} from '../types/localCompute'

const ctx = self as DedicatedWorkerGlobalScope
const textEncoder = new TextEncoder()

const MAX_FFT_SAMPLES = 2048
const MEL_BAND_COUNT = 8

const log10 = (value: number) => Math.log(value) / Math.LN10
const hzToMel = (hz: number) => 2595 * log10(1 + hz / 700)
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1)

const clampSamples = (input: unknown, maxLength: number) => {
  if (!Array.isArray(input)) return []
  const out: number[] = []
  for (let i = 0; i < input.length && out.length < maxLength; i += 1) {
    const value = Number(input[i])
    if (Number.isFinite(value)) {
      out.push(value)
    }
  }
  return out
}

const computeSpectralCentroid = (magnitudes: number[], sampleRate: number, sampleCount: number) => {
  if (!magnitudes.length) return 0
  let weightedSum = 0
  let magnitudeSum = 0
  for (let i = 0; i < magnitudes.length; i += 1) {
    const mag = magnitudes[i]
    magnitudeSum += mag
    weightedSum += ((i * sampleRate) / sampleCount) * mag
  }
  if (!magnitudeSum) return 0
  return weightedSum / magnitudeSum
}

const computeMelBands = (
  magnitudes: number[],
  sampleRate: number,
  sampleCount: number,
  bandCount: number
) => {
  if (!magnitudes.length || bandCount <= 0) return []
  const nyquist = sampleRate / 2
  if (!Number.isFinite(nyquist) || nyquist <= 0) return []
  const minMel = hzToMel(0)
  const maxMel = hzToMel(nyquist)
  const melStep = (maxMel - minMel) / bandCount
  const bands: {
    band: number
    startFrequency: number
    endFrequency: number
    centerFrequency: number
    value: number
  }[] = []

  for (let band = 0; band < bandCount; band += 1) {
    const startMel = minMel + band * melStep
    const endMel = startMel + melStep
    const centerMel = (startMel + endMel) / 2
    const startHz = melToHz(startMel)
    const endHz = melToHz(endMel)
    const centerHz = melToHz(centerMel)
    const startBin = Math.max(0, Math.floor((startHz * sampleCount) / sampleRate))
    const endBin = Math.min(
      magnitudes.length - 1,
      Math.max(startBin, Math.ceil((endHz * sampleCount) / sampleRate))
    )
    let weightedSum = 0
    let totalWeight = 0
    for (let bin = startBin; bin <= endBin; bin += 1) {
      const binFreq = (bin * sampleRate) / sampleCount
      let weight = 0
      if (binFreq < startHz) {
        weight = 0
      } else if (binFreq < centerHz) {
        weight = (binFreq - startHz) / Math.max(centerHz - startHz, 1e-6)
      } else if (binFreq <= endHz) {
        weight = (endHz - binFreq) / Math.max(endHz - centerHz, 1e-6)
      } else {
        weight = 0
      }
      if (weight > 0) {
        weightedSum += magnitudes[bin] * weight
        totalWeight += weight
      }
    }
    const value = totalWeight ? weightedSum / totalWeight : 0
    bands.push({
      band,
      startFrequency: startHz,
      endFrequency: endHz,
      centerFrequency: centerHz,
      value
    })
  }

  return bands
}

const runFftBasic = (payload: { samples?: number[]; sampleRate?: number }) => {
  const samples = clampSamples(payload?.samples, MAX_FFT_SAMPLES)
  const sampleRate = typeof payload?.sampleRate === 'number' && payload.sampleRate > 0 ? payload.sampleRate : 44100

  if (!samples.length) {
    const nyquist = sampleRate / 2
    return {
      bins: [],
      peakFrequency: 0,
      peakMagnitude: 0,
      averageMagnitude: 0,
      sampleRate,
      sampleCount: 0,
      spectralCentroidHz: 0,
      rms: 0,
      melBands: [],
      nyquistFrequency: nyquist
    }
  }

  const sampleCount = samples.length
  const n = sampleCount
  const half = Math.floor(n / 2)
  const magnitudes = new Array(half).fill(0)
  for (let k = 0; k < half; k += 1) {
    let real = 0
    let imag = 0
    const angleFactor = (-2 * Math.PI * k) / n
    for (let t = 0; t < n; t += 1) {
      const angle = angleFactor * t
      real += samples[t] * Math.cos(angle)
      imag += samples[t] * Math.sin(angle)
    }
    magnitudes[k] = Math.sqrt(real * real + imag * imag)
  }

  let peakMag = -Infinity
  let peakIndex = 0
  for (let i = 0; i < magnitudes.length; i += 1) {
    if (magnitudes[i] > peakMag) {
      peakMag = magnitudes[i]
      peakIndex = i
    }
  }

  const peakFrequency = magnitudes.length ? (peakIndex * sampleRate) / n : 0
  const avgMagnitude = magnitudes.reduce((sum, val) => sum + val, 0) / Math.max(magnitudes.length, 1)
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / n)
  const spectralCentroidHz = computeSpectralCentroid(magnitudes, sampleRate, n)
  const melBands = computeMelBands(magnitudes, sampleRate, n, MEL_BAND_COUNT)
  const nyquistFrequency = sampleRate / 2

  return {
    bins: magnitudes.slice(0, 32).map((value, idx) => ({
      bin: idx,
      frequency: (idx * sampleRate) / n,
      value
    })),
    peakFrequency,
    peakMagnitude: Number.isFinite(peakMag) ? peakMag : 0,
    averageMagnitude: avgMagnitude,
    sampleRate,
    sampleCount,
    spectralCentroidHz,
    rms,
    melBands,
    nyquistFrequency
  }
}

const runTask = async (task: LocalComputeTaskRequest): Promise<LocalComputeTaskResult> => {
  const startedAt = performance.now()

  if (task.kind === 'noop') {
    return {
      kind: task.kind,
      data: { timestamp: Date.now() },
      durationMs: performance.now() - startedAt
    }
  }

  if (task.kind === 'tokenize-basic') {
    const payload = (task.payload ?? {}) as { text?: string }
    const text = typeof payload.text === 'string' ? payload.text : ''
    const normalized = text.trim()

    const tokens = normalized ? normalized.split(/\s+/u) : []
    const totalChars = normalized.length
    const asciiBytes = textEncoder.encode(normalized).length

    return {
      kind: task.kind,
      data: {
        tokenCount: tokens.length,
        charCount: totalChars,
        byteLength: asciiBytes,
        preview: tokens.slice(0, 8)
      },
      durationMs: performance.now() - startedAt
    }
  }

  if (task.kind === 'fft-basic') {
    const payload = (task.payload ?? {}) as { samples?: number[]; sampleRate?: number }
    const fftResult = runFftBasic(payload)
    return {
      kind: task.kind,
      data: fftResult,
      durationMs: performance.now() - startedAt
    }
  }

  throw new Error(`Unsupported task kind: ${task.kind}`)
}

const handleMessage = async (event: MessageEvent<LocalComputeHostMessage>) => {
  const message = event.data
  if (!message) {
    return
  }

  if (message.type === 'init') {
    ctx.postMessage({ type: 'ready' } satisfies LocalComputeWorkerMessage)
    if (message.options?.warmup) {
      try {
        await runTask({ kind: 'noop' })
      } catch (err) {
        ctx.postMessage({
          type: 'error',
          error: err instanceof Error ? err.message : 'warmup_failed'
        } satisfies LocalComputeWorkerMessage)
      }
    }
    return
  }

  if (message.type === 'task') {
    const { id, task } = message
    try {
      const result = await runTask(task)
      ctx.postMessage({ type: 'result', id, result } satisfies LocalComputeWorkerMessage)
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        id,
        error: err instanceof Error ? err.message : 'task_failed'
      } satisfies LocalComputeWorkerMessage)
    }
  }
}

ctx.addEventListener('message', handleMessage)

export {}
