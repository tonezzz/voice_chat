import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const DEFAULT_SAMPLE_RATE = 22050

export type TtsEngineStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface TtsProcessorConfig {
  token_to_id?: Record<string, number>
  phoneme_to_id?: Record<string, number>
  bos_token?: string
  eos_token?: string
  pad_token?: string
}

export interface UseTtsEngineOptions {
  /** Load models automatically when the hook mounts. */
  autoLoad?: boolean
  /** URL for the FastSpeech2 TFLite artifact. */
  fastspeechModelUrl?: string
  /** URL for the HiFi-GAN TFLite artifact. */
  hifiganModelUrl?: string
  /** URL for the processor/tokenizer JSON emitted by TensorFlowTTS. */
  processorConfigUrl?: string
  /** Base path for tfjs-tflite WASM binaries (passed to setWasmPaths). */
  wasmBasePath?: string
  /** Optional custom loader for tfjs-tflite so we can inject a mocked module in tests. */
  loadTfliteModule?: () => Promise<TfliteModule>
  /**
   * Minimal text normalizer that runs before token lookups. Override if you have
   * language-specific rules.
   */
  normalizeText?: (text: string) => string
}

export interface SynthesisResult {
  audio: Float32Array
  sampleRate: number
  metadata: {
    text: string
    durationMs?: number
  }
}

export interface UseTtsEngineReturn {
  supported: boolean
  status: TtsEngineStatus
  ready: boolean
  loading: boolean
  error: string | null
  config: Required<UseTtsEngineOptions>
  load: () => Promise<void>
  unload: () => void
  cancel: () => void
  synthesize: (text: string) => Promise<SynthesisResult>
}

interface TfliteModel {
  predict(inputs: unknown): unknown
  dispose?: () => void
}

interface TfliteModule {
  setWasmPaths?: (paths: string | Record<string, string>) => Promise<void> | void
  loadTFLiteModel: (url: string) => Promise<TfliteModel>
}

interface LoadedEngine {
  fastspeech?: TfliteModel
  hifigan?: TfliteModel
  processor?: TtsProcessorConfig
  module?: TfliteModule
}

const DEFAULT_OPTIONS: Required<UseTtsEngineOptions> = {
  autoLoad: false,
  fastspeechModelUrl: '/models/tts/fastspeech2.tflite',
  hifiganModelUrl: '/models/tts/hifigan.tflite',
  processorConfigUrl: '/models/tts/processor.json',
  wasmBasePath: '/tfjs-tflite/',
  loadTfliteModule: async () => {
    throw new Error('No tfjs-tflite loader provided. Pass loadTfliteModule to useTtsEngine.')
  },
  normalizeText: (text: string) => text.trim()
}

const hasWasmSupport = (): boolean => {
  if (typeof window === 'undefined') return false
  return typeof WebAssembly !== 'undefined'
}

const createAbortError = () => new Error('tts_request_aborted')

const readProcessorConfig = async (url: string): Promise<TtsProcessorConfig> => {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch processor config: ${res.status}`)
  }
  return res.json()
}

const tokenize = (text: string, processor?: TtsProcessorConfig): number[] => {
  if (!text.trim()) return []
  if (!processor?.token_to_id) {
    // Fallback: basic whitespace tokenization with a dummy vocab.
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((token, idx) => (idx % 2 === 0 ? token.length : token.length + 1))
  }

  const bos = processor.bos_token ? processor.token_to_id?.[processor.bos_token] : undefined
  const eos = processor.eos_token ? processor.token_to_id?.[processor.eos_token] : undefined
  const pad = processor.pad_token ? processor.token_to_id?.[processor.pad_token] : undefined
  const unk = processor.token_to_id['<unk>'] ?? pad ?? 0

  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => processor.token_to_id?.[token] ?? unk)

  const result: number[] = []
  if (typeof bos === 'number') result.push(bos)
  result.push(...tokens)
  if (typeof eos === 'number') result.push(eos)

  return result
}

export const useTtsEngine = (options: UseTtsEngineOptions = {}): UseTtsEngineReturn => {
  const config = useMemo<Required<UseTtsEngineOptions>>(() => ({ ...DEFAULT_OPTIONS, ...options }), [options])

  const [status, setStatus] = useState<TtsEngineStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const supported = useMemo(hasWasmSupport, [])

  const engineRef = useRef<LoadedEngine>({})
  const abortControllerRef = useRef<AbortController | null>(null)

  const cleanupModels = useCallback(() => {
    if (engineRef.current.fastspeech?.dispose) {
      engineRef.current.fastspeech.dispose()
    }
    if (engineRef.current.hifigan?.dispose) {
      engineRef.current.hifigan.dispose()
    }
    engineRef.current = {}
  }, [])

  const unload = useCallback(() => {
    cleanupModels()
    setStatus('idle')
    setError(null)
  }, [cleanupModels])

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [])

  const load = useCallback(async () => {
    if (!supported) {
      setError('This browser does not support WebAssembly-based TTS yet.')
      setStatus('error')
      return
    }

    setStatus('loading')
    setError(null)

    try {
      const controller = new AbortController()
      abortControllerRef.current = controller

      const [module, processor] = await Promise.all([
        config.loadTfliteModule(),
        readProcessorConfig(config.processorConfigUrl)
      ])
      if (controller.signal.aborted) throw createAbortError()

      if (module.setWasmPaths) {
        await module.setWasmPaths(config.wasmBasePath)
      }

      const [fastspeech, hifigan] = await Promise.all([
        module.loadTFLiteModel(config.fastspeechModelUrl),
        module.loadTFLiteModel(config.hifiganModelUrl)
      ])
      if (controller.signal.aborted) throw createAbortError()

      engineRef.current = { fastspeech, hifigan, processor, module }
      setStatus('ready')
    } catch (err: any) {
      if (err?.message === 'tts_request_aborted') {
        return
      }
      console.error('TTS engine load failed', err)
      cleanupModels()
      setStatus('error')
      setError(err?.message || 'Failed to load TTS engine')
    } finally {
      abortControllerRef.current = null
    }
  }, [cleanupModels, config, supported])

  useEffect(() => {
    if (config.autoLoad) {
      void load()
    }

    return () => {
      cancel()
      cleanupModels()
    }
  }, [cancel, cleanupModels, config.autoLoad, load])

  const synthesize = useCallback(
    async (text: string): Promise<SynthesisResult> => {
      const normalized = config.normalizeText(text)
      if (!normalized) {
        throw new Error('Cannot synthesize empty text.')
      }

      if (!engineRef.current.fastspeech || !engineRef.current.hifigan || !engineRef.current.processor) {
        throw new Error('TTS engine not ready yet. Call load() first.')
      }

      // Placeholder implementation: actual FastSpeech2 -> HiFi-GAN inference will be wired later.
      // We still return a deterministic (silent) buffer so the rest of the UI can be tested.
      const durationMs = Math.max(500, normalized.length * 40)
      const sampleCount = Math.round((durationMs / 1000) * DEFAULT_SAMPLE_RATE)
      const silentAudio = new Float32Array(sampleCount)
      const tokens = tokenize(normalized, engineRef.current.processor)

      console.warn('useTtsEngine.synthesize invoked without real inference pipeline. Returning silence.', {
        tokens,
        durationMs
      })

      return {
        audio: silentAudio,
        sampleRate: DEFAULT_SAMPLE_RATE,
        metadata: { text: normalized, durationMs }
      }
    },
    [config]
  )

  return {
    supported,
    status,
    ready: status === 'ready',
    loading: status === 'loading',
    error,
    config,
    load,
    unload,
    cancel,
    synthesize
  }
}
