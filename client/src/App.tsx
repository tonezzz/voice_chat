import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppBar,
  Box,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Typography,
  type ChipProps
} from '@mui/material'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import SensorsIcon from '@mui/icons-material/Sensors'
import './style.css'
import type { DetectionResult, DetectionTestPayload } from './types/yolo'

interface ServiceStatus {
  name: string
  label: string
  status: string
  detail?: unknown
}

interface MeetingSessionSummary {
  session_id: string
  title?: string | null
  participants?: string[]
  tags?: string[]
  archived?: boolean
  entry_count?: number
  updated_at?: string
  created_at?: string
}

interface MeetingTranscriptEntry {
  text: string
  speaker?: string | null
  source?: string
  created_at?: string
  metadata?: Record<string, unknown>
}

interface MeetingSessionDetail extends MeetingSessionSummary {
  entries?: MeetingTranscriptEntry[]
  summary?: string | null
  language_hint?: string | null
}

interface BankVerificationInfo {
  referenceId?: string | null
  provider?: string | null
  status?: string | null
}

interface ApiBankField {
  id?: string
  type?: string
  label?: string
  value?: string | null
  confidence?: number | null
  bbox?: number[] | null
}

interface BankSlipVerificationResponse {
  fields?: ApiBankField[]
  image?: string | null
  verification?: {
    reference_id?: string
    provider?: string
    status?: string
  }
}

const BANK_OCR_LANG_OPTIONS = [
  { value: 'eng', label: 'English' },
  { value: 'tha', label: 'ไทย (Thai)' },
  { value: 'spa', label: 'Español' }
]

const PANEL_TABS = [
  { value: 'chat', label: 'Chat' },
  { value: 'openvoice', label: 'OpenVoice' },
  { value: 'image-mcp', label: 'Image lab' },
  { value: 'yolo-detection', label: 'YOLO detection' },
  { value: 'carwatch', label: 'CarWatch' },
  { value: 'bank-slip', label: 'Bank slip' },
  { value: 'meeting', label: 'Meeting' }
] as const

const IMAGE_STANDALONE_PATHS = new Set(['/imagen', '/imagen/'])

type PanelTabValue = (typeof PANEL_TABS)[number]['value']

const downloadBase64File = (dataUrl: string, filename: string) => {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

const resolveDefaultApiBase = () => {
  if (typeof window === 'undefined') {
    return 'http://localhost:3002'
  }

  const { protocol, hostname, port } = window.location
  const localPreviewPorts = new Set(['5173', '4173', '4174'])
  const isViteDevServer = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV

  if (isViteDevServer || (port && localPreviewPorts.has(port))) {
    return `${protocol}//${hostname}:3001`
  }
  return window.location.origin
}

const parseHostname = (url: string) => {
  try {
    return new URL(url).hostname
  } catch (error) {
    return null
  }
}

const isLocalHostname = (value?: string | null) => {
  if (!value) return false
  return LOCAL_HOSTNAMES.has(value.toLowerCase()) || value.toLowerCase().endsWith('.local')
}

const resolveApiBase = () => {
  const envBase = import.meta.env.VITE_API_BASE_URL?.trim()
  if (!envBase) {
    return resolveDefaultApiBase()
  }

  if (typeof window === 'undefined') {
    return envBase
  }

  const envHost = parseHostname(envBase)
  const currentHost = window.location.hostname
  const currentIsLocal = isLocalHostname(currentHost)
  const envIsLocal = isLocalHostname(envHost)

  if (!envIsLocal) {
    return envBase
  }

  if (currentIsLocal) {
    return envBase
  }

  // App is served from a public host but env points to localhost; fall back to origin so ngrok / deployed UIs work.
  return resolveDefaultApiBase()
}

const API_BASE = resolveApiBase()
const API_URL = `${API_BASE}/voice-chat`
const API_STREAM_URL = `${API_BASE}/voice-chat-stream`
const API_AUDIO_URL = `${API_BASE}/voice-chat-audio`
const MEETING_TRANSCRIPT_URL = `${API_BASE}/meeting/append-transcript`
const MEETING_SESSIONS_URL = `${API_BASE}/meeting/sessions`
const meetingSessionDetailUrl = (sessionId: string) => `${MEETING_SESSIONS_URL}/${encodeURIComponent(sessionId)}`
const meetingSessionSummarizeUrl = (sessionId: string) => `${meetingSessionDetailUrl(sessionId)}/summarize`
const HEALTH_URL = `${API_BASE}/health`
const DETECT_URL = `${API_BASE}/detect-image`
const VERIFY_SLIP_URL = `${API_BASE}/verify-slip`
const GENERATE_IMAGE_URL = `${API_BASE}/generate-image`
const GENERATE_IMAGE_STREAM_URL = `${API_BASE}/generate-image-stream`
const OCR_URL = `${API_BASE}/ocr-image`
const VOICES_URL = `${API_BASE}/voices`
const PREVIEW_VOICE_URL = `${API_BASE}/preview-voice`
const CARWATCH_SNAPSHOT_URL = `${API_BASE}/carwatch/snapshot`

const MCP0_PROVIDERS_API = `${API_BASE}/mcp0/providers`
const MCP0_TOOLS_API = `${API_BASE}/mcp0/tools`
const MCP_PROVIDERS_URL = `${API_BASE}/mcp/providers`
const GITHUB_MODEL_HEALTH_URL = `${API_BASE}/github-model/health`

const SpeechRecognitionImpl: typeof window.SpeechRecognition | undefined =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

type AttachmentType = 'file' | 'image'

interface ChatAttachment {
  id?: string
  type: AttachmentType
  name: string
  url: string
  label?: string
  order?: number
  prompt?: string
  base64?: string
  mimetype?: string
  size?: number
}

interface McpToolRun {
  provider?: string
  tool?: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string | null
  raw?: string
}

interface McpProviderInfo {
  name: string
  base_url?: string
  health_path?: string
  capabilities_path?: string | null
  default_tools?: string[]
  health?: Record<string, unknown> | null
  capabilities?: Record<string, unknown> | null
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  time: string
  model?: string
  sttModel?: string
  sttLanguage?: string | null
  attachmentType?: AttachmentType
  attachmentName?: string
  attachmentUrl?: string
  accelerator?: 'cpu' | 'gpu'
  attachments?: ChatAttachment[]
  voiceId?: string | null
  diagnostics?: DiagnosticsInfo | null
  mcpToolRuns?: McpToolRun[]
}

type InlineSpeakerStatus = 'idle' | 'playing' | 'paused'

interface InlineSpeakerState {
  messageId: string | null
  status: InlineSpeakerStatus
}

type InlinePlaybackMode = 'speech' | 'audio'

interface SpeakLifecycle {
  onStart?: () => void
  onEnd?: () => void
  onError?: () => void
}

interface DiagnosticsInfo {
  provider?: string | null
  model?: string | null
  accelerator?: 'cpu' | 'gpu' | null
  server?: string | null
  mcp0?: string | null
  timestamp?: string | null
}

interface ActiveReplyContext {
  provider: string | null
  accelerator: 'cpu' | 'gpu'
  streaming: boolean
  cancellable: boolean
}

interface StreamDeltaEvent {
  type: 'delta'
  delta: string
  full: string
}

interface StreamCompleteEvent {
  type: 'complete'
  reply: string
  audioUrl?: string | null
  session?: SessionResponse
  provider?: string | null
  voiceId?: string | null
  diagnostics?: DiagnosticsInfo | null
  mcpTools?: McpToolRun[]
}

interface StreamErrorEvent {
  type: 'error'
  error: string
}

type StreamEventPayload = StreamDeltaEvent | StreamCompleteEvent | StreamErrorEvent

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  github: 'GitHub Models',
  ollama: 'Ollama'
}

const STREAMING_PROVIDERS = new Set<string>(['ollama', 'anthropic', 'openai', 'github'])

const providerSupportsStreaming = (provider?: string | null) => {
  if (!provider) return false
  return STREAMING_PROVIDERS.has(provider.toLowerCase())
}

const parseSsePayload = (chunk: string): StreamEventPayload | null => {
  if (!chunk) return null
  const dataLines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())

  if (!dataLines.length) {
    return null
  }

  const jsonText = dataLines.join('\n')
  if (!jsonText) return null

  try {
    return JSON.parse(jsonText) as StreamEventPayload
  } catch (err) {
    console.warn('Failed to parse SSE payload', err)
    return null
  }
}

const readSseStream = async (
  stream: ReadableStream<Uint8Array>,
  onPayload: (payload: StreamEventPayload) => void,
  signal?: AbortSignal | null
) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const handleAbort = () => {
    try {
      reader.cancel().catch(() => null)
    } catch {
      // noop
    }
  }

  if (signal) {
    if (signal.aborted) {
      handleAbort()
      return
    }
    signal.addEventListener('abort', handleAbort, { once: true })
  }

  const processBuffer = (isFinal = false) => {
    let delimiterIndex = buffer.indexOf('\n\n')
    while (delimiterIndex >= 0) {
      const chunk = buffer.slice(0, delimiterIndex)
      buffer = buffer.slice(delimiterIndex + 2)
      const payload = parseSsePayload(chunk)
      if (payload) {
        onPayload(payload)
      }
      delimiterIndex = buffer.indexOf('\n\n')
    }

    if (isFinal && buffer.trim()) {
      const payload = parseSsePayload(buffer)
      buffer = ''
      if (payload) {
        onPayload(payload)
      }
    }
  }

  while (true) {
    if (signal?.aborted) {
      break
    }
    const { value, done } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      processBuffer(true)
      break
    }
    buffer += decoder.decode(value, { stream: true })
    processBuffer()
  }
}

const formatProviderLabel = (raw?: string | null) => {
  if (!raw) return null
  const normalized = raw.toLowerCase()
  return PROVIDER_LABELS[normalized] || raw.replace(/^[a-z]/, (match) => match.toUpperCase())
}

const formatServerLabel = (raw?: string | null) => {
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.host || raw
  } catch {
    return raw.replace(/^https?:\/\//i, '')
  }
}

type LlmProvider = 'ollama' | 'anthropic' | 'openai' | 'github'

type ProviderHealthStatus = Record<LlmProvider, 'ok' | 'unknown' | 'error'>

interface McpToolRun {
  provider?: string
  tool?: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string | null
  raw?: string
}

interface McpProviderInfo {
  name: string
  base_url?: string
  health_path?: string
  capabilities_path?: string | null
  default_tools?: string[]
  health?: Record<string, unknown> | null
  capabilities?: Record<string, unknown> | null
}

type QuickMenuAction = 'popup' | 'status' | 'reset'

type StatusTone = 'ok' | 'error' | 'unknown' | 'loading'

interface PlayAudioOptions {
  onStart?: () => void
  onEnded?: () => void
}

const AUTO_SPEECH_REPLIES_ENABLED = false
const SPEECH_LANGUAGE_HELPER = 'Used for mic input & Whisper hints.'
const LLM_PROVIDER_HELPER = 'Switch between available LLM backends.'
const WHISPER_HELPER = 'Controls transcription model and latency.'

interface ChipInfoIconProps {
  label: string
  message?: string | null
}

const ChipInfoIcon = ({ label, message }: ChipInfoIconProps) => {
  if (!message) return null
  return (
    <button type="button" className="chip-help" aria-label={`${label} info`} data-tooltip={message}>
      <span className="chip-help-icon" aria-hidden role="img" aria-label="tip">
        💡
      </span>
    </button>
  )
}

const detectionTargetOptions = [
  { label: 'People', value: 'person' },
  { label: 'Faces', value: 'face' },
  { label: 'Cars', value: 'car' },
  { label: 'Buses', value: 'bus' },
  { label: 'Cats', value: 'cat' },
  { label: 'Dogs', value: 'dog' },
  { label: 'Mobile phones', value: 'cell phone' },
  { label: 'Bottles', value: 'bottle' },
  { label: 'Traffic lights', value: 'traffic light' }
]

const speechLanguageOptions = [
  { value: 'auto', label: 'Auto detect (recommended)', speechRecognition: '' },
  { value: 'en', label: 'English (US)', speechRecognition: 'en-US' },
  { value: 'th', label: 'ไทย (Thai)', speechRecognition: 'th-TH' },
  { value: 'es', label: 'Español (LatAm)', speechRecognition: 'es-419' },
  { value: 'vi', label: 'Tiếng Việt', speechRecognition: 'vi-VN' },
  { value: 'ja', label: '日本語 (Japanese)', speechRecognition: 'ja-JP' }
]

const speechLanguageValueMap = new Map(speechLanguageOptions.map((option) => [option.value, option]))
const speechRecognitionCodeMap = new Map(
  speechLanguageOptions
    .filter((option) => option.speechRecognition)
    .map((option) => [option.speechRecognition!.toLowerCase(), option])
)

const getSpeechRecognitionCode = (value: string) => speechLanguageValueMap.get(value)?.speechRecognition || ''

const normalizeSpeechLanguageValue = (code?: string | null) => {
  if (!code) return null
  if (speechLanguageValueMap.has(code)) {
    return code
  }
  const lowered = code.toLowerCase()
  const match = speechRecognitionCodeMap.get(lowered)
  return match ? match.value : code
}

const getSpeechLanguageLabel = (code?: string | null) => {
  if (!code) return null
  if (code === 'auto') return 'Auto'
  const normalized = normalizeSpeechLanguageValue(code)
  if (normalized && speechLanguageValueMap.has(normalized)) {
    return speechLanguageValueMap.get(normalized)!.label
  }
  if (typeof code === 'string') {
    const recognitionMatch = speechRecognitionCodeMap.get(code.toLowerCase())
    if (recognitionMatch) {
      return recognitionMatch.label
    }
  }
  return code.toUpperCase()
}

type BankFieldType =
  | 'amount'
  | 'sender'
  | 'receiver'
  | 'account'
  | 'bank'
  | 'date'
  | 'time'
  | 'reference'
  | 'other'

type BankFieldSource = 'yolo' | 'api'

interface TransactionField {
  id: string
  type: BankFieldType
  label: string
  value?: string | null
  confidence?: number
  bbox?: [number, number, number, number] | null
}

interface OcrSpan {
  id: string
  text: string
  confidence?: number | null
  bbox?: [number, number, number, number] | null
}

interface BankOcrResult {
  text: string
  lang: string
  confidence?: number | null
  lines: OcrSpan[]
  words: OcrSpan[]
}

type StatusGroupKey = 'language' | 'speech' | 'voice' | 'vision' | 'other'

interface ServiceStatus {
  name: string
  label: string
  status: string
  detail?: unknown
  group: StatusGroupKey
  type: string
}

type HealthServiceEntry = { name: string; status?: string; detail?: unknown }

const serviceGroupMeta: Record<StatusGroupKey, { title: string; subtitle: string; icon: string }> = {
  language: { title: 'Language models', subtitle: 'LLM inference targets', icon: '💬' },
  speech: { title: 'Speech to text', subtitle: 'Transcription services', icon: '🗣️' },
  voice: { title: 'Voice synthesis', subtitle: 'TTS / OpenVoice engines', icon: '🎧' },
  vision: { title: 'Vision & tools', subtitle: 'YOLO / MCP utilities', icon: '🖼️' },
  other: { title: 'Other services', subtitle: 'Miscellaneous endpoints', icon: '🧩' }
}

type CarwatchConnectionState = 'online' | 'connecting' | 'offline'

interface CarwatchDetectionSummary {
  label: string
  count: number
  confidence: number
}

interface CarwatchSnapshot {
  deviceName: string
  connection: CarwatchConnectionState
  batteryPercent: number
  temperatureC: number
  fps: number
  latencyMs: number
  timestamp: string
  streamUrl: string
  thumbUrl: string
  detections: CarwatchDetectionSummary[]
}

interface CarwatchEvent {
  id: string
  label: string
  detail: string
  timestamp: string
}

const statusGroupOrder: StatusGroupKey[] = ['language', 'speech', 'voice', 'vision', 'other']

const serviceMeta: Record<string, { label: string; group: StatusGroupKey; type: string }> = {
  ollama: { label: 'LLM (CPU)', group: 'language', type: 'CPU' },
  ollamaGpu: { label: 'LLM (GPU)', group: 'language', type: 'GPU' },
  stt: { label: 'STT (CPU)', group: 'speech', type: 'CPU' },
  sttGpu: { label: 'STT (GPU)', group: 'speech', type: 'GPU' },
  tts: { label: 'TTS (CPU)', group: 'voice', type: 'CPU' },
  ttsGpu: { label: 'TTS (GPU)', group: 'voice', type: 'GPU' },
  openvoice: { label: 'OpenVoice (CPU)', group: 'voice', type: 'CPU' },
  openvoiceGpu: { label: 'OpenVoice (GPU)', group: 'voice', type: 'GPU' },
  yolo: { label: 'YOLO MCP', group: 'vision', type: 'Service' },
  bslip: { label: 'BSLIP MCP', group: 'vision', type: 'Service' },
  mcpImagen: { label: 'Image MCP (CPU)', group: 'vision', type: 'CPU' },
  mcpImagenGpu: { label: 'Image MCP (GPU)', group: 'vision', type: 'GPU' },
  idp: { label: 'IDP MCP (CPU)', group: 'vision', type: 'CPU' },
  idpGpu: { label: 'IDP MCP (GPU)', group: 'vision', type: 'GPU' },
  anthropic: { label: 'Anthropic API', group: 'language', type: 'Service' },
  openai: { label: 'OpenAI API', group: 'language', type: 'Service' },
  githubModel: { label: 'GitHub Models', group: 'language', type: 'Service' },
  githubMcp: { label: 'GitHub MCP', group: 'other', type: 'Service' },
  mcp0: { label: 'MCP Hub', group: 'other', type: 'Service' }
}

const formatStatusDetail = (detail: unknown): string => {
  if (!detail) return ''
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object') {
    try {
      const serialized = JSON.stringify(detail)
      return serialized === '{}' ? '' : serialized
    } catch {
      return ''
    }
  }
  return ''
}

interface GeneratedImageResult {
  image_base64: string
  prompt: string
  negative_prompt?: string | null
  guidance_scale?: number
  num_inference_steps?: number
  width: number
  height: number
  seed?: number | null
  duration_ms?: number | null
  accelerator?: 'cpu' | 'gpu' | null
}

interface ImagePreviewState {
  image_base64?: string
  step?: number | null
  total_steps?: number | null
  status?: string
}

const BANK_FIELD_KEYWORDS: Record<BankFieldType, string[]> = {
  amount: [
    'amount',
    'total',
    'money',
    'sum',
    'amt',
    'ยอด',
    'ยอดเงิน',
    'จำนวนเงิน',
    'transfer amount',
    'paid'
  ],
  sender: ['sender', 'from', 'payer', 'ผู้โอน', 'sender name', 'account name'],
  receiver: ['receiver', 'to', 'payee', 'ผู้รับ', 'beneficiary', 'recipient'],
  account: ['account', 'acc', 'acct', 'number', 'acct no', 'account no', 'เลขที่บัญชี', 'บัญชี'],
  bank: ['bank', 'branch', 'ธนาคาร', 'สาขา', 'bank name'],
  date: ['date', 'วันที่', 'transaction date'],
  time: ['time', 'เวลา', 'transaction time'],
  reference: ['reference', 'ref', 'transaction id', 'arn', 'หมายเลขอ้างอิง', 'ref no'],
  other: []
}

const BANK_FIELD_LABELS: Record<BankFieldType, string> = {
  amount: 'Amount',
  sender: 'Sender',
  receiver: 'Receiver',
  account: 'Account',
  bank: 'Bank / Branch',
  date: 'Date',
  time: 'Time',
  reference: 'Reference',
  other: 'Other details'
}

const BANK_FIELD_ORDER: BankFieldType[] = ['amount', 'sender', 'receiver', 'account', 'bank', 'date', 'time', 'reference', 'other']

const BANK_FIELD_CONFIDENCE_FLOOR: Partial<Record<BankFieldType, number>> = {
  amount: 0.35,
  sender: 0.3,
  receiver: 0.3,
  account: 0.25,
  bank: 0.25,
  date: 0.2,
  time: 0.2,
  reference: 0.25
}

const normalizeBankFieldType = (raw?: string): BankFieldType => {
  if (!raw) return 'other'
  const normalized = raw.toLowerCase()
  for (const [type, keywords] of Object.entries(BANK_FIELD_KEYWORDS) as [BankFieldType, string[]][]) {
    if (type === 'other') continue
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return type
    }
  }
  return 'other'
}

const normalizeBbox = (bbox: number[]): [number, number, number, number] => {
  const [x1, y1, x2, y2] = bbox
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

const clampBboxToImage = (
  bbox: number[] | undefined,
  imageSize?: { width: number; height: number } | null
): [number, number, number, number] | null => {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null
  const [minX, minY, maxX, maxY] = normalizeBbox(bbox)

  if (!imageSize?.width || !imageSize?.height) {
    return [minX, minY, maxX, maxY]
  }

  const width = Math.max(1, imageSize.width)
  const height = Math.max(1, imageSize.height)
  const x1 = Math.max(0, Math.min(minX, width))
  const y1 = Math.max(0, Math.min(minY, height))
  const x2 = Math.max(x1, Math.min(maxX, width))
  const y2 = Math.max(y1, Math.min(maxY, height))
  return [x1, y1, x2, y2]
}

const bboxDimensions = (clamped: [number, number, number, number]) => {
  const [x1, y1, x2, y2] = clamped
  return {
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1)
  }
}

const safeFilename = (input: string, fallback: string) => {
  const base = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base || fallback
}

const formatImageDuration = (value?: number | null) => {
  if (!value || value <= 0) return null
  if (value < 1000) {
    return `${value} ms`
  }
  const seconds = value / 1000
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`
}

const truncateText = (value: string, limit = 48) => {
  if (!value) return ''
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value
}

const bboxAreaPercent = (
  dims: { width: number; height: number },
  imageSize?: { width: number; height: number } | null
) => {
  if (!imageSize?.width || !imageSize?.height) return null
  const totalArea = imageSize.width * imageSize.height
  if (!totalArea) return null
  return (dims.width * dims.height * 100) / totalArea
}

const formatDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const boxesOverlap = (
  a: [number, number, number, number],
  b: [number, number, number, number]
) => !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1])

const bboxArea = ([x1, y1, x2, y2]: [number, number, number, number]) =>
  Math.max(0, x2 - x1) * Math.max(0, y2 - y1)

const bboxIntersectionArea = (
  a: [number, number, number, number],
  b: [number, number, number, number]
) => {
  const xLeft = Math.max(a[0], b[0])
  const yTop = Math.max(a[1], b[1])
  const xRight = Math.min(a[2], b[2])
  const yBottom = Math.min(a[3], b[3])
  const width = Math.max(0, xRight - xLeft)
  const height = Math.max(0, yBottom - yTop)
  return width * height
}

const bboxOverlapRatio = (
  a: [number, number, number, number],
  b: [number, number, number, number]
) => {
  const intersection = bboxIntersectionArea(a, b)
  if (!intersection) return 0
  const smallest = Math.min(bboxArea(a) || 1, bboxArea(b) || 1)
  return intersection / smallest
}

const normalizeText = (value?: string | null) => value?.replace(/\s+/g, ' ').trim() ?? ''

const extractFieldValue = (label: string, matchedText?: string): string => {
  const sources = [matchedText, label]
    .map((text) => normalizeText(text))
    .filter((text): text is string => !!text)

  const amountRegex = /([+-]?\d[\d,.]*(?:\.\d+)?\s?(?:thb|baht|usd|usd\$|฿|\$)?)/i
  for (const source of sources) {
    const amountMatch = source.match(amountRegex)
    if (amountMatch) {
      return amountMatch[0].trim()
    }
  }

  for (const source of sources) {
    const splitterMatch = source.match(/[:\-]/)
    if (splitterMatch) {
      const [heading, ...rest] = source.split(splitterMatch[0])
      const tail = rest.join(splitterMatch[0]).trim()
      if (tail) {
        return tail
      }
      if (heading) {
        return heading.trim()
      }
    }
  }

  if (sources.length) {
    return sources[0]
  }
  return label.trim()
}

type OcrWordWithBox = OcrSpan & { bbox: [number, number, number, number] }

const collectOcrTextForBbox = (
  bbox: [number, number, number, number] | null,
  words: OcrWordWithBox[]
) => {
  if (!bbox || !words.length) return ''
  const matches = words
    .map((word) => {
      if (!word.bbox) return null
      const overlap = bboxOverlapRatio(bbox, word.bbox)
      if (overlap < 0.25) return null
      return { ...word, overlap }
    })
    .filter((word): word is OcrWordWithBox & { overlap: number } => !!word)
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])

  const text = matches.map((word) => word.text).join(' ')
  return normalizeText(text)
}

const findDuplicateFieldIndex = (
  fields: TransactionField[],
  candidate: TransactionField
) => {
  const candidateBox = candidate.bbox
  if (!candidateBox) return -1
  return fields.findIndex((field) => {
    if (field.type !== candidate.type) return false
    const fieldBox = field.bbox
    if (!fieldBox) return false
    return bboxOverlapRatio(fieldBox, candidateBox) >= 0.65
  })
}

const shouldReplaceField = (existing: TransactionField, next: TransactionField) => {
  const existingConfidence = existing.confidence ?? 0
  const nextConfidence = next.confidence ?? 0
  if (nextConfidence > existingConfidence + 0.05) {
    return true
  }
  if (!existing.value && next.value) {
    return true
  }
  const existingValueLength = existing.value?.length ?? 0
  const nextValueLength = next.value?.length ?? 0
  return nextValueLength > existingValueLength + 3
}

const applyConfidenceFloor = (fields: TransactionField[]) => {
  return fields.filter((field) => {
    const floor = BANK_FIELD_CONFIDENCE_FLOOR[field.type]
    if (typeof floor !== 'number') return true
    return (field.confidence ?? 0) >= floor
  })
}

const buildTransactionFields = (
  detections: DetectionResult[],
  imageSize?: { width: number; height: number } | null,
  ocrWords?: OcrSpan[]
): TransactionField[] => {
  if (!detections.length) return []

  const normalizedWords: OcrWordWithBox[] = (ocrWords || [])
    .map((word) => ({
      ...word,
      bbox: clampBboxToImage(word.bbox ?? undefined, imageSize)
    }))
    .filter((word): word is OcrWordWithBox => !!word.text && !!word.bbox)

  const fields = detections.reduce<TransactionField[]>((acc, det, idx) => {
    const bbox = clampBboxToImage(det.bbox, imageSize)
    const matchedOcrText = collectOcrTextForBbox(bbox, normalizedWords)
    const rawLabel = normalizeText(det.class_name) || matchedOcrText || `Field ${idx + 1}`
    const context = [det.class_name, matchedOcrText].filter(Boolean).join(' ')
    const type = normalizeBankFieldType(context || rawLabel)
    const field: TransactionField = {
      id: `bank-field-${idx}`,
      type,
      label: rawLabel,
      value: extractFieldValue(rawLabel, matchedOcrText),
      confidence: det.confidence,
      bbox
    }

    const duplicateIndex = findDuplicateFieldIndex(acc, field)
    if (duplicateIndex >= 0) {
      if (shouldReplaceField(acc[duplicateIndex], field)) {
        acc[duplicateIndex] = field
      }
      return acc
    }
    acc.push(field)
    return acc
  }, [])

  return applyConfidenceFloor(fields)
}

const mapApiFieldsToTransactionFields = (fields?: ApiBankField[] | null): TransactionField[] => {
  if (!Array.isArray(fields) || fields.length === 0) {
    return []
  }

  return fields.map((field, idx) => {
    const primaryLabel = typeof field.label === 'string' ? field.label : ''
    const inferredType = normalizeBankFieldType(field.type || primaryLabel || '')
    const label = primaryLabel?.trim() || BANK_FIELD_LABELS[inferredType]
    const value = typeof field.value === 'string' ? field.value.trim() : field.value ?? ''
    const bbox = Array.isArray(field.bbox) && field.bbox.length === 4 ? (field.bbox as [number, number, number, number]) : null

    return {
      id: field.id || `mapped-field-${idx}`,
      type: inferredType,
      label,
      value,
      confidence: typeof field.confidence === 'number' ? field.confidence : undefined,
      bbox
    }
  })
}

const normalizeOcrBbox = (bbox?: number[] | null): [number, number, number, number] | null => {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null
  const [x1, y1, x2, y2] = bbox.map((value) => (typeof value === 'number' ? value : Number(value) || 0))
  return [x1, y1, x2, y2]
}

const mapOcrSpans = (spans: any, prefix: string): OcrSpan[] => {
  if (!Array.isArray(spans)) return []
  return spans
    .filter(Boolean)
    .map((span, idx) => ({
      id: typeof span?.id === 'string' ? span.id : `${prefix}-${idx}`,
      text: typeof span?.text === 'string' ? span.text.trim() : '',
      confidence: typeof span?.confidence === 'number' ? span.confidence : null,
      bbox: normalizeOcrBbox(span?.bbox)
    }))
}

interface PendingAttachment {
  id: string
  file: File
  name: string
  type: AttachmentType
  preview?: string
  label?: string
  order: number
  prompt?: string
  mimetype?: string
  size?: number
}

interface UploadedAttachment {
  id?: string
  type: AttachmentType
  name: string
  url: string
  label?: string
  order?: number
  prompt?: string
  base64?: string
  mimetype?: string
  size?: number
}

const builtInLlmModels = ['llama3.2-vision:11b', 'llama3.2:1b', 'llama3.2:3b', 'llama3.1:8b', 'phi3:mini'] as const

const BASE_LLM_PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'openai', label: 'OpenAI GPT' },
  { value: 'github', label: 'GitHub Models' }
]

const SESSION_STORAGE_KEY = 'voice-chat-session-id'

interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  model?: string
  sttModel?: string
  accelerator?: 'cpu' | 'gpu'
  attachmentType?: 'file' | 'image'
  attachmentName?: string
  attachmentUrl?: string
  attachments?: ChatAttachment[]
}

interface SessionResponse {
  sessionId: string
  name?: string
  createdAt: number
  messages: SessionMessage[]
}

interface VoiceOption {
  id: string
  name: string
  sampleRate?: number | null
  engine?: string | null
  language?: string | null
  style?: string | null
  type?: string | null
  tier?: string | null
}

const defaultModels = {
  llm: 'llama3.2:1b',
  whisper: 'tiny'
}

const STORAGE_KEYS = {
  messages: 'chaba.messages',
  sessionId: 'chaba.sessionId',
  meetingSessionId: 'chaba.meetingSessionId',
  accelerator: 'chaba.accelerator',
  voice: 'chaba.voice',
  speechLang: 'chaba.speechLang',
  voiceEngine: 'chaba.voiceEngine',
  llmModel: 'chaba.llmModel',
  llmProvider: 'chaba.llmProvider',
  whisperModel: 'chaba.whisperModel',
  micMode: 'chaba.micMode',
  activePanel: 'chaba.activePanel',
  detectConfidence: 'chaba.detectConfidence',
  detectConfidenceAlt: 'chaba.detect.confidenceAlt',
  detectionTargets: 'chaba.detect.targets',
  showDetectionBoxes: 'chaba.detect.boxes',
  showDetectionBoxesAlt: 'chaba.detect.boxesAlt',
  bankDetectConfidence: 'chaba.bank.confidence',
  bankShowDetectionBoxes: 'chaba.bank.boxes',
  imagePrompt: 'chaba.image.prompt',
  imageNegativePrompt: 'chaba.image.negativePrompt',
  imageGuidance: 'chaba.image.guidance',
  imageSteps: 'chaba.image.steps',
  imageWidth: 'chaba.image.width',
  imageHeight: 'chaba.image.height',
  imageSeed: 'chaba.image.seed',
  imageAccelerator: 'chaba.image.accelerator',
  imageControlsCollapsed: 'chaba.image.controlsCollapsed',
  imageTipsVisible: 'chaba.image.tipsVisible'
}

const IMAGE_DIMENSION_OPTIONS = [384, 512, 640, 768, 896, 1024] as const
const IMAGE_HISTORY_LIMIT = 6
const IMAGE_MIN_GUIDANCE = 1
const IMAGE_MAX_GUIDANCE = 14

interface ImagePromptPreset {
  label: string
  prompt: string
  negative?: string
  width?: number
  height?: number
  guidance?: number
  steps?: number
  accelerator?: 'cpu' | 'gpu'
}

const IMAGE_PROMPT_PRESETS: ImagePromptPreset[] = [
  {
    label: 'Neon alley cityscape',
    prompt:
      'Neon-soaked alley in Bangkok, cinematic rain reflections, Leica Summilux bokeh, Fujifilm colors, cyberpunk street photography',
    negative: 'blurry, low detail, extra limbs',
    width: 768,
    height: 512,
    accelerator: 'gpu'
  },
  {
    label: 'Studio portrait',
    prompt:
      'Soft studio portrait of a confident founder, diffused rim lighting, 85mm lens, medium format, shallow depth of field',
    negative: 'harsh shadows, artifacts, text',
    width: 640,
    height: 768,
    guidance: 8.5,
    accelerator: 'cpu'
  },
  {
    label: 'Product hero',
    prompt:
      'Minimal product hero shot of wireless earbuds on concrete pedestal, volumetric light beams, high contrast, 3D render realism',
    negative: 'logos, people, hands',
    width: 896,
    height: 512,
    steps: 30
  },
  {
    label: 'Concept art',
    prompt:
      'Wide matte painting of floating temples above Chiang Mai mountains, sunrise mist, painterly brush strokes, concept art',
    negative: 'low resolution, noisy',
    width: 1024,
    height: 512,
    steps: 28
  }
]
const IMAGE_MIN_STEPS = 5
const IMAGE_MAX_STEPS = 60
const IMAGE_ACCELERATOR_OPTIONS: Array<{ value: 'cpu' | 'gpu'; label: string }> = [
  { value: 'gpu', label: 'GPU (fastest, requires CUDA)' },
  { value: 'cpu', label: 'CPU (fallback)' }
]

const clampNumeric = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const normalizeImageDimension = (value: number) => {
  const rounded = Math.round(value / 8) * 8
  return clampNumeric(rounded || 512, 256, 1024)
}

const normalizeImageDataUrl = (value: string) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('data:image')) {
    return trimmed
  }
  return `data:image/png;base64,${trimmed}`
}

const parseSeedValue = (seed: string) => {
  if (!seed) return null
  const trimmed = seed.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  return Math.floor(parsed)
}

const mapImageResponse = (payload: any): GeneratedImageResult => {
  const accelerator = typeof payload?.accelerator === 'string' ? payload.accelerator.toLowerCase() : null
  const normalizedAccelerator = accelerator === 'gpu' || accelerator === 'cpu' ? accelerator : null
  const imageBase64 = typeof payload?.image_base64 === 'string' ? normalizeImageDataUrl(payload.image_base64) : ''
  return {
    image_base64: imageBase64,
    prompt: String(payload?.prompt || ''),
    negative_prompt:
      typeof payload?.negative_prompt === 'string' && payload.negative_prompt.trim()
        ? payload.negative_prompt
        : null,
    guidance_scale:
      typeof payload?.guidance_scale === 'number' ? payload.guidance_scale : undefined,
    num_inference_steps:
      typeof payload?.num_inference_steps === 'number' ? payload.num_inference_steps : undefined,
    width: typeof payload?.width === 'number' ? payload.width : 512,
    height: typeof payload?.height === 'number' ? payload.height : 512,
    seed: typeof payload?.seed === 'number' ? payload.seed : null,
    duration_ms:
      typeof payload?.duration_ms === 'number'
        ? payload.duration_ms
        : typeof payload?.durationMs === 'number'
          ? payload.durationMs
          : null,
    accelerator: normalizedAccelerator
  }
}

type StorageScope = 'local' | 'session'

const storagePreference = new Map<string, StorageScope>()
const disabledStorageKeys = new Set<string>()

const getStorage = (scope: StorageScope): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return scope === 'local' ? window.localStorage : window.sessionStorage
  } catch (err) {
    console.warn(`Storage unavailable for ${scope}Storage`, err)
    return null
  }
}

const isQuotaExceededError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const domAvailable = typeof DOMException !== 'undefined'
  if (domAvailable && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    )
  }
  const code = (error as { code?: number }).code
  return code === 22 || code === 1014
}

const getStorageOrder = (key: string): StorageScope[] => {
  return storagePreference.get(key) === 'session' ? ['session', 'local'] : ['local', 'session']
}

const readFromStorage = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback
  const scopes = getStorageOrder(key)
  for (const scope of scopes) {
    const storage = getStorage(scope)
    if (!storage) continue
    try {
      const raw = storage.getItem(key)
      if (raw === null) continue
      const parsed = JSON.parse(raw) as T
      storagePreference.set(key, scope)
      return parsed
    } catch (err) {
      console.warn('Failed to read storage key', key, err)
    }
  }
  return fallback
}

const writeToStorage = (key: string, value: unknown) => {
  if (typeof window === 'undefined' || disabledStorageKeys.has(key)) return
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (err) {
    console.error('Failed to serialize storage value', key, err)
    return
  }

  const scopes = getStorageOrder(key)
  let lastError: unknown = null
  const startedWithSession = storagePreference.get(key) === 'session'

  for (const scope of scopes) {
    const storage = getStorage(scope)
    if (!storage) continue
    try {
      storage.setItem(key, serialized)
      storagePreference.set(key, scope)
      if (scope === 'session' && !startedWithSession) {
        console.warn(`Persisted ${key} to sessionStorage after localStorage quota exceeded`)
      }
      return
    } catch (err) {
      lastError = err
      if (isQuotaExceededError(err)) {
        if (scope === 'local') {
          console.warn(`localStorage quota exceeded for ${key}; attempting sessionStorage fallback`)
          continue
        }
        console.error(`Storage quota exceeded for ${key}; disabling persistence`, err)
        break
      }
      console.error('Failed to persist storage key', key, err)
      break
    }
  }

  disabledStorageKeys.add(key)
  if (lastError) {
    console.error('Disabling persistence due to repeated failures for key', key, lastError)
  }
}

type VoiceEngineFilter = 'all' | 'piper' | 'openvoice'

const VOICE_ENGINE_FILTERS: { value: VoiceEngineFilter; label: string }[] = [
  { value: 'all', label: 'All voices' },
  { value: 'piper', label: 'Standard (Piper)' },
  { value: 'openvoice', label: 'Premium (OpenVoice)' }
]

const MAX_PERSISTED_MESSAGES = 200
const HISTORY_FOR_SERVER = 20

interface HistoryEntry {
  role: ChatMessage['role']
  content: string
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.messages)
      if (!stored) return []
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        return parsed.slice(-MAX_PERSISTED_MESSAGES)
      }
    } catch (err) {
      console.warn('Failed to read stored messages', err)
    }
    return []
  })
  const [input, setInput] = useState('')
  const [replying, setReplying] = useState(false)
  const [activeReplyContext, setActiveReplyContext] = useState<ActiveReplyContext | null>(null)
  const [listening, setListening] = useState(false)
  const [recording, setRecording] = useState(false)
  const [health, setHealth] = useState<'unknown' | 'ok' | 'error'>('unknown')
  const [healthInfo, setHealthInfo] = useState<any>(null)
  const [statusExpanded, setStatusExpanded] = useState(false)
  const [stackSidebarCollapsed, setStackSidebarCollapsed] = useState(false)
  const [quickMenuAnchorEl, setQuickMenuAnchorEl] = useState<null | HTMLElement>(null)
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false)
  const [mcpPanelMessageId, setMcpPanelMessageId] = useState<string | null>(null)
  const [mcpManualProvider, setMcpManualProvider] = useState('')
  const [mcpManualTool, setMcpManualTool] = useState('')
  const [mcpManualArgs, setMcpManualArgs] = useState('{}')
  const [mcpManualResult, setMcpManualResult] = useState<unknown>(null)
  const [mcpManualError, setMcpManualError] = useState<string | null>(null)
  const [mcpManualLoading, setMcpManualLoading] = useState(false)
  const [popupVisible, setPopupVisible] = useState(false)
  const [llmProvider, setLlmProvider] = useState<LlmProvider>(() => readFromStorage(STORAGE_KEYS.llmProvider, 'ollama'))
  const [llmModel, setLlmModel] = useState<string>(() => readFromStorage(STORAGE_KEYS.llmModel, defaultModels.llm))
  const [whisperModel, setWhisperModel] = useState(() =>
    readFromStorage(STORAGE_KEYS.whisperModel, defaultModels.whisper)
  )
  const [mcpProviderNames, setMcpProviderNames] = useState<string[]>([])
  const [mcpProviders, setMcpProviders] = useState<McpProviderInfo[]>([])
  const [acceleratorMode, setAcceleratorMode] = useState<'cpu' | 'gpu'>(() => {
    if (typeof window === 'undefined') return 'gpu'
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.accelerator)
      if (stored === 'cpu' || stored === 'gpu') {
        return stored
      }
    } catch (err) {
      console.warn('Failed to read stored acceleratorMode', err)
    }
    return 'gpu'
  })
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [clipboardSupported, setClipboardSupported] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [detectConfidence, setDetectConfidence] = useState(() =>
    readFromStorage(STORAGE_KEYS.detectConfidence, 0.25)
  )
  const [detectConfidenceAlt, setDetectConfidenceAlt] = useState(() =>
    readFromStorage(STORAGE_KEYS.detectConfidenceAlt, 0.25)
  )
  const [detecting, setDetecting] = useState(false)
  const [detectingAlt, setDetectingAlt] = useState(false)
  const [lastDetectionFile, setLastDetectionFile] = useState<File | null>(null)
  const [lastDetectionFileAlt, setLastDetectionFileAlt] = useState<File | null>(null)
  const [detectionImage, setDetectionImage] = useState<string | null>(null)
  const [detectionImageAlt, setDetectionImageAlt] = useState<string | null>(null)
  const [detectionPreviewUrl, setDetectionPreviewUrl] = useState<string | null>(null)
  const [detectionPreviewUrlAlt, setDetectionPreviewUrlAlt] = useState<string | null>(null)
  const [detectionExpanded, setDetectionExpanded] = useState(false)
  const [detectionExpandedAlt, setDetectionExpandedAlt] = useState(false)
  const [showDetectionBoxes, setShowDetectionBoxes] = useState(() =>
    readFromStorage(STORAGE_KEYS.showDetectionBoxes, true)
  )
  const [showDetectionBoxesAlt, setShowDetectionBoxesAlt] = useState(() =>
    readFromStorage(STORAGE_KEYS.showDetectionBoxesAlt, true)
  )
  const [detectionResults, setDetectionResults] = useState<DetectionResult[]>([])
  const [detectionResultsAlt, setDetectionResultsAlt] = useState<DetectionResult[]>([])
  const [detectionImageSize, setDetectionImageSize] = useState<{ width: number; height: number } | null>(null)
  const [detectionImageSizeAlt, setDetectionImageSizeAlt] = useState<{ width: number; height: number } | null>(null)
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [detectionErrorAlt, setDetectionErrorAlt] = useState<string | null>(null)
  const [secondaryDetectionTargets, setSecondaryDetectionTargets] = useState<string[]>(() =>
    readFromStorage(STORAGE_KEYS.detectionTargets, ['face'])
  )
  const [hoveredDetection, setHoveredDetection] = useState<number | null>(null)
  const [hoveredDetectionAlt, setHoveredDetectionAlt] = useState<number | null>(null)
  const [bankDetectConfidence, setBankDetectConfidence] = useState(() =>
    readFromStorage(STORAGE_KEYS.bankDetectConfidence, 0.35)
  )
  const [bankDetecting, setBankDetecting] = useState(false)
  const [bankDetectionImage, setBankDetectionImage] = useState<string | null>(null)
  const [bankDetectionPreviewUrl, setBankDetectionPreviewUrl] = useState<string | null>(null)
  const [bankDetectionExpanded, setBankDetectionExpanded] = useState(false)
  const [bankShowDetectionBoxes, setBankShowDetectionBoxes] = useState(() =>
    readFromStorage(STORAGE_KEYS.bankShowDetectionBoxes, true)
  )
  const [bankDetectionResults, setBankDetectionResults] = useState<DetectionResult[]>([])
  const [bankDetectionError, setBankDetectionError] = useState<string | null>(null)
  const [bankDetectionImageSize, setBankDetectionImageSize] = useState<{ width: number; height: number } | null>(
    null
  )
  const [bankFields, setBankFields] = useState<TransactionField[]>([])
  const [bankFieldSource, setBankFieldSource] = useState<BankFieldSource>('api')
  const [bankDetectionSourceFile, setBankDetectionSourceFile] = useState<File | null>(null)
  const [bankOcrResult, setBankOcrResult] = useState<BankOcrResult | null>(null)
  const [bankOcrLang, setBankOcrLang] = useState('eng')
  const [bankOcrBusy, setBankOcrBusy] = useState(false)
  const [bankVerificationInfo, setBankVerificationInfo] = useState<BankVerificationInfo>({})
  const bankSummaryFieldCount = useMemo(() => bankFields.length, [bankFields])
  const bankSummaryAvgConfidence = useMemo(() => {
    if (!bankFields.length) return '—'
    const total = bankFields.reduce(
      (acc, field) => acc + (typeof field.confidence === 'number' ? field.confidence : 0),
      0
    )
    if (total <= 0) return '—'
    const avg = total / bankFields.length
    return `${(avg * 100).toFixed(1).replace(/\.0$/, '')}% avg`
  }, [bankFields])
  const bankVerificationProviderLabel = useMemo(() => {
    return bankVerificationInfo.provider?.trim() || '—'
  }, [bankVerificationInfo.provider])
  const bankVerificationStatusLabel = useMemo(() => {
    return bankVerificationInfo.status?.trim() || '—'
  }, [bankVerificationInfo.status])
  const bankVerificationReferenceLabel = useMemo(() => {
    return bankVerificationInfo.referenceId?.trim() || '—'
  }, [bankVerificationInfo.referenceId])
  const [bankOcrError, setBankOcrError] = useState<string | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [imageStandaloneMode, setImageStandaloneMode] = useState(() => {
    if (typeof window === 'undefined') return false
    return IMAGE_STANDALONE_PATHS.has(window.location.pathname)
  })
  const [activePanel, setActivePanel] = useState<
    'chat' | 'openvoice' | 'carwatch' | 'image-mcp' | 'yolo-detection' | 'bank-slip' | 'meeting'
  >(() => {
    if (typeof window !== 'undefined' && IMAGE_STANDALONE_PATHS.has(window.location.pathname)) {
      return 'image-mcp'
    }
    return readFromStorage(STORAGE_KEYS.activePanel, 'chat')
  })
  const [inlineSpeakerState, setInlineSpeakerState] = useState<InlineSpeakerState>({
    messageId: null,
    status: 'idle'
  })
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return window.localStorage.getItem(STORAGE_KEYS.sessionId)
    } catch (err) {
      console.warn('Failed to read stored sessionId', err)
      return null
    }
  })
  const [meetingSessionId, setMeetingSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return window.localStorage.getItem(STORAGE_KEYS.meetingSessionId)
    } catch (err) {
      console.warn('Failed to read stored meetingSessionId', err)
      return null
    }
  })
  const [meetingSessions, setMeetingSessions] = useState<MeetingSessionSummary[]>([])
  const [meetingSessionsLoading, setMeetingSessionsLoading] = useState(false)
  const [meetingSessionsError, setMeetingSessionsError] = useState<string | null>(null)
  const [selectedMeetingSession, setSelectedMeetingSession] = useState<string | null>(null)
  const [meetingSessionDetail, setMeetingSessionDetail] = useState<MeetingSessionDetail | null>(null)
  const [meetingDetailLoading, setMeetingDetailLoading] = useState(false)
  const [meetingDetailError, setMeetingDetailError] = useState<string | null>(null)
  const [meetingSummaryLoading, setMeetingSummaryLoading] = useState(false)
  const [meetingSummaryError, setMeetingSummaryError] = useState<string | null>(null)
  const [meetingTitleInput, setMeetingTitleInput] = useState('')
  const [meetingFilterText, setMeetingFilterText] = useState('')
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | null>(null)
  const [selectedVoice, setSelectedVoice] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return window.localStorage.getItem(STORAGE_KEYS.voice)
    } catch (err) {
      console.warn('Failed to read stored voice selection', err)
      return null
    }
  })
  const [voiceFetchError, setVoiceFetchError] = useState<string | null>(null)
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false)
  const [voicePreviewError, setVoicePreviewError] = useState<string | null>(null)
  const [providersInitialized, setProvidersInitialized] = useState(false)
  const [githubModelStatus, setGithubModelStatus] = useState<{ status: string; detail?: string | null } | null>(null)
  const [githubModelChecking, setGithubModelChecking] = useState(false)
  const [githubModelError, setGithubModelError] = useState<string | null>(null)
  const [carwatchSnapshot, setCarwatchSnapshot] = useState<CarwatchSnapshot | null>(null)
  const [carwatchEvents, setCarwatchEvents] = useState<CarwatchEvent[]>([])
  const [carwatchLoading, setCarwatchLoading] = useState(false)
  const [carwatchError, setCarwatchError] = useState<string | null>(null)
  const speechLanguageHelper = SPEECH_LANGUAGE_HELPER
  const llmProviderHelper = LLM_PROVIDER_HELPER
  const whisperHelper = WHISPER_HELPER
  const [speechStatusMessage, setSpeechStatusMessage] = useState<string | null>(null)

  const VOICE_SERVICE_HINT =
    'Voice service unavailable. Ensure the OpenVoice containers are running (openvoice-tts / openvoice-tts-gpu) and reload.'
  const appendVoiceServiceHint = (message: string) => {
    const trimmed = (message || '').trim()
    if (!trimmed) {
      return VOICE_SERVICE_HINT
    }
    const needsPeriod = !/[.!?]$/.test(trimmed)
    return `${trimmed}${needsPeriod ? '.' : ''} ${VOICE_SERVICE_HINT}`
  }
  const [speechLanguage, setSpeechLanguage] = useState(() => readFromStorage(STORAGE_KEYS.speechLang, 'auto'))
  const [browserDetectedLanguage, setBrowserDetectedLanguage] = useState<string | null>(null)

  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const [micMode, setMicMode] = useState<'browser' | 'server'>(() =>
    readFromStorage(STORAGE_KEYS.micMode, 'browser')
  )
  const [referenceRecorder, setReferenceRecorder] = useState<MediaRecorder | null>(null)
  const [referenceRecording, setReferenceRecording] = useState(false)
  const [referenceAudioBlob, setReferenceAudioBlob] = useState<Blob | null>(null)
  const [referenceAudioUrl, setReferenceAudioUrl] = useState<string | null>(null)
  const [referenceDurationMs, setReferenceDurationMs] = useState(0)
  const [referenceFilename, setReferenceFilename] = useState('openvoice-reference')
  const [referenceRecorderError, setReferenceRecorderError] = useState<string | null>(null)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [showCamera, setShowCamera] = useState(false)
  const [attachmentPreview, setAttachmentPreview] = useState<{ src: string; name: string } | null>(
    null
  )
  const [imagePrompt, setImagePrompt] = useState(() => readFromStorage(STORAGE_KEYS.imagePrompt, ''))
  const [imageNegativePrompt, setImageNegativePrompt] = useState(() =>
    readFromStorage(STORAGE_KEYS.imageNegativePrompt, '')
  )
  const [imageGuidance, setImageGuidance] = useState(() => readFromStorage(STORAGE_KEYS.imageGuidance, 7))
  const [imageSteps, setImageSteps] = useState(() => readFromStorage(STORAGE_KEYS.imageSteps, 25))
  const [imageWidth, setImageWidth] = useState(() => readFromStorage(STORAGE_KEYS.imageWidth, 512))
  const [imageHeight, setImageHeight] = useState(() => readFromStorage(STORAGE_KEYS.imageHeight, 512))
  const [imageSeed, setImageSeed] = useState(() => readFromStorage(STORAGE_KEYS.imageSeed, ''))
  const [imageAccelerator, setImageAccelerator] = useState<'cpu' | 'gpu'>(() => {
    if (typeof window === 'undefined') return 'gpu'
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.imageAccelerator)
      if (stored === 'cpu' || stored === 'gpu') {
        return stored
      }
    } catch (err) {
      console.warn('Failed to read stored image accelerator', err)
    }
    return 'gpu'
  })
  const [imageControlsCollapsed, setImageControlsCollapsed] = useState(() =>
    readFromStorage(STORAGE_KEYS.imageControlsCollapsed, false)
  )
  const [imageTipsVisible, setImageTipsVisible] = useState(() =>
    readFromStorage(STORAGE_KEYS.imageTipsVisible, false)
  )
  const [imageResults, setImageResults] = useState<GeneratedImageResult[]>([])
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imageStreamControllerRef = useRef<AbortController | null>(null)
  const detectFileInputRef = useRef<HTMLInputElement | null>(null)
  const detectFileInputRefAlt = useRef<HTMLInputElement | null>(null)
  const detectFileInputRefBank = useRef<HTMLInputElement | null>(null)
  const chatMessagesRef = useRef<HTMLDivElement | null>(null)
  const statusWrapperRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)
  const audioEventCleanupRef = useRef<(() => void) | null>(null)
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const inlinePlaybackModeRef = useRef<InlinePlaybackMode | null>(null)
  const referenceChunksRef = useRef<BlobPart[]>([])
  const referenceTimerRef = useRef<number | null>(null)
  const referenceStartRef = useRef<number>(0)
  const referenceRecorderRef = useRef<MediaRecorder | null>(null)
  const referenceStreamRef = useRef<MediaStream | null>(null)
  const activeReplyAbortControllerRef = useRef<AbortController | null>(null)
  const userCancelledReplyRef = useRef(false)

  const pendingPreviewRef = useRef<PendingAttachment[]>([])
  const attachmentCounterRef = useRef(1)

  useEffect(() => {
    pendingPreviewRef.current = pendingAttachments
  }, [pendingAttachments])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const updateStandaloneMode = () => {
      const isStandalone = IMAGE_STANDALONE_PATHS.has(window.location.pathname)
      setImageStandaloneMode(isStandalone)
      if (isStandalone) {
        setActivePanel('image-mcp')
      }
    }

    updateStandaloneMode()
    window.addEventListener('popstate', updateStandaloneMode)
    window.addEventListener('hashchange', updateStandaloneMode)
    return () => {
      window.removeEventListener('popstate', updateStandaloneMode)
      window.removeEventListener('hashchange', updateStandaloneMode)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (activeReplyAbortControllerRef.current) {
        activeReplyAbortControllerRef.current.abort()
        activeReplyAbortControllerRef.current = null
      }
    }
  }, [])

  const handleCancelReply = useCallback(() => {
    if (!replying) return
    userCancelledReplyRef.current = true
    if (activeReplyAbortControllerRef.current) {
      try {
        activeReplyAbortControllerRef.current.abort()
      } catch (err) {
        console.warn('Abort controller cancel failed', err)
      }
    }
    setActiveReplyContext((ctx) => (ctx ? { ...ctx, cancellable: false } : ctx))
  }, [replying])

  useEffect(() => {
    return () => {
      pendingPreviewRef.current.forEach((att) => {
        if (att.preview && att.preview.startsWith('blob:')) {
          URL.revokeObjectURL(att.preview)
        }
      })
    }
  }, [])

  useEffect(() => {
    return () => {
      if (detectionPreviewUrl) {
        URL.revokeObjectURL(detectionPreviewUrl)
      }
    }
  }, [detectionPreviewUrl])

  useEffect(() => {
    return () => {
      if (detectionPreviewUrlAlt) {
        URL.revokeObjectURL(detectionPreviewUrlAlt)
      }
    }
  }, [detectionPreviewUrlAlt])

  useEffect(() => {
    return () => {
      if (bankDetectionPreviewUrl && bankDetectionPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(bankDetectionPreviewUrl)
      }
    }
  }, [bankDetectionPreviewUrl])

  useEffect(() => {
    setHoveredDetection(null)
  }, [detectionResults, secondaryDetectionTargets])

  useEffect(() => {
    setHoveredDetectionAlt(null)
  }, [detectionResultsAlt, secondaryDetectionTargets])

  useEffect(() => {
    if (!popupVisible) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPopupVisible(false)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [popupVisible])

  useEffect(() => {
    return () => {
      if (referenceTimerRef.current) {
        window.clearInterval(referenceTimerRef.current)
        referenceTimerRef.current = null
      }
      if (referenceRecorderRef.current && referenceRecorderRef.current.state !== 'inactive') {
        try {
          referenceRecorderRef.current.stop()
        } catch (err) {
          console.warn('Reference recorder cleanup error', err)
        }
      }
      if (referenceStreamRef.current) {
        referenceStreamRef.current.getTracks().forEach((track) => track.stop())
        referenceStreamRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (referenceAudioUrl) {
        URL.revokeObjectURL(referenceAudioUrl)
      }
    }
  }, [referenceAudioUrl])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.__YOLO_TEST_HOOKS__ = {
      setPrimaryDetections: ({ image, results }: DetectionTestPayload) => {
        setDetectionError(null)
        setDetectionImage(image)
        setDetectionResults(results)
        setDetectionPreviewUrl(image)
        setShowDetectionBoxes(true)
        setDetectionExpanded(false)
        setDetectionImageSize(null)
      },
      setLinkedDetections: ({ image, results }: DetectionTestPayload) => {
        setDetectionErrorAlt(null)
        setDetectionImageAlt(image)
        setDetectionResultsAlt(results)
        setDetectionPreviewUrlAlt(image)
        setShowDetectionBoxesAlt(true)
        setDetectionExpandedAlt(false)
        setHoveredDetectionAlt(null)
        setDetectionImageSizeAlt(null)
      }
    }

    return () => {
      if (window.__YOLO_TEST_HOOKS__) {
        delete window.__YOLO_TEST_HOOKS__
      }
    }
  }, [])

  const nowString = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const stopSpeech = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      speechUtteranceRef.current = null
    }
    if (inlinePlaybackModeRef.current === 'speech') {
      inlinePlaybackModeRef.current = null
    }
    setInlineSpeakerState({ messageId: null, status: 'idle' })
  }

  const pauseSpeechPlayback = () => {
    if (!('speechSynthesis' in window)) return false
    const synth = window.speechSynthesis
    if (synth.speaking && !synth.paused) {
      synth.pause()
      return true
    }
    return false
  }

  const resumeSpeechPlayback = () => {
    if (!('speechSynthesis' in window)) return false
    const synth = window.speechSynthesis
    if (synth.speaking && synth.paused) {
      synth.resume()
      return true
    }
    return false
  }

  const speak = (text: string, lifecycle?: SpeakLifecycle) => {
    if (!('speechSynthesis' in window)) return
    stopSpeech()
    const utter = new SpeechSynthesisUtterance(text)
    speechUtteranceRef.current = utter
    inlinePlaybackModeRef.current = 'speech'

    if (lifecycle?.onStart) {
      utter.onstart = lifecycle.onStart
    }
    utter.onend = () => {
      if (speechUtteranceRef.current === utter) {
        speechUtteranceRef.current = null
      }
      if (inlinePlaybackModeRef.current === 'speech') {
        inlinePlaybackModeRef.current = null
      }
      lifecycle?.onEnd?.()
    }
    utter.onerror = () => {
      if (speechUtteranceRef.current === utter) {
        speechUtteranceRef.current = null
      }
      if (inlinePlaybackModeRef.current === 'speech') {
        inlinePlaybackModeRef.current = null
      }
      lifecycle?.onError?.()
    }

    window.speechSynthesis.speak(utter)
  }

  const stopAudioPlayback = () => {
    if (audioEventCleanupRef.current) {
      audioEventCleanupRef.current()
      audioEventCleanupRef.current = null
    }
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      audioPlayerRef.current.src = ''
      audioPlayerRef.current = null
    }
    if (inlinePlaybackModeRef.current === 'audio') {
      inlinePlaybackModeRef.current = null
    }
  }

  const pauseAudioPlayback = () => {
    const player = audioPlayerRef.current
    if (player && !player.paused) {
      player.pause()
      return true
    }
    return false
  }

  const resumeAudioPlayback = () => {
    const player = audioPlayerRef.current
    if (player && player.paused) {
      const resumed = player.play()
      if (resumed && typeof resumed.then === 'function') {
        resumed.catch((err) => {
          console.error('Audio resume failed', err)
          stopAudioPlayback()
        })
      }
      return true
    }
    return false
  }

  const playResponseAudio = (audioPath?: string, options?: PlayAudioOptions) => {
    if (!audioPath) return false
    const absolute = absoluteServerUrl(audioPath)
    if (!absolute) return false

    try {
      stopAudioPlayback()
      const player = new Audio(absolute)
      audioPlayerRef.current = player

      const handlePlaying = () => {
        options?.onStart?.()
      }

      const handleEnded = () => {
        options?.onEnded?.()
        cleanup()
      }

      const handleError = () => {
        options?.onEnded?.()
        cleanup()
      }

      const cleanup = () => {
        player.removeEventListener('playing', handlePlaying)
        player.removeEventListener('ended', handleEnded)
        player.removeEventListener('error', handleError)
        if (audioEventCleanupRef.current === cleanup) {
          audioEventCleanupRef.current = null
        }
      }

      player.addEventListener('playing', handlePlaying)
      player.addEventListener('ended', handleEnded)
      player.addEventListener('error', handleError)
      audioEventCleanupRef.current = cleanup

      const playPromise = player.play()
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.catch((err) => {
          console.error('Audio playback failed', err)
          cleanup()
        })
      }
      return true
    } catch (err) {
      console.error('Audio playback setup failed', err)
      return false
    }
  }

  const synthesizeInlineVoice = async (messageId: string, text: string, voiceId: string) => {
    try {
      const response = await fetch(PREVIEW_VOICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId,
          accelerator: acceleratorMode,
          text: text.slice(0, 800)
        })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || 'inline_voice_request_failed')
      }
      const data = await response.json()
      if (!data?.audioUrl) {
        throw new Error('inline_voice_audio_missing')
      }

      inlinePlaybackModeRef.current = 'audio'
      const started = playResponseAudio(data.audioUrl, {
        onStart: () => {
          setInlineSpeakerState({ messageId, status: 'playing' })
        },
        onEnded: () => {
          inlinePlaybackModeRef.current = null
          setInlineSpeakerState((prev) =>
            prev.messageId === messageId ? { messageId: null, status: 'idle' } : prev
          )
        }
      })

      if (!started) {
        inlinePlaybackModeRef.current = null
        throw new Error('inline_voice_play_failed')
      }
      return true
    } catch (err) {
      inlinePlaybackModeRef.current = null
      setInlineSpeakerState((prev) =>
        prev.messageId === messageId ? { messageId: null, status: 'idle' } : prev
      )
      console.error('Inline voice playback failed', err)
      return false
    }
  }

  const previewVoice = useCallback(async () => {
    if (!selectedVoice) {
      setVoicePreviewError('Select a voice first')
      return
    }
    setVoicePreviewLoading(true)
    setVoicePreviewError(null)
    try {
      const response = await fetch(PREVIEW_VOICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selectedVoice, accelerator: acceleratorMode })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || 'Preview failed')
      }
      const data = await response.json()
      if (!data?.audioUrl) {
        throw new Error('Preview audio unavailable')
      }
      playResponseAudio(data.audioUrl)
    } catch (err: any) {
      setVoicePreviewError(err?.message || 'Preview failed')
    } finally {
      setVoicePreviewLoading(false)
    }
  }, [selectedVoice, acceleratorMode])

  const addMessage = (
    msg: Omit<ChatMessage, 'id' | 'time'> & { voiceId?: string | null; id?: string; time?: string }
  ) => {
    const resolvedVoiceId =
      msg.role === 'assistant'
        ? msg.voiceId || selectedVoice || selectedVoiceInfo?.id || null
        : msg.voiceId || null
    const generatedId = msg.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const generatedTime = msg.time || new Date().toLocaleTimeString()
    setMessages((prev) => [
      ...prev,
      {
        id: generatedId,
        time: generatedTime,
        ...msg,
        voiceId: resolvedVoiceId || undefined
      }
    ])
    return generatedId
  }

  const updateMessage = useCallback(
    (
      messageId: string,
      updater: Partial<ChatMessage> | ((current: ChatMessage) => Partial<ChatMessage>)
    ) => {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg
          const next = typeof updater === 'function' ? updater(msg) : updater
          return { ...msg, ...next }
        })
      )
    },
    []
  )

  const llmProviderOptions = useMemo(() => {
    const baseOptions = [...BASE_LLM_PROVIDER_OPTIONS]
    if (!mcpProviderNames.includes('githubModel')) {
      return baseOptions.filter((option) => option.value !== 'github')
    }
    return baseOptions
  }, [mcpProviderNames])

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(HEALTH_URL)
      if (!res.ok) throw new Error('health not ok')
      const data = await res.json()
      setHealth('ok')
      setHealthInfo(data)
      if (typeof data.defaultModel === 'string') {
        setLlmModel(data.defaultModel)
      }
    } catch (e) {
      console.error('health error', e)
      setHealth('error')
    }
  }, [])

  const fetchMcpProviders = useCallback(async () => {
    const fetchJson = async (url: string) => {
      const target = url.includes('?') ? url : `${url}?refresh=true`
      const res = await fetch(target)
      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || `Fetch failed ${res.status}`)
      }
      return res.json()
    }

    const processData = (data: unknown) => {
      if (Array.isArray(data)) {
        setMcpProviders(data as McpProviderInfo[])
        const names = data
          .map((entry) => (entry && typeof (entry as McpProviderInfo).name === 'string' ? (entry as McpProviderInfo).name.trim() : ''))
          .filter((name): name is string => !!name)
        setMcpProviderNames(names)
      }
    }

    try {
      const primary = await fetchJson(MCP0_PROVIDERS_API)
      processData(primary)
    } catch (primaryErr) {
      console.warn('Primary MCP provider fetch failed', primaryErr)
      try {
        const fallback = await fetchJson(MCP_PROVIDERS_URL)
        processData(fallback)
      } catch (err) {
        console.error('Failed to load MCP providers', err)
        setMcpProviders([])
        setMcpProviderNames([])
      }
    } finally {
      setProvidersInitialized(true)
    }
  }, [])

  const availableManualTools = useMemo(() => {
    const provider = mcpProviders.find((p) => p.name === mcpManualProvider)
    return provider?.default_tools || []
  }, [mcpManualProvider, mcpProviders])

  const activeMcpMessage = useMemo(() => {
    if (!mcpPanelMessageId) return null
    return messages.find((m) => m.id === mcpPanelMessageId) || null
  }, [mcpPanelMessageId, messages])

  const handleOpenMcpPanel = useCallback(
    (message: ChatMessage) => {
      if (!mcpProviderNames.length) return
      setMcpPanelMessageId(message.id)
      setMcpPanelOpen(true)
      setMcpManualResult(null)
      setMcpManualError(null)
      setMcpManualArgs('{}')

      let nextProvider = mcpManualProvider
      if (!nextProvider && mcpProviderNames.length) {
        nextProvider = mcpProviderNames[0]
        setMcpManualProvider(nextProvider)
      }
      const providerEntry = mcpProviders.find((p) => p.name === nextProvider)
      const providerTools = providerEntry?.default_tools || []
      if (!mcpManualTool && providerTools.length) {
        setMcpManualTool(providerTools[0])
      }
    },
    [mcpManualProvider, mcpManualTool, mcpProviderNames, mcpProviders]
  )

  const closeMcpPanel = useCallback(() => {
    setMcpPanelOpen(false)
    setMcpPanelMessageId(null)
    setMcpManualResult(null)
    setMcpManualError(null)
    setMcpManualLoading(false)
  }, [])

  useEffect(() => {
    if (!mcpPanelOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMcpPanel()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [mcpPanelOpen, closeMcpPanel])

  useEffect(() => {
    if (!statusExpanded) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setStatusExpanded(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [statusExpanded])

  const handleRunManualTool = useCallback(async () => {
    if (!mcpManualProvider || !mcpManualTool) {
      setMcpManualError('Select provider and tool')
      return
    }
    let parsedArgs: Record<string, unknown> = {}
    if (mcpManualArgs.trim()) {
      try {
        parsedArgs = JSON.parse(mcpManualArgs)
      } catch (err: any) {
        setMcpManualError(`Invalid JSON: ${err?.message || 'Parse error'}`)
        return
      }
    }
    setMcpManualError(null)
    setMcpManualLoading(true)
    try {
      const res = await fetch(MCP0_TOOLS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: mcpManualProvider, tool: mcpManualTool, arguments: parsedArgs })
      })
      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setMcpManualResult(data?.result ?? data)
    } catch (err: any) {
      setMcpManualError(err?.message || 'Tool invocation failed')
      setMcpManualResult(null)
    } finally {
      setMcpManualLoading(false)
    }
  }, [mcpManualArgs, mcpManualProvider, mcpManualTool])

  const handleRefreshProviders = useCallback(() => {
    setHealth('unknown')
    fetchHealth()
    fetchMcpProviders()
  }, [fetchHealth, fetchMcpProviders])

  useEffect(() => {
    const run = async () => {
      try {
        await handleRefreshProviders()
      } catch (err) {
        console.warn('handleRefreshProviders failed', err)
      }
    }
    run()
  }, [handleRefreshProviders])

  const healthServices = useMemo<HealthServiceEntry[]>(() => {
    if (!Array.isArray(healthInfo?.services)) {
      return []
    }

    return (healthInfo.services as HealthServiceEntry[]).filter(
      (svc): svc is HealthServiceEntry => !!svc && typeof svc.name === 'string'
    )
  }, [healthInfo])

  const providerHealthStatus = useMemo<ProviderHealthStatus>(() => {
    if (!healthServices.length) {
      return {
        ollama: 'unknown',
        anthropic: 'unknown',
        openai: 'unknown',
        github: 'unknown'
      }
    }

    const statusMap = new Map<string, string>()
    for (const svc of healthServices) {
      statusMap.set(svc.name, (svc.status || 'unknown').toLowerCase())
    }

    const resolveStatus = (...names: string[]): ProviderHealthStatus[LlmProvider] => {
      if (names.some((name) => statusMap.get(name) === 'ok')) {
        return 'ok'
      }
      if (names.some((name) => statusMap.has(name))) {
        return 'error'
      }
      return 'unknown'
    }

    return {
      ollama: resolveStatus('ollama', 'ollamaGpu'),
      anthropic: resolveStatus('anthropic'),
      openai: resolveStatus('openai'),
      github: resolveStatus('githubModel')
    }
  }, [healthServices])

  const voiceFeatureEnabled = Boolean(healthInfo?.voiceFeatureEnabled)

  const openvoiceCpuHealthy = useMemo(
    () => healthServices.some((svc) => svc.name === 'openvoice' && svc.status === 'ok'),
    [healthServices]
  )
  const openvoiceGpuHealthy = useMemo(
    () => healthServices.some((svc) => svc.name === 'openvoiceGpu' && svc.status === 'ok'),
    [healthServices]
  )
  const visibleVoiceOptions = useMemo(() => {
    if (!voiceFeatureEnabled) {
      return []
    }
    if (!openvoiceCpuHealthy && !openvoiceGpuHealthy) {
      return []
    }
    if (!voiceOptions.length) return voiceOptions
    if (openvoiceGpuHealthy) {
      return voiceOptions
    }
    return voiceOptions.filter((voice) => (voice.tier || 'standard').toLowerCase() !== 'premium')
  }, [voiceOptions, openvoiceCpuHealthy, openvoiceGpuHealthy, voiceFeatureEnabled])

  const voiceStatusTone: StatusTone = voicesLoading
    ? 'loading'
    : !voiceFeatureEnabled
      ? 'unknown'
      : visibleVoiceOptions.length
        ? 'ok'
        : voiceFetchError
          ? 'error'
          : 'unknown'

  const voiceStatusLabel =
    voicesLoading
      ? 'Loading voices…'
      : !voiceFeatureEnabled
        ? 'Voice disabled'
        : visibleVoiceOptions.length
          ? `${visibleVoiceOptions.length} voice${visibleVoiceOptions.length > 1 ? 's' : ''} ready`
          : 'No voices available'

  const voiceStatusHelper =
    !voiceFeatureEnabled
      ? 'Start the OpenVoice containers to unlock voice playback.'
      : !visibleVoiceOptions.length && !voicesLoading
        ? 'Refresh provider status once OpenVoice services are online.'
        : null

  useEffect(() => {
    fetchHealth()
    fetchMcpProviders()
  }, [fetchHealth, fetchMcpProviders])

  const fetchCarwatchSnapshot = useCallback(async () => {
    setCarwatchLoading(true)
    try {
      const res = await fetch(CARWATCH_SNAPSHOT_URL)
      if (res.status === 404) {
        setCarwatchSnapshot(null)
        setCarwatchEvents([])
        setCarwatchError('No snapshot available yet')
        return
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(detail || 'carwatch_fetch_failed')
      }
      const data = await res.json().catch(() => null)
      if (data?.snapshot) {
        setCarwatchSnapshot(data.snapshot as CarwatchSnapshot)
        setCarwatchEvents(Array.isArray(data.snapshot.events) ? data.snapshot.events : [])
        setCarwatchError(null)
      } else {
        setCarwatchSnapshot(null)
        setCarwatchEvents([])
        setCarwatchError('Snapshot missing in response')
      }
    } catch (err: any) {
      setCarwatchError(err?.message || 'Unable to load CarWatch snapshot')
    } finally {
      setCarwatchLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCarwatchSnapshot().catch(() => null)
    const interval = window.setInterval(() => {
      fetchCarwatchSnapshot().catch(() => null)
    }, 30000)
    return () => {
      window.clearInterval(interval)
    }
  }, [fetchCarwatchSnapshot])

  const handleCarwatchRefresh = useCallback(() => {
    fetchCarwatchSnapshot().catch(() => null)
  }, [fetchCarwatchSnapshot])

  useEffect(() => {
    if (!providersInitialized) return
    if (!llmProviderOptions.some((option) => option.value === llmProvider)) {
      return
    }
  }, [llmProviderOptions, llmProvider, providersInitialized])

  useEffect(() => {
    if (!providersInitialized) return
    if (!llmProviderOptions.length) return
    const currentStatus = providerHealthStatus[llmProvider] || 'unknown'
    if (currentStatus === 'ok') return
    const fallbackOption = llmProviderOptions.find((option) => providerHealthStatus[option.value] === 'ok')
    if (fallbackOption && fallbackOption.value !== llmProvider) {
      setLlmProvider(fallbackOption.value)
    }
  }, [providersInitialized, llmProviderOptions, llmProvider, providerHealthStatus])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.llmProvider, llmProvider)
  }, [llmProvider])

  useEffect(() => {
    if (!statusExpanded) return

    const handleClickAway = (event: MouseEvent) => {
      if (!statusWrapperRef.current) return
      if (statusWrapperRef.current.contains(event.target as Node)) return
      setStatusExpanded(false)
    }

    document.addEventListener('mousedown', handleClickAway)
    return () => document.removeEventListener('mousedown', handleClickAway)
  }, [statusExpanded])

  useEffect(() => {
    setClipboardSupported(typeof navigator !== 'undefined' && !!navigator.clipboard?.read)
  }, [])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.llmModel, llmModel)
  }, [llmModel])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.whisperModel, whisperModel)
  }, [whisperModel])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.accelerator, acceleratorMode)
  }, [acceleratorMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!messages.length) {
      window.localStorage.removeItem(STORAGE_KEYS.messages)
      return
    }
    try {
      const trimmed = messages.slice(-MAX_PERSISTED_MESSAGES)
      window.localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(trimmed))
    } catch (err) {
      console.error('Failed to persist messages', err)
    }
  }, [messages])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (sessionId) {
        window.localStorage.setItem(STORAGE_KEYS.sessionId, sessionId)
      } else {
        window.localStorage.removeItem(STORAGE_KEYS.sessionId)
      }
    } catch (err) {
      console.error('Failed to persist sessionId', err)
    }
  }, [sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (meetingSessionId) {
        window.localStorage.setItem(STORAGE_KEYS.meetingSessionId, meetingSessionId)
      } else {
        window.localStorage.removeItem(STORAGE_KEYS.meetingSessionId)
      }
    } catch (err) {
      console.error('Failed to persist meetingSessionId', err)
    }
  }, [meetingSessionId])

  useEffect(() => {
    if (selectedVoice) {
      writeToStorage(STORAGE_KEYS.voice, selectedVoice)
    } else if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEYS.voice)
    }
  }, [selectedVoice])

  useEffect(() => {
    if (speechLanguage) {
      writeToStorage(STORAGE_KEYS.speechLang, speechLanguage)
    }
  }, [speechLanguage])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.detectConfidence, detectConfidence)
  }, [detectConfidence])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.detectConfidenceAlt, detectConfidenceAlt)
  }, [detectConfidenceAlt])

    useEffect(() => {
    writeToStorage(STORAGE_KEYS.bankDetectConfidence, bankDetectConfidence)
  }, [bankDetectConfidence])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.showDetectionBoxes, showDetectionBoxes)
  }, [showDetectionBoxes])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.showDetectionBoxesAlt, showDetectionBoxesAlt)
  }, [showDetectionBoxesAlt])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.bankShowDetectionBoxes, bankShowDetectionBoxes)
  }, [bankShowDetectionBoxes])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.detectionTargets, secondaryDetectionTargets)
  }, [secondaryDetectionTargets])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.micMode, micMode)
  }, [micMode])

  useEffect(() => {
    if (imageStandaloneMode) return
    writeToStorage(STORAGE_KEYS.activePanel, activePanel)
  }, [activePanel, imageStandaloneMode])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imagePrompt, imagePrompt)
  }, [imagePrompt])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageNegativePrompt, imageNegativePrompt)
  }, [imageNegativePrompt])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageGuidance, imageGuidance)
  }, [imageGuidance])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageSteps, imageSteps)
  }, [imageSteps])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageWidth, imageWidth)
  }, [imageWidth])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageHeight, imageHeight)
  }, [imageHeight])

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageSeed, imageSeed)
  }, [imageSeed])

  useEffect(() => {
    if (!voiceFeatureEnabled) {
      setVoiceOptions([])
      setDefaultVoiceId(null)
      setVoiceFetchError(null)
      setVoicesLoading(false)
      return
    }

    let cancelled = false

    const loadVoices = async () => {
      setVoicesLoading(true)
      try {
        const res = await fetch(VOICES_URL)
        if (!res.ok) {
          const detailText = await res.text()
          let parsedMessage: string | null = detailText ? detailText.trim() : null
          try {
            const parsed = detailText ? JSON.parse(detailText) : null
            const serverError = typeof parsed?.error === 'string' ? parsed.error : null
            const serverDetail = typeof parsed?.detail === 'string' ? parsed.detail : null
            const serverMessage = typeof parsed?.message === 'string' ? parsed.message : null
            parsedMessage = serverDetail || serverMessage || serverError || parsedMessage
            if (serverError === 'voices_unavailable') {
              parsedMessage = appendVoiceServiceHint(parsedMessage || 'Voice service unavailable')
            }
          } catch (jsonErr) {
            console.warn('Failed to parse voice error payload', jsonErr)
          }
          const statusMsg = `Voice fetch failed (HTTP ${res.status}).`
          throw new Error([statusMsg, parsedMessage].filter(Boolean).join(' '))
        }
        const data = await res.json()
        if (cancelled) return
        const incomingVoices: VoiceOption[] = Array.isArray(data?.voices) ? data.voices : []
        setVoiceOptions(incomingVoices)
        setDefaultVoiceId(typeof data?.defaultVoice === 'string' ? data.defaultVoice : null)
        setVoiceFetchError(null)
      } catch (err: any) {
        if (cancelled) return
        console.error('Voice fetch failed', err)
        let friendlyMessage = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : ''
        if (!friendlyMessage || /failed to fetch/i.test(friendlyMessage) || /network/i.test(friendlyMessage)) {
          friendlyMessage = appendVoiceServiceHint('Cannot reach the voice service')
        }
        if (!friendlyMessage.toLowerCase().includes('voice service unavailable')) {
          friendlyMessage = appendVoiceServiceHint(friendlyMessage)
        }
        setVoiceFetchError(friendlyMessage)
        setVoiceOptions([])
      } finally {
        if (!cancelled) {
          setVoicesLoading(false)
        }
      }
    }

    loadVoices().catch((err) => {
      console.error('Voice fetch unexpected error', err)
    })

    return () => {
      cancelled = true
    }
  }, [voiceFeatureEnabled])

  const checkGithubModel = useCallback(async () => {
    setGithubModelChecking(true)
    setGithubModelError(null)
    try {
      const res = await fetch(GITHUB_MODEL_HEALTH_URL)
      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setGithubModelStatus({ status: data?.status || 'unknown', detail: data?.detail })
    } catch (err: any) {
      setGithubModelError(err?.message || 'Failed to check GitHub model')
      setGithubModelStatus(null)
    } finally {
      setGithubModelChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!visibleVoiceOptions.length) {
      if (selectedVoice !== null) {
        setSelectedVoice(null)
      }
      return
    }
    if (selectedVoice && visibleVoiceOptions.some((voice) => voice.id === selectedVoice)) {
      return
    }
    const fallback =
      (defaultVoiceId && visibleVoiceOptions.find((voice) => voice.id === defaultVoiceId)?.id) || visibleVoiceOptions[0].id
    setSelectedVoice(fallback)
  }, [visibleVoiceOptions, defaultVoiceId, selectedVoice])

  useEffect(() => {
    if (!visibleVoiceOptions.length) return
    if (speechLanguage === 'th') {
      const thaiVoice = visibleVoiceOptions.find((voice) => voice.id.toLowerCase().includes('th'))
      if (thaiVoice && thaiVoice.id !== selectedVoice) {
        setSelectedVoice(thaiVoice.id)
      }
    }
  }, [speechLanguage, visibleVoiceOptions, selectedVoice])

  useEffect(() => {
    if (activePanel !== 'chat') {
      setShowScrollToBottom(false)
      return
    }

    const container = chatMessagesRef.current
    if (!container) return

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      setShowScrollToBottom(distanceFromBottom > 120)
    }

    container.addEventListener('scroll', handleScroll)
    handleScroll()

    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [messages.length, replying, activePanel])

  useEffect(() => {
    if (activePanel !== 'chat') return
    const container = chatMessagesRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceFromBottom <= 160) {
      scrollChatToBottom(true)
    }
  }, [messages.length, replying, activePanel])

  const runWithAcceleratorFallback = async <T,>(
    task: (acc: 'cpu' | 'gpu') => Promise<T>,
    preferred: 'cpu' | 'gpu'
  ): Promise<{ result: T; acceleratorUsed: 'cpu' | 'gpu'; fellBack: boolean }> => {
    try {
      const result = await task(preferred)
      return { result, acceleratorUsed: preferred, fellBack: false }
    } catch (err) {
      if (preferred === 'gpu') {
        console.warn('GPU request failed, retrying on CPU', err)
        const fallbackResult = await task('cpu')
        return { result: fallbackResult, acceleratorUsed: 'cpu', fellBack: true }
      }
      throw err
    }
  }

  const summarizeAttachments = (attachments?: ChatAttachment[]) => {
    if (!attachments?.length) return ''
    const lines: string[] = []
    attachments.forEach((att, idx) => {
      const reference = att.order ?? idx + 1
      const name = att.label?.trim() ? att.label.trim() : `Attachment ${reference}`
      const typeLabel = att.type ? ` (${att.type})` : ''
      lines.push(`- ${name}${typeLabel}`)
      if (att.url) {
        lines.push(`  URL: ${att.url}`)
      }
      if (att.mimetype || typeof att.size === 'number') {
        const parts: string[] = []
        if (att.mimetype) parts.push(att.mimetype)
        if (typeof att.size === 'number') parts.push(`${att.size} bytes`)
        if (parts.length) {
          lines.push(`  Info: ${parts.join(', ')}`)
        }
      }
      // Avoid sending base64 payloads back to the server—it's already stored locally.
      if (att.base64) {
        lines.push('  DataURI: [stripped]')
      }
      if (att.prompt?.trim()) {
        lines.push(`  Prompt: ${att.prompt.trim()}`)
      }
    })
    return `[Attachments]\n${lines.join('\n')}`
  }

  const formatMessageContent = (text: string, attachments?: ChatAttachment[]) => {
    const base = (text || '').trim()
    const attachmentSummary = summarizeAttachments(attachments)
    if (attachmentSummary) {
      return base ? `${base}\n\n${attachmentSummary}` : attachmentSummary
    }
    return base
  }

  const buildHistoryPayload = (): HistoryEntry[] =>
    messages
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .slice(-HISTORY_FOR_SERVER)
      .map((m) => ({ role: m.role, content: formatMessageContent(m.text, m.attachments) }))

  const sendMessage = async (
    text: string,
    opts?: { accelerator?: 'cpu' | 'gpu'; attachments?: UploadedAttachment[]; sttLanguage?: string | null }
  ) => {
    if (replying) return

    const trimmed = (text || '').trim()
    const attachmentsForMessage = opts?.attachments ?? []
    if (!trimmed && attachmentsForMessage.length === 0) return

    stopSpeech()

    const targetAccelerator = opts?.accelerator ?? acceleratorMode
    const historyPayload = buildHistoryPayload()

    const contentForServer = formatMessageContent(trimmed, attachmentsForMessage)
    const attachmentsWithIds: ChatAttachment[] = attachmentsForMessage.map((att, idx) => ({
      ...att,
      id: att.id || `attachment-${Date.now()}-${idx}`
    }))
    const firstAttachment = attachmentsWithIds[0]

    addMessage({
      role: 'user',
      text: trimmed,
      model: llmModel,
      accelerator: targetAccelerator,
      sttLanguage: opts?.sttLanguage || null,
      attachments: attachmentsWithIds,
      attachmentType: firstAttachment?.type,
      attachmentName: firstAttachment?.name,
      attachmentUrl: firstAttachment?.url
    })
    setInput('')
    setReplying(true)

    try {
      const voiceForServer =
        selectedVoice && visibleVoiceOptions.some((voice) => voice.id === selectedVoice)
          ? selectedVoice
          : undefined
      const requestBodyBase = {
        message: contentForServer,
        model: llmModel,
        sessionId,
        history: historyPayload,
        provider: llmProvider,
        voice: voiceForServer
      }

      if (providerSupportsStreaming(llmProvider)) {
        const assistantMessageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        addMessage({
          id: assistantMessageId,
          role: 'assistant',
          text: '',
          model: llmModel,
          accelerator: targetAccelerator,
          mcpToolRuns: undefined,
          diagnostics: null
        })

        const streamRequest = async (acc: 'cpu' | 'gpu') => {
          const res = await fetch(API_STREAM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...requestBodyBase, accelerator: acc })
          })
          if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => '')
            throw new Error(detail || 'stream_request_failed')
          }

          return await new Promise<{
            reply: string
            audioUrl?: string | null
            session?: SessionResponse | null
            diagnostics?: DiagnosticsInfo | null
            mcpTools?: McpToolRun[]
          }>((resolve, reject) => {
            let settled = false
            let latestText = ''

            const settle = (type: 'resolve' | 'reject', value: unknown) => {
              if (settled) return
              settled = true
              if (type === 'resolve') {
                resolve(value as {
                  reply: string
                  audioUrl?: string | null
                  session?: SessionResponse | null
                  diagnostics?: DiagnosticsInfo | null
                  mcpTools?: McpToolRun[]
                })
              } else {
                reject(value)
              }
            }

            readSseStream(res.body!, (event) => {
              if (event.type === 'delta') {
                const full = event.full || ''
                latestText = full || `${latestText}${event.delta || ''}`
                updateMessage(assistantMessageId, {
                  text: latestText,
                  accelerator: acc
                })
              } else if (event.type === 'complete') {
                const finalText = event.reply || latestText
                latestText = finalText
                if (event.session?.sessionId) {
                  setSessionId(event.session.sessionId)
                }
                updateMessage(assistantMessageId, (current) => ({
                  text: finalText,
                  accelerator: acc,
                  diagnostics: event.diagnostics || current.diagnostics || null,
                  mcpToolRuns: event.mcpTools?.length ? event.mcpTools : current.mcpToolRuns
                }))
                settle('resolve', {
                  reply: finalText,
                  audioUrl: event.audioUrl,
                  session: event.session,
                  diagnostics: event.diagnostics || null,
                  mcpTools: event.mcpTools
                })
              } else if (event.type === 'error') {
                settle('reject', new Error(event.error || 'stream_error'))
              }
            })
              .then(() => {
                if (!settled) {
                  settle('reject', new Error('stream_closed'))
                }
              })
              .catch((err) => {
                settle('reject', err)
              })
          })
        }

        const {
          result: streamResult,
          acceleratorUsed,
          fellBack
        } = await runWithAcceleratorFallback(streamRequest, targetAccelerator)

        if (fellBack) {
          addMessage({
            role: 'system',
            text: 'GPU services unavailable, rerouted to CPU.',
            model: llmModel
          })
        }

        if (streamResult?.reply) {
          updateMessage(assistantMessageId, {
            text: streamResult.reply,
            accelerator: acceleratorUsed,
            mcpToolRuns: streamResult.mcpTools,
            diagnostics: streamResult.diagnostics || null
          })
        }

        const returnedSessionId = streamResult?.session?.sessionId || null
        if (returnedSessionId) {
          setSessionId(returnedSessionId)
        }

        if (AUTO_SPEECH_REPLIES_ENABLED && streamResult?.reply) {
          const played = playResponseAudio(streamResult.audioUrl || undefined)
          if (!played) {
            speak(streamResult.reply)
          }
        }
      } else {
        const makeRequest = async (acc: 'cpu' | 'gpu') => {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...requestBodyBase, accelerator: acc })
          })
          if (!res.ok) {
            const detail = await res.text()
            throw new Error(detail || 'request_failed')
          }
          return res.json()
        }

        const {
          result: data,
          acceleratorUsed,
          fellBack
        } = await runWithAcceleratorFallback(makeRequest, targetAccelerator)
        if (fellBack) {
          addMessage({
            role: 'system',
            text: 'GPU services unavailable, rerouted to CPU.',
            model: llmModel
          })
        }
        if (data.error) {
          addMessage({ role: 'system', text: `Error: ${data.error}`, model: llmModel })
          return
        }
        const returnedSessionId = data.session?.sessionId || data.sessionId || null
        if (returnedSessionId) {
          setSessionId(returnedSessionId)
        }
        const reply = data.reply || ''
        addMessage({
          role: 'assistant',
          text: reply,
          model: llmModel,
          accelerator: acceleratorUsed,
          mcpToolRuns: Array.isArray(data?.mcpTools) ? data.mcpTools : undefined
        })
        if (AUTO_SPEECH_REPLIES_ENABLED && reply) {
          const played = playResponseAudio(data.audioUrl || undefined)
          if (!played) {
            speak(reply)
          }
        }
      }
    } catch (e: any) {
      console.error(e)
      addMessage({ role: 'system', text: 'Network error talking to server', model: llmModel })
    } finally {
      setReplying(false)
    }
  }

  const sendInputWithAttachments = async () => {
    if (replying) return
    const currentInput = input
    const trimmed = currentInput.trim()
    if (!trimmed && !pendingAttachments.length) return

    let uploaded: UploadedAttachment[] = []

    if (pendingAttachments.length) {
      try {
        uploaded = await uploadPendingAttachments()
      } catch (err: any) {
        console.error('Attachment upload failed', err)
        addMessage({
          role: 'system',
          text: `Attachment upload failed: ${err?.message || 'unknown error'}`,
          model: llmModel
        })
        return
      }
    }

    await sendMessage(currentInput, {
      attachments: uploaded.length ? uploaded : undefined
    })
  }

  const handleSendClick = () => {
    void sendInputWithAttachments()
  }

  const handleEditMessage = (message: ChatMessage) => {
    if (replying) return
    setInput(message.text)
    textInputRef.current?.focus()
  }

  const handleResendMessage = (message: ChatMessage) => {
    if (replying) return
    void sendMessage(message.text, { accelerator: acceleratorMode })
  }

  const refreshMeetingSessions = useCallback(
    async (options?: { includeArchived?: boolean }) => {
      if (!MEETING_SESSIONS_URL) return
      setMeetingSessionsLoading(true)
      setMeetingSessionsError(null)
      try {
        const url = new URL(MEETING_SESSIONS_URL)
        if (options?.includeArchived) {
          url.searchParams.set('includeArchived', 'true')
        }
        const response = await fetch(url.toString())
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail || `HTTP ${response.status}`)
        }
        const data = await response.json()
        const sessions = Array.isArray(data?.sessions) ? (data.sessions as MeetingSessionSummary[]) : []
        setMeetingSessions(sessions)
        return sessions
      } catch (err: any) {
        setMeetingSessionsError(err?.message || 'Unable to load meeting sessions')
        return []
      } finally {
        setMeetingSessionsLoading(false)
      }
    },
    []
  )

  const createMeetingSession = useCallback(
    async (options?: { title?: string | null }) => {
      if (!MEETING_SESSIONS_URL) return null
      setMeetingSessionsError(null)
      const sessionId = `meeting-${Date.now()}`
      try {
        const response = await fetch(MEETING_SESSIONS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, title: options?.title || undefined })
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail || `HTTP ${response.status}`)
        }
        await refreshMeetingSessions().catch(() => null)
        return sessionId
      } catch (err: any) {
        setMeetingSessionsError(err?.message || 'Unable to create meeting session')
        return null
      }
    },
    [refreshMeetingSessions]
  )

  const ensureMeetingSessionId = useCallback(
    async (options?: { title?: string | null }) => {
      if (meetingSessionId) {
        return meetingSessionId
      }
      const created = await createMeetingSession({ title: options?.title })
      if (created) {
        setMeetingSessionId(created)
      }
      return created
    },
    [meetingSessionId, createMeetingSession]
  )

  const fetchMeetingDetail = useCallback(
    async (sessionId: string, entryLimit?: number) => {
      if (!sessionId) {
        setMeetingSessionDetail(null)
        return null
      }
      setMeetingDetailLoading(true)
      setMeetingDetailError(null)
      try {
        const url = new URL(meetingSessionDetailUrl(sessionId))
        if (entryLimit && entryLimit > 0) {
          url.searchParams.set('entryLimit', entryLimit.toString())
        }
        const response = await fetch(url.toString())
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail || `HTTP ${response.status}`)
        }
        const data = (await response.json()) as MeetingSessionDetail
        setMeetingSessionDetail(data)
        return data
      } catch (err: any) {
        setMeetingDetailError(err?.message || 'Unable to load meeting detail')
        setMeetingSessionDetail(null)
        return null
      } finally {
        setMeetingDetailLoading(false)
      }
    },
    []
  )

  const summarizeMeeting = useCallback(
    async (sessionId: string, maxEntries?: number) => {
      if (!sessionId) return null
      setMeetingSummaryLoading(true)
      setMeetingSummaryError(null)
      try {
        const response = await fetch(meetingSessionSummarizeUrl(sessionId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxEntries })
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail || `HTTP ${response.status}`)
        }
        const data = await response.json()
        await fetchMeetingDetail(sessionId)
        return data
      } catch (err: any) {
        setMeetingSummaryError(err?.message || 'Unable to summarize meeting')
        return null
      } finally {
        setMeetingSummaryLoading(false)
      }
    },
    [fetchMeetingDetail]
  )

  useEffect(() => {
    if (meetingSessionId) {
      fetchMeetingDetail(meetingSessionId).catch(() => null)
    }
  }, [meetingSessionId, fetchMeetingDetail])

  const appendMeetingTranscript = useCallback(
    async (text: string, options?: { speaker?: string; language?: string | null }) => {
      const trimmed = (text || '').trim()
      if (!trimmed) {
        return
      }
      if (!MEETING_TRANSCRIPT_URL) {
        return
      }
      const session = await ensureMeetingSessionId()
      if (!session) {
        return
      }
      try {
        const response = await fetch(MEETING_TRANSCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session,
            text: trimmed,
            speaker: options?.speaker,
            language: options?.language
          })
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          console.warn('Meeting transcript append failed', detail || response.status)
          return
        }
        const payload = await response.json().catch(() => null)
        if (payload?.sessionId && payload.sessionId !== meetingSessionId) {
          setMeetingSessionId(payload.sessionId)
        }
      } catch (err) {
        console.warn('Meeting transcript append error', err)
      }
    },
    [ensureMeetingSessionId, meetingSessionId]
  )

  const getLanguageLabel = (code?: string | null) => getSpeechLanguageLabel(code)

  const formatMeetingTimestamp = (value?: string) => {
    if (!value) return ''
    try {
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return value
    }
  }

  const formatMeetingDate = (value?: string) => {
    if (!value) return '—'
    try {
      return new Date(value).toLocaleString()
    } catch {
      return value
    }
  }

  const filteredMeetingSessions = useMemo(() => {
    if (!meetingFilterText.trim()) return meetingSessions
    const query = meetingFilterText.trim().toLowerCase()
    return meetingSessions.filter((session) => {
      const fields = [
        session.session_id,
        session.title,
        ...(session.participants || []),
        ...(session.tags || [])
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
      return fields.some((field) => field.includes(query))
    })
  }, [meetingSessions, meetingFilterText])

  const activeMeetingSessionId = selectedMeetingSession || meetingSessionId || null

  const handleSelectMeetingSession = useCallback(
    (sessionId: string) => {
      if (!sessionId) return
      setSelectedMeetingSession(sessionId)
      setMeetingSessionId(sessionId)
      fetchMeetingDetail(sessionId).catch(() => null)
    },
    [fetchMeetingDetail]
  )

  const handleRefreshMeetingDetail = useCallback(() => {
    if (activeMeetingSessionId) {
      fetchMeetingDetail(activeMeetingSessionId).catch(() => null)
    }
  }, [activeMeetingSessionId, fetchMeetingDetail])

  const handleCreateMeetingSession = useCallback(async () => {
    const desiredTitle = meetingTitleInput.trim() || 'Untitled meeting'
    const sessionId = await createMeetingSession({ title: desiredTitle })
    if (!sessionId) return
    setMeetingTitleInput('')
    setMeetingSessionId(sessionId)
    handleSelectMeetingSession(sessionId)
  }, [meetingTitleInput, createMeetingSession, handleSelectMeetingSession])

  useEffect(() => {
    refreshMeetingSessions().catch(() => null)
  }, [refreshMeetingSessions])

  useEffect(() => {
    if (meetingSessionId && !selectedMeetingSession) {
      setSelectedMeetingSession(meetingSessionId)
    }
  }, [meetingSessionId, selectedMeetingSession])

  const startListening = async () => {
    if (!SpeechRecognitionImpl) {
      alert('SpeechRecognition not supported in this browser')
      return
    }

    stopSpeech()
    setBrowserDetectedLanguage(null)

    if (navigator.permissions?.query) {
      try {
        const permissionResult = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        if (permissionResult.state === 'denied') {
          alert('Microphone permission denied. Please enable it in browser settings for speech input.')
          return
        }
      } catch (err) {
        console.warn('Microphone permission query failed', err)
      }
    }

    const Recog = SpeechRecognitionImpl
    const recognition = new Recog()
    const recognitionLang = getSpeechRecognitionCode(speechLanguage)
    if (speechLanguage === 'auto') {
      // Let the browser pick the best language based on user/system settings.
      recognition.lang = ''
    } else {
      recognition.lang = recognitionLang || 'en-US'
    }
    recognition.interimResults = true
    recognition.continuous = false

    setSpeechStatusMessage('Listening… please start speaking near the microphone')
    setListening(true)

    let finalText = ''
    let detectedLang: string | null = null

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript
      }
      finalText = text
      const latest = event.results[event.results.length - 1]?.[0] as SpeechRecognitionResult['0'] & {
        language?: string
      }
      if (latest && typeof (latest as any).language === 'string') {
        detectedLang = normalizeSpeechLanguageValue((latest as any).language)
        setBrowserDetectedLanguage(detectedLang)
      }
    }

    recognition.onerror = (event: Event) => {
      console.error(event)
      setListening(false)
      const errorCode = (event as { error?: string }).error
      if (errorCode === 'no-speech') {
        setSpeechStatusMessage('We did not detect speech. Try speaking closer to the mic and tap Speak again.')
        return
      }
      if (errorCode === 'audio-capture') {
        alert('Microphone is busy or unavailable. Ensure no other app is using it and try again.')
        setSpeechStatusMessage('Microphone busy. Free it up, then tap Speak again.')
      } else if (errorCode === 'not-allowed') {
        alert('Microphone permission denied. Please allow access in your browser settings.')
        setSpeechStatusMessage('Microphone permission denied in browser settings.')
      }
    }

    recognition.onend = () => {
      setListening(false)
      if (finalText.trim()) {
        setInput(finalText)
        const langHint =
          detectedLang ||
          browserDetectedLanguage ||
          (speechLanguage && speechLanguage !== 'auto' ? speechLanguage : null)
        void sendMessage(finalText, { sttLanguage: langHint })
        void appendMeetingTranscript(finalText, { speaker: 'user', language: langHint })
        setBrowserDetectedLanguage(null)
        setSpeechStatusMessage(null)
      } else {
        setSpeechStatusMessage('No speech captured. Please try again and begin speaking right away.')
      }
    }

    recognition.start()
  }

  const sendAudioBlob = async (blob: Blob) => {
    setReplying(true)
    stopSpeech()

    try {
      const targetAccelerator = acceleratorMode

      const makeAudioRequest = async (acc: 'cpu' | 'gpu') => {
        const formData = new FormData()
        formData.append('audio', blob, 'audio.webm')
        formData.append('model', llmModel)
        formData.append('whisper_model', whisperModel)
        formData.append('accelerator', acc)
        formData.append('provider', llmProvider)
        if (selectedVoice && visibleVoiceOptions.some((voice) => voice.id === selectedVoice)) {
          formData.append('voice', selectedVoice)
        }
        if (speechLanguage) {
          formData.append('language', speechLanguage)
        }

        const res = await fetch(API_AUDIO_URL, {
          method: 'POST',
          body: formData
        })

        if (!res.ok) {
          const detail = await res.text()
          throw new Error(detail || 'audio_request_failed')
        }

        return res.json()
      }

      const {
        result: data,
        acceleratorUsed,
        fellBack
      } = await runWithAcceleratorFallback(makeAudioRequest, targetAccelerator)
      if (fellBack) {
        addMessage({
          role: 'system',
          text: 'GPU audio path unavailable, rerouted to CPU.',
          model: llmModel
        })
      }

      const usedWhisperModel = (data && data.model) || whisperModel
      const detectedLanguage = (data && data.language) || (speechLanguage !== 'auto' ? speechLanguage : null)
      if (data.error) {
        console.error('audio endpoint error:', data)
        addMessage({ role: 'system', text: `Audio flow error: ${data.error}`, model: llmModel })
        return
      }

      if (data.transcript) {
        addMessage({
          role: 'user',
          text: data.transcript,
          model: llmModel,
          sttModel: usedWhisperModel,
          sttLanguage: detectedLanguage,
          accelerator: acceleratorUsed
        })
      }

      if (data.reply) {
        addMessage({
          role: 'assistant',
          text: data.reply,
          model: llmModel,
          sttModel: usedWhisperModel,
          sttLanguage: detectedLanguage,
          accelerator: acceleratorUsed,
          mcpToolRuns: Array.isArray(data?.mcpTools) ? data.mcpTools : undefined
        })
        if (AUTO_SPEECH_REPLIES_ENABLED) {
          const played = playResponseAudio(data.audioUrl)
          if (!played) {
            speak(data.reply)
          }
        }
      }
    } catch (e) {
      console.error(e)
      addMessage({ role: 'system', text: 'Error talking to audio endpoint', model: llmModel })
    } finally {
      setReplying(false)
    }
  }

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('getUserMedia not supported in this browser')
      return
    }

    stopSpeech()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks: BlobPart[] = []

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data)
        }
      }

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        stream.getTracks().forEach((t) => t.stop())
        await sendAudioBlob(blob)
      }

      setMediaRecorder(recorder)
      setRecording(true)
      recorder.start()
    } catch (e) {
      console.error(e)
      alert('Could not start recording')
    }
  }

  const stopRecording = () => {
    if (mediaRecorder && recording) {
      mediaRecorder.stop()
      setRecording(false)
    }
  }

  const stopReferenceTimer = () => {
    if (referenceTimerRef.current) {
      window.clearInterval(referenceTimerRef.current)
      referenceTimerRef.current = null
    }
  }

  const clearReferenceAudio = () => {
    stopReferenceTimer()
    referenceChunksRef.current = []
    if (referenceAudioUrl) {
      URL.revokeObjectURL(referenceAudioUrl)
    }
    setReferenceAudioBlob(null)
    setReferenceAudioUrl(null)
    setReferenceDurationMs(0)
  }

  const startReferenceRecording = async () => {
    if (referenceRecording) return
    setReferenceRecorderError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setReferenceRecorderError('getUserMedia is not supported in this browser')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      referenceChunksRef.current = []
      referenceStartRef.current = Date.now()
      setReferenceDurationMs(0)
      if (referenceAudioUrl) {
        URL.revokeObjectURL(referenceAudioUrl)
        setReferenceAudioUrl(null)
      }
      setReferenceAudioBlob(null)

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          referenceChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        stopReferenceTimer()
        setReferenceRecording(false)
        setReferenceRecorder(null)
        referenceRecorderRef.current = null
        if (referenceStreamRef.current) {
          referenceStreamRef.current.getTracks().forEach((track) => track.stop())
          referenceStreamRef.current = null
        }
        const chunks = referenceChunksRef.current.slice()
        referenceChunksRef.current = []
        if (!chunks.length) {
          setReferenceRecorderError('No audio captured')
          return
        }
        const mimeType = recorder.mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type: mimeType })
        const url = URL.createObjectURL(blob)
        setReferenceAudioBlob(blob)
        setReferenceAudioUrl(url)
        setReferenceDurationMs(Date.now() - referenceStartRef.current)
      }

      recorder.onerror = () => {
        setReferenceRecorderError('Recorder error occurred')
      }

      referenceStreamRef.current = stream
      referenceRecorderRef.current = recorder
      setReferenceRecorder(recorder)
      setReferenceRecording(true)
      stopReferenceTimer()
      referenceTimerRef.current = window.setInterval(() => {
        setReferenceDurationMs(Date.now() - referenceStartRef.current)
      }, 200)
      recorder.start()
    } catch (err: any) {
      console.error('Reference recording failed', err)
      setReferenceRecorderError(err?.message || 'Unable to access microphone')
    }
  }

  const stopReferenceRecording = () => {
    if (referenceRecorderRef.current && referenceRecorderRef.current.state !== 'inactive') {
      referenceRecorderRef.current.stop()
    }
  }

  const downloadReferenceAudio = () => {
    if (!referenceAudioBlob) return
    const sanitizedName = referenceFilename.trim().replace(/[^a-z0-9._-]/gi, '_') || 'openvoice-reference'
    const link = document.createElement('a')
    const url = referenceAudioUrl || URL.createObjectURL(referenceAudioBlob)
    link.href = url
    link.download = `${sanitizedName}.webm`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    if (!referenceAudioUrl) {
      URL.revokeObjectURL(url)
    }
  }

  const stopAllAudio = () => {
    stopSpeech()
    stopAudioPlayback()
  }

  const showAttachmentPreview = (src?: string, name?: string) => {
    if (!src) return
    setAttachmentPreview({ src, name: name || 'Attachment preview' })
  }

  const closeAttachmentPreview = () => setAttachmentPreview(null)

  const scrollChatToBottom = (smooth = false) => {
    const container = chatMessagesRef.current
    if (!container) return
    container.scrollTo({
      top: container.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    })
  }

  useEffect(() => {
    if (!attachmentPreview) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAttachmentPreview()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [attachmentPreview])

  const ensureFileHasName = (file: File) => {
    if (file.name && file.name.trim()) {
      return file
    }

    const extension = file.type && file.type.includes('/') ? file.type.split('/')[1] : 'bin'
    return new File([file], `clipboard-${Date.now()}.${extension || 'bin'}`, {
      type: file.type || 'application/octet-stream'
    })
  }

  const attachmentTypeFor = (file: File): AttachmentType =>
    file.type?.startsWith('image/') ? 'image' : 'file'

  const absoluteServerUrl = (pathFromServer: string) => {
    if (!pathFromServer) return ''
    if (/^https?:\/\//i.test(pathFromServer)) return pathFromServer
    const normalized = pathFromServer.startsWith('/') ? pathFromServer : `/${pathFromServer}`
    if (typeof window === 'undefined') return normalized
    const base = window.location.origin.replace(/\/$/, '')
    return `${base}${normalized}`
  }

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result === 'string') {
          resolve(result)
        } else {
          reject(new Error('Failed to read attachment as data URL'))
        }
      }
      reader.onerror = () => {
        reject(reader.error || new Error('Attachment read error'))
      }
      reader.readAsDataURL(file)
    })

  const revokeAttachmentPreview = (att: PendingAttachment) => {
    if (att.preview && att.preview.startsWith('blob:')) {
      URL.revokeObjectURL(att.preview)
    }
  }

  const queuePendingAttachment = (file: File) => {
    const order = attachmentCounterRef.current++
    const pending: PendingAttachment = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      type: attachmentTypeFor(file),
      preview: file.type?.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      label: '',
      order,
      prompt: '',
      mimetype: file.type,
      size: file.size
    }

    setPendingAttachments((prev) => [...prev, pending])
  }

  const removePendingAttachment = (id: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((att) => att.id === id)
      if (target) {
        revokeAttachmentPreview(target)
      }
      return prev.filter((att) => att.id !== id)
    })
  }

  const updatePendingAttachmentLabel = (id: string, label: string) => {
    setPendingAttachments((prev) =>
      prev.map((att) => (att.id === id ? { ...att, label } : att))
    )
  }

  const renderBankDetectionBoxes = () => {
    if (
      !bankShowDetectionBoxes ||
      !bankDetectionImage ||
      !bankDetectionImageSize ||
      bankDetectionResults.length === 0
    ) {
      return null
    }

    const width = bankDetectionImageSize.width || 1
    const height = bankDetectionImageSize.height || 1

    return (
      <div className="vision-overlay">
        {bankDetectionResults.map((det, idx) => {
          if (!Array.isArray(det.bbox) || det.bbox.length !== 4) return null
          const [rawX1, rawY1, rawX2, rawY2] = det.bbox

          const x1 = Math.max(0, Math.min(rawX1, width))
          const y1 = Math.max(0, Math.min(rawY1, height))
          const x2 = Math.max(x1, Math.min(rawX2, width))
          const y2 = Math.max(y1, Math.min(rawY2, height))

          const boxWidth = Math.max(1, x2 - x1)
          const boxHeight = Math.max(1, y2 - y1)

          const leftPct = (x1 / width) * 100
          const topPct = (y1 / height) * 100
          const widthPct = (boxWidth / width) * 100
          const heightPct = (boxHeight / height) * 100

          const label = det.class_name || (typeof det.class_id === 'number' ? `Class ${det.class_id}` : `Detection ${idx + 1}`)
          const confidence = typeof det.confidence === 'number' ? `${(det.confidence * 100).toFixed(0)}%` : null

          return (
            <div
              key={`${label}-${idx}`}
              className="vision-box"
              style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` }}
            >
              <span className="vision-box-label">
                {label}
                {confidence ? <span className="vision-box-conf">{confidence}</span> : null}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const renderDetectionBoxesAlt = (detections: DetectionResult[] = detectionResultsAlt) => {
    if (!showDetectionBoxesAlt || !detectionImageAlt || !detectionImageSizeAlt || detections.length === 0) {
      return null
    }

    const width = detectionImageSizeAlt.width || 1
    const height = detectionImageSizeAlt.height || 1

    return (
      <div className="vision-overlay">
        {detections.map((det, idx) => {
          if (!Array.isArray(det.bbox) || det.bbox.length !== 4) return null
          const [rawX1, rawY1, rawX2, rawY2] = det.bbox

          const x1 = Math.max(0, Math.min(rawX1, width))
          const y1 = Math.max(0, Math.min(rawY1, height))
          const x2 = Math.max(x1, Math.min(rawX2, width))
          const y2 = Math.max(y1, Math.min(rawY2, height))

          const boxWidth = Math.max(1, x2 - x1)
          const boxHeight = Math.max(1, y2 - y1)

          const leftPct = (x1 / width) * 100
          const topPct = (y1 / height) * 100
          const widthPct = (boxWidth / width) * 100
          const heightPct = (boxHeight / height) * 100

          const label = det.class_name || (typeof det.class_id === 'number' ? `Class ${det.class_id}` : `Detection ${idx + 1}`)
          const confidence = typeof det.confidence === 'number' ? `${(det.confidence * 100).toFixed(0)}%` : null
          const isHovered = hoveredDetectionAlt === idx

          return (
            <div
              key={`${label}-${idx}`}
              className={`vision-box ${isHovered ? 'highlighted' : ''}`.trim()}
              style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` }}
            >
              <span className="vision-box-label">
                {label}
                {confidence ? <span className="vision-box-conf">{confidence}</span> : null}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const updatePendingAttachmentPrompt = (id: string, prompt: string) => {
    setPendingAttachments((prev) =>
      prev.map((att) => (att.id === id ? { ...att, prompt } : att))
    )
  }

  const clearPendingAttachments = () => {
    setPendingAttachments((prev) => {
      prev.forEach((att) => revokeAttachmentPreview(att))
      return []
    })
  }

  const dataUrlToFile = async (dataUrl: string, filename: string) => {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const type = blob.type || 'image/png'
    return new File([blob], filename, { type })
  }

  const handleAttachmentFile = (rawFile: File) => {
    if (uploadingAttachment) {
      alert('Please wait until the current send completes before adding more attachments.')
      return
    }

    const file = ensureFileHasName(rawFile)
    queuePendingAttachment(file)
  }

  const uploadPendingAttachments = async (): Promise<UploadedAttachment[]> => {
    const attachments = [...pendingAttachments]
    if (!attachments.length) return []

    setUploadingAttachment(true)
    const uploaded: UploadedAttachment[] = []
    try {
      for (const att of attachments) {
        const dataUrl = await fileToDataUrl(att.file)
        const formData = new FormData()
        formData.append('file', att.file, att.name || att.file.name)

        const res = await fetch(`${API_BASE}/attachments`, {
          method: 'POST',
          body: formData
        })

        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || 'Upload failed')
        }

        const data = await res.json()
        const attachmentUrl = absoluteServerUrl(data.url || '')

        if (!attachmentUrl) {
          throw new Error('Upload response missing URL')
        }

        uploaded.push({
          type: att.type,
          name: data.originalName || att.name,
          url: attachmentUrl,
          label: att.label,
          order: att.order,
          prompt: att.prompt,
          base64: dataUrl,
          mimetype: att.mimetype || data.mimetype || att.file.type,
          size: typeof att.size === 'number' ? att.size : data.size
        })

        removePendingAttachment(att.id)
      }
      return uploaded
    } finally {
      setUploadingAttachment(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    void handleAttachmentFile(file)

    // Reset input so selecting the same file again still triggers change
    e.target.value = ''
  }

  const handleRedetectPrimary = () => {
    if (detecting || !lastDetectionFile) return
    setDetectionError(null)
    void handleDetectFile(lastDetectionFile)
  }

  const handleRedetectLinked = () => {
    if (detectingAlt || !lastDetectionFileAlt) return
    setDetectionErrorAlt(null)
    void handleDetectFileAlt(lastDetectionFileAlt)
  }

  const handleDetectFile = async (rawFile: File) => {
    const file = ensureFileHasName(rawFile)
    setLastDetectionFile(file)
    const formData = new FormData()
    formData.append('image', file, file.name)
    formData.append('confidence', detectConfidence.toString())

    setDetecting(true)
    setDetectionError(null)

    try {
      const res = await fetch(DETECT_URL, {
        method: 'POST',
        body: formData
      })

      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || 'Detection failed')
      }

      const data = await res.json()
      const imageData = typeof data?.image === 'string' && data.image ? data.image : null
      const detections = Array.isArray(data?.detections) ? (data.detections as DetectionResult[]) : []

      setDetectionImage(imageData)
      setDetectionResults(detections)
    } catch (err: any) {
      console.error('Detection failed', err)
      setDetectionError(err?.message || 'Detection failed')
      setDetectionImage(null)
      setDetectionResults([])
    } finally {
      setDetecting(false)
      if (detectFileInputRef.current) {
        detectFileInputRef.current.value = ''
      }
    }
  }

  const handleDetectFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setDetectionImage(null)
      setDetectionResults([])
      setDetectionError(null)
      setDetectionExpanded(false)
      setShowDetectionBoxes(true)
      setHoveredDetection(null)
      setDetectionPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
      void handleDetectFile(file)
    }
    e.target.value = ''
  }

  const handleDetectFileAlt = async (rawFile: File) => {
    const file = ensureFileHasName(rawFile)
    setLastDetectionFileAlt(file)
    const formData = new FormData()
    formData.append('image', file, file.name)
    formData.append('confidence', detectConfidenceAlt.toString())

    setDetectingAlt(true)
    setDetectionErrorAlt(null)

    try {
      const res = await fetch(DETECT_URL, {
        method: 'POST',
        body: formData
      })

      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || 'Detection failed')
      }

      const data = await res.json()
      const imageData = typeof data?.image === 'string' && data.image ? data.image : null
      const detections = Array.isArray(data?.detections) ? (data.detections as DetectionResult[]) : []

      setDetectionImageAlt(imageData)
      setDetectionResultsAlt(detections)
    } catch (err: any) {
      console.error('Linked detection failed', err)
      setDetectionErrorAlt(err?.message || 'Detection failed')
      setDetectionImageAlt(null)
      setDetectionResultsAlt([])
    } finally {
      setDetectingAlt(false)
      if (detectFileInputRefAlt.current) {
        detectFileInputRefAlt.current.value = ''
      }
    }
  }

  const handleDetectFileChangeAlt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setDetectionImageAlt(null)
      setDetectionResultsAlt([])
      setDetectionErrorAlt(null)
      setDetectionExpandedAlt(false)
      setShowDetectionBoxesAlt(true)
      setHoveredDetectionAlt(null)
      setDetectionPreviewUrlAlt((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
      void handleDetectFileAlt(file)
    }
    e.target.value = ''
  }

  const runBankOcr = useCallback(
    async (file: File, lang: string) => {
      setBankOcrBusy(true)
      setBankOcrError(null)
      try {
        const formData = new FormData()
        formData.append('image', file, file.name)
        formData.append('lang', lang)

        const response = await fetch(OCR_URL, {
          method: 'POST',
          body: formData
        })

        if (!response.ok) {
          const detail = await response.text()
          throw new Error(detail || 'OCR request failed')
        }

        const data = await response.json()
        const normalized: BankOcrResult = {
          text: typeof data?.text === 'string' ? data.text.trim() : '',
          lang: typeof data?.lang === 'string' ? data.lang : lang,
          confidence: typeof data?.confidence === 'number' ? data.confidence : null,
          lines: mapOcrSpans(data?.lines, 'ocr-line'),
          words: mapOcrSpans(data?.words, 'ocr-word')
        }

        setBankOcrResult(normalized)
      } catch (err: any) {
        console.error('runBankOcr failed', err)
        setBankOcrError(err?.message || 'OCR failed')
      } finally {
        setBankOcrBusy(false)
      }
    },
    []
  )

  const handleBankDetectFile = async (rawFile: File) => {
    const file = ensureFileHasName(rawFile)
    const formData = new FormData()
    formData.append('file', file, file.name)

    setBankFieldSource('api')
    setBankDetecting(true)
    setBankDetectionError(null)
    setBankDetectionSourceFile(file)
    setBankOcrResult(null)
    setBankOcrError(null)
    setBankVerificationInfo({})
    setBankFields([])
    setBankDetectionResults([])

    try {
      const res = await fetch(VERIFY_SLIP_URL, {
        method: 'POST',
        body: formData
      })

      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || 'Verification failed')
      }

      const data = (await res.json()) as BankSlipVerificationResponse
      const imageData = typeof data?.image === 'string' && data.image ? data.image : null
      const mappedFields = mapApiFieldsToTransactionFields(data?.fields)

      setBankFields(mappedFields)

      const derivedDetections: DetectionResult[] = mappedFields
        .filter((field) => Array.isArray(field.bbox) && field.bbox.length === 4)
        .map((field, idx) => ({
          bbox: field.bbox as [number, number, number, number],
          class_name: field.label,
          class_id: idx,
          confidence: typeof field.confidence === 'number' ? field.confidence : undefined
        }))

      setBankDetectionResults(derivedDetections)
      setBankDetectionImage(imageData || null)
      setBankDetectionPreviewUrl((prev) => {
        if (imageData && prev && prev.startsWith('blob:')) {
          URL.revokeObjectURL(prev)
        }
        return imageData || prev || null
      })
      setBankVerificationInfo({
        referenceId: data?.verification?.reference_id || null,
        provider: data?.verification?.provider || null,
        status: data?.verification?.status || null
      })
    } catch (err: any) {
      console.error('Bank slip verification failed', err)
      setBankDetectionError(err?.message || 'Verification failed')
      setBankDetectionImage(null)
      setBankDetectionResults([])
      setBankFields([])
      setBankVerificationInfo({})
    } finally {
      setBankDetecting(false)
      if (detectFileInputRefBank.current) {
        detectFileInputRefBank.current.value = ''
      }
    }
  }

  const handleDetectFileChangeBank = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setBankDetectionImage(null)
      setBankDetectionResults([])
      setBankDetectionError(null)
      setBankDetectionExpanded(false)
      setBankShowDetectionBoxes(true)
      setBankDetectionImageSize(null)
      setBankFields([])
      setBankDetectionSourceFile(null)
      setBankOcrResult(null)
      setBankOcrError(null)
      setBankOcrBusy(false)
      setBankVerificationInfo({})
      setBankFieldSource('api')
      setBankDetectionPreviewUrl((prev) => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
      void handleBankDetectFile(file)
    }
    e.target.value = ''
  }

  const handleRedetect = () => {
    if (lastDetectionFile) {
      void handleDetectFile(lastDetectionFile)
    }
  }

  const handlePasteFromClipboard = async () => {
    if (!navigator.clipboard?.read) {
      alert('Clipboard image paste is not supported in this browser')
      return
    }

    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageMime = item.types.find((type) => type.startsWith('image/'))
        if (imageMime) {
          const blob = await item.getType(imageMime)
          const extension = imageMime.split('/')[1] || 'png'
          const file = new File([blob], `clipboard-${Date.now()}.${extension}`, { type: imageMime })
          handleAttachmentFile(file)
          return
        }
      }

      alert('Clipboard does not contain an image to paste.')
    } catch (err) {
      console.error('Clipboard read failed', err)
      alert('Unable to read clipboard contents.')
    }
  }

  const handleTextAreaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = event.clipboardData?.files?.[0]
    if (file) {
      event.preventDefault()
      handleAttachmentFile(file)
    }
  }

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Camera not supported in this browser')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      setCameraStream(stream)
      setShowCamera(true)
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
    } catch (e) {
      console.error(e)
      alert('Could not access camera')
    }
  }

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop())
    }
    setCameraStream(null)
    setShowCamera(false)
  }

  const handleCapture = async () => {
    if (!videoRef.current) return

    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/png')

    try {
      const file = await dataUrlToFile(dataUrl, `camera-${Date.now()}.png`)
      handleAttachmentFile(file)
    } catch (err) {
      console.error('Failed to queue camera capture', err)
      alert('Unable to add camera snapshot.')
    }

    stopCamera()
  }

  const cancelImageStream = useCallback(() => {
    if (imageStreamControllerRef.current) {
      imageStreamControllerRef.current.abort()
      imageStreamControllerRef.current = null
    }
    setImagePreview(null)
  }, [])

  useEffect(() => {
    return () => {
      cancelImageStream()
    }
  }, [cancelImageStream])

  const resetImageForm = () => {
    cancelImageStream()
    setImageBusy(false)
    setImagePrompt('')
    setImageNegativePrompt('')
    setImageGuidance(7)
    setImageSteps(25)
    setImageWidth(512)
    setImageHeight(512)
    setImageSeed('')
    setImageError(null)
  }

  const handleReuseImagePrompt = (result: GeneratedImageResult) => {
    setImagePrompt(result.prompt || '')
    setImageNegativePrompt(result.negative_prompt || '')
    if (typeof result.guidance_scale === 'number') {
      setImageGuidance(clampNumeric(result.guidance_scale, IMAGE_MIN_GUIDANCE, IMAGE_MAX_GUIDANCE))
    }
    if (typeof result.num_inference_steps === 'number') {
      setImageSteps(clampNumeric(result.num_inference_steps, IMAGE_MIN_STEPS, IMAGE_MAX_STEPS))
    }
    if (typeof result.width === 'number') {
      setImageWidth(normalizeImageDimension(result.width))
    }
    if (typeof result.height === 'number') {
      setImageHeight(normalizeImageDimension(result.height))
    }
    if (typeof result.seed === 'number') {
      setImageSeed(String(result.seed))
    }
    setActivePanel('image-mcp')
  }

  const handleDownloadImageResult = (result: GeneratedImageResult) => {
    const safePrompt = safeFilename(result.prompt || 'image', 'image')
    downloadBase64File(result.image_base64, `${safePrompt}-${result.width}x${result.height}.png`)
  }

  const handleGenerateImage = async () => {
    const trimmedPrompt = imagePrompt.trim()
    if (!trimmedPrompt) {
      setImageError('Prompt is required')
      return
    }

    const payload: Record<string, unknown> = {
      prompt: trimmedPrompt,
      guidance_scale: clampNumeric(Number(imageGuidance) || 7, IMAGE_MIN_GUIDANCE, IMAGE_MAX_GUIDANCE),
      num_inference_steps: clampNumeric(Number(imageSteps) || 25, IMAGE_MIN_STEPS, IMAGE_MAX_STEPS),
      width: normalizeImageDimension(Number(imageWidth) || 512),
      height: normalizeImageDimension(Number(imageHeight) || 512),
      accelerator: imageAccelerator
    }

    const negative = imageNegativePrompt.trim()
    if (negative) {
      payload.negative_prompt = negative
    }

    if (imageSeedValue !== null) {
      payload.seed = imageSeedValue
    }

    cancelImageStream()
    setImageBusy(true)
    setImageError(null)
    setImagePreview(null)

    const controller = new AbortController()
    imageStreamControllerRef.current = controller

    try {
      const response = await fetch(GENERATE_IMAGE_STREAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || 'Image MCP unavailable')
      }

      if (!response.body) {
        throw new Error('Streaming not supported in this browser')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = false

      while (true) {
        const { done, value } = await reader.read()
        const chunk = value ?? new Uint8Array()
        buffer += decoder.decode(chunk, { stream: !done })

        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const rawLine = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (rawLine.length === 0) {
            newlineIndex = buffer.indexOf('\n')
            continue
          }

          let event: any
          try {
            event = JSON.parse(rawLine)
          } catch (err) {
            console.warn('Skipping malformed image stream chunk', rawLine)
            newlineIndex = buffer.indexOf('\n')
            continue
          }

          if (event?.type === 'status') {
            setImagePreview((prev) => ({ ...(prev || {}), status: String(event.status || 'starting') }))
            newlineIndex = buffer.indexOf('\n')
            continue
          }

          if (event?.type === 'progress' && typeof event.image_base64 === 'string') {
            setImagePreview({
              image_base64: event.image_base64,
              step: typeof event.step === 'number' ? event.step : null,
              total_steps: typeof event.total_steps === 'number' ? event.total_steps : null,
              status: 'progress'
            })
            newlineIndex = buffer.indexOf('\n')
            continue
          }

          const isCompletePayload =
            event?.type === 'complete' || (!event?.type && typeof event?.image_base64 === 'string' && event.image_base64)

          if (isCompletePayload) {
            const mapped = mapImageResponse(event)
            if (!mapped.image_base64) {
              throw new Error('Image generator returned no pixels')
            }
            setImageResults((prev) => [mapped, ...prev].slice(0, IMAGE_HISTORY_LIMIT))
            setImagePreview(null)
            completed = true
            if (event?.type === 'complete') {
              break
            }
            newlineIndex = buffer.indexOf('\n')
            continue
          }

          if (event?.type === 'error') {
            throw new Error(event.error || 'Image generation failed')
          }

          newlineIndex = buffer.indexOf('\n')
        }

        if (completed || done) {
          break
        }
      }

      if (!completed) {
        throw new Error('Image stream ended before completion')
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return
      }
      console.error('Image generation failed', err)
      setImagePreview(null)
      setImageError(err?.message || 'Image generation failed')
    } finally {
      if (imageStreamControllerRef.current === controller) {
        imageStreamControllerRef.current = null
      }
      setImageBusy(false)
    }
  }

  useEffect(() => {
    if (!detectionImage) {
      setDetectionImageSize(null)
    }
  }, [detectionImage])

  useEffect(() => {
    if (!detectionImageAlt) {
      setDetectionImageSizeAlt(null)
    }
  }, [detectionImageAlt])

  useEffect(() => {
    if (!bankDetectionImage) {
      setBankDetectionImageSize(null)
      setBankFields([])
      setBankOcrResult(null)
      setBankOcrError(null)
      setBankOcrBusy(false)
      setBankVerificationInfo({})
    }
  }, [bankDetectionImage])

  useEffect(() => {
    if (bankFieldSource !== 'yolo') {
      return
    }
    if (!bankDetectionResults.length) {
      setBankFields([])
      return
    }
    const fields = buildTransactionFields(bankDetectionResults, bankDetectionImageSize, bankOcrResult?.words)
    setBankFields(fields)
  }, [bankDetectionResults, bankDetectionImageSize, bankOcrResult, bankFieldSource])

  const filteredLinkedDetections = useMemo(() => {
    if (!secondaryDetectionTargets.length) {
      return detectionResultsAlt
    }
    const normalizedTargets = secondaryDetectionTargets.map((target) => target.toLowerCase())
    return detectionResultsAlt.filter((det) => {
      const label = (det.class_name || '').toLowerCase()
      if (!label) return false
      return normalizedTargets.some((target) => label.includes(target))
    })
  }, [secondaryDetectionTargets, detectionResultsAlt])

  const toggleSecondaryDetectionTarget = (target: string) => {
    setSecondaryDetectionTargets((prev) => {
      if (target === '__all__') {
        return []
      }
      if (prev.includes(target)) {
        return prev.filter((val) => val !== target)
      }
      return [...prev, target]
    })
  }

  const linkedDetectionsHeading = secondaryDetectionTargets.length
    ? `${filteredLinkedDetections.length} / ${detectionResultsAlt.length}`
    : `${detectionResultsAlt.length}`

  const referenceStatus = referenceRecording ? 'recording' : referenceAudioBlob ? 'ready' : 'idle'
  const referenceStatusLabel = referenceRecording ? 'Recording…' : referenceAudioBlob ? 'Ready to use' : 'Idle'
  const referenceDurationLabel = referenceDurationMs ? formatDuration(referenceDurationMs) : '0:00'
  const imageSeedValue = parseSeedValue(imageSeed)
  const imageWidthOptions = IMAGE_DIMENSION_OPTIONS.map((value) => ({ value, label: `${value}px` }))
  const imageHeightOptions = imageWidthOptions

  const imageStatusLabel = useMemo(() => {
    if (imageBusy) {
      if (imagePreview?.step && imagePreview?.total_steps) {
        return `Step ${imagePreview.step}/${imagePreview.total_steps}`
      }
      if (imagePreview?.status) {
        return imagePreview.status.replace(/_/g, ' ')
      }
      return 'Generating…'
    }
    return imageResults.length ? 'Ready' : 'Drafting'
  }, [imageBusy, imagePreview, imageResults.length])

  const imageInsights = useMemo(() => {
    if (!imageResults.length) {
      return {
        total: 0,
        avgDurationLabel: null as string | null,
        lastSize: null as string | null,
        lastAccel: null as string | null,
        lastPrompt: null as string | null
      }
    }

    const durations = imageResults
      .map((result) => (typeof result.duration_ms === 'number' ? result.duration_ms : null))
      .filter((value): value is number => typeof value === 'number' && value > 0)

    const avgDuration = durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null

    const lastResult = imageResults[0]

    return {
      total: imageResults.length,
      avgDurationLabel: avgDuration ? formatImageDuration(avgDuration) : null,
      lastSize:
        typeof lastResult?.width === 'number' && typeof lastResult?.height === 'number'
          ? `${lastResult.width}×${lastResult.height}`
          : null,
      lastAccel: lastResult?.accelerator ? lastResult.accelerator.toUpperCase() : null,
      lastPrompt: lastResult?.prompt ? truncateText(lastResult.prompt, 56) : null
    }
  }, [imageResults])

  const applyImagePreset = useCallback(
    (preset: ImagePromptPreset) => {
      cancelImageStream()
      setImageBusy(false)
      setImageError(null)
      setImagePrompt(preset.prompt || '')
      setImageNegativePrompt(preset.negative || '')
      if (typeof preset.width === 'number') {
        setImageWidth(preset.width)
      }
      if (typeof preset.height === 'number') {
        setImageHeight(preset.height)
      }
      if (typeof preset.guidance === 'number') {
        setImageGuidance(clampNumeric(preset.guidance, IMAGE_MIN_GUIDANCE, IMAGE_MAX_GUIDANCE))
      }
      if (typeof preset.steps === 'number') {
        setImageSteps(clampNumeric(preset.steps, IMAGE_MIN_STEPS, IMAGE_MAX_STEPS))
      }
      if (preset.accelerator) {
        setImageAccelerator(preset.accelerator)
      }
      setImageControlsCollapsed(false)
    },
    [cancelImageStream]
  )

  const hasImageResults = imageResults.length > 0

  useEffect(() => {
    writeToStorage(STORAGE_KEYS.imageAccelerator, imageAccelerator)
  }, [imageAccelerator])

  const selectedVoiceInfo = useMemo(() => {
    if (!selectedVoice) return null
    const availableVoices = visibleVoiceOptions.filter((voice) => voice.tier !== 'premium' || health === 'ok')
    return availableVoices.find((voice) => voice.id === selectedVoice) || null
  }, [selectedVoice, visibleVoiceOptions, health])

  const premiumVoiceNames = useMemo(
    () => visibleVoiceOptions.filter((voice) => (voice.tier || 'standard') === 'premium' && health === 'ok').map((voice) => voice.name),
    [visibleVoiceOptions, health]
  )

  const premiumVoiceSummary = useMemo(() => {
    if (!premiumVoiceNames.length) {
      return null
    }

    if (premiumVoiceNames.length <= 3) {
      return `Premium voices: ${premiumVoiceNames.join(', ')}`
    }

    const count = premiumVoiceNames.length
    return `${count} premium voice${count === 1 ? '' : 's'} available`
  }, [premiumVoiceNames])

  const resolvedBankOcrLangLabel = useMemo(() => {
    const activeLang = bankOcrResult?.lang || bankOcrLang
    const match = BANK_OCR_LANG_OPTIONS.find((option) => option.value === activeLang)
    if (match) return match.label
    return (activeLang || '—').toUpperCase()
  }, [bankOcrResult, bankOcrLang])
  const carwatchDetections = carwatchSnapshot?.detections ?? []
  const carwatchVehicleCount = useMemo(() => {
    if (!carwatchDetections.length) return 0
    return carwatchDetections.reduce((sum: number, det: CarwatchDetectionSummary) => sum + det.count, 0)
  }, [carwatchDetections])
  const carwatchPrimaryDetection = useMemo(() => {
    if (!carwatchDetections.length) return null
    return (
      [...carwatchDetections].sort(
        (a: CarwatchDetectionSummary, b: CarwatchDetectionSummary) => b.count - a.count || b.confidence - a.confidence
      )[0] || null
    )
  }, [carwatchDetections])
  const carwatchLastUpdatedLabel = useMemo(() => {
    if (!carwatchSnapshot?.timestamp) return '—'
    return formatMeetingTimestamp(carwatchSnapshot.timestamp)
  }, [carwatchSnapshot?.timestamp])
  const hasCarwatchSnapshot = Boolean(carwatchSnapshot)

  const llmOptions = useMemo(() => {
    const unique = new Set<string>(builtInLlmModels)
    unique.add(llmModel)
    return Array.from(unique)
  }, [llmModel])

  const statusLabel = useMemo(() => {
    if (health === 'unknown') return 'Checking…'
    if (health === 'ok') return 'Online'
    return 'Offline'
  }, [health])

  const serviceStatuses = useMemo<ServiceStatus[]>(() => {
    if (!healthServices.length) return []
    return healthServices.map((svc) => {
      const meta = serviceMeta[svc.name] || { label: svc.name, group: 'other' as StatusGroupKey, type: 'Service' }
      return {
        name: svc.name,
        label: meta.label,
        status: svc.status || 'unknown',
        detail: svc.detail,
        group: meta.group,
        type: meta.type
      }
    })
  }, [healthServices])

  const groupedServiceStatuses = useMemo(
    () =>
      statusGroupOrder
        .map((groupKey) => ({
          key: groupKey,
          meta: serviceGroupMeta[groupKey],
          services: serviceStatuses.filter((svc) => svc.group === groupKey)
        }))
        .filter((section) => section.services.length > 0),
    [serviceStatuses]
  )

  const stackSummary = useMemo(() => {
    if (!serviceStatuses.length) {
      return { total: 0, ok: 0, unhealthy: 0 }
    }
    const ok = serviceStatuses.filter((svc) => svc.status === 'ok').length
    const unhealthy = serviceStatuses.length - ok
    return {
      total: serviceStatuses.length,
      ok,
      unhealthy
    }
  }, [serviceStatuses])

  const inlineSpeakerMetaFor = (messageId: string): { icon: string; label: string } => {
    if (inlineSpeakerState.messageId !== messageId) {
      return { icon: '🔊', label: 'Replay reply audio' }
    }
    if (inlineSpeakerState.status === 'playing') {
      return { icon: '⏸', label: 'Pause reply audio' }
    }
    if (inlineSpeakerState.status === 'paused') {
      return { icon: '⏹', label: 'Stop reply audio' }
    }
    return { icon: '🔊', label: 'Replay reply audio' }
  }

  const handleSpeakerClick = async (message: ChatMessage) => {
    const trimmed = message.text?.trim()
    if (!trimmed) return

    if (inlineSpeakerState.messageId === message.id) {
      if (inlineSpeakerState.status === 'playing') {
        const paused =
          inlinePlaybackModeRef.current === 'audio' ? pauseAudioPlayback() : pauseSpeechPlayback()
        if (paused) {
          setInlineSpeakerState({ messageId: message.id, status: 'paused' })
          return
        }
      }
      if (inlineSpeakerState.status === 'paused') {
        const resumed =
          inlinePlaybackModeRef.current === 'audio' ? resumeAudioPlayback() : resumeSpeechPlayback()
        if (resumed) {
          setInlineSpeakerState({ messageId: message.id, status: 'playing' })
          return
        }
        stopAllAudio()
      }
    }

    stopAllAudio()

    const effectiveVoiceId = (() => {
      if (selectedVoice && selectedVoice.trim()) return selectedVoice.trim()
      if (selectedVoiceInfo?.id) return selectedVoiceInfo.id
      if (message.voiceId) return message.voiceId
      if (defaultVoiceId) return defaultVoiceId
      return null
    })()

    if (effectiveVoiceId) {
      const ok = await synthesizeInlineVoice(message.id, trimmed, effectiveVoiceId)
      if (ok) {
        return
      }
    }

    speak(trimmed, {
      onStart: () => setInlineSpeakerState({ messageId: message.id, status: 'playing' }),
      onEnd: () =>
        setInlineSpeakerState((prev) =>
          prev.messageId === message.id ? { messageId: null, status: 'idle' } : prev
        ),
      onError: () =>
        setInlineSpeakerState((prev) =>
          prev.messageId === message.id ? { messageId: null, status: 'idle' } : prev
        )
    })
  }

  const handleResetConversation = useCallback(() => {
    stopAllAudio()
    setMessages([])
    setSessionId(null)
    setMeetingSessionId(null)
    setInput('')
  }, [stopAllAudio])

  const handleMenuAction = useCallback(
    (action: QuickMenuAction) => {
      setQuickMenuAnchorEl(null)

      if (action === 'popup') {
        setPopupVisible(true)
        return
      }

      if (action === 'status') {
        setStatusExpanded(true)
        statusWrapperRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        return
      }

      if (action === 'reset') {
        handleResetConversation()
      }
    },
    [handleResetConversation]
  )

  const handleDetectionImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!detectionImage) return
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth && naturalHeight) {
      setDetectionImageSize({ width: naturalWidth, height: naturalHeight })
    }
  }

  const handleDetectionImageLoadAlt = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!detectionImageAlt) return
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth && naturalHeight) {
      setDetectionImageSizeAlt({ width: naturalWidth, height: naturalHeight })
    }
  }

  const handleBankDetectionImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!bankDetectionImage) return
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth && naturalHeight) {
      setBankDetectionImageSize({ width: naturalWidth, height: naturalHeight })
    }
  }

  const renderDetectionBoxes = (detections: DetectionResult[] = detectionResults) => {
    if (!showDetectionBoxes || !detectionImage || !detectionImageSize || detections.length === 0) {
      return null
    }

    const width = detectionImageSize.width || 1
    const height = detectionImageSize.height || 1

    return (
      <div className="vision-overlay">
        {detections.map((det, idx) => {
          if (!Array.isArray(det.bbox) || det.bbox.length !== 4) return null
          const [rawX1, rawY1, rawX2, rawY2] = det.bbox

          const x1 = Math.max(0, Math.min(rawX1, width))
          const y1 = Math.max(0, Math.min(rawY1, height))
          const x2 = Math.max(x1, Math.min(rawX2, width))
          const y2 = Math.max(y1, Math.min(rawY2, height))

          const boxWidth = Math.max(1, x2 - x1)
          const boxHeight = Math.max(1, y2 - y1)

          const leftPct = (x1 / width) * 100
          const topPct = (y1 / height) * 100
          const widthPct = (boxWidth / width) * 100
          const heightPct = (boxHeight / height) * 100

          const label = det.class_name || (typeof det.class_id === 'number' ? `Class ${det.class_id}` : `Detection ${idx + 1}`)
          const confidence = typeof det.confidence === 'number' ? `${(det.confidence * 100).toFixed(0)}%` : null
          const isActive = hoveredDetection === idx && secondaryDetectionTargets.length > 0

          return (
            <div
              key={`${label}-${idx}`}
              className={`vision-box ${isActive ? 'highlighted' : ''}`.trim()}
              style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` }}
            >
              <span className="vision-box-label">
                {label}
                {confidence ? <span className="vision-box-conf">{confidence}</span> : null}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const quickMenuOpen = Boolean(quickMenuAnchorEl)
  const handleQuickMenuToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    setQuickMenuAnchorEl(event.currentTarget)
  }
  const handleQuickMenuClose = () => {
    setQuickMenuAnchorEl(null)
  }
  const handlePanelChange = (_event: React.SyntheticEvent, newValue: PanelTabValue) => {
    if (imageStandaloneMode) return
    setActivePanel(newValue)
  }

  const renderStatusChip = () => {
    const chipColor: ChipProps['color'] = health === 'ok' ? 'success' : health === 'error' ? 'error' : 'warning'
    return (
      <Chip
        icon={<SensorsIcon fontSize="small" />}
        color={chipColor}
        label={statusLabel}
        onClick={() => setStatusExpanded((prev) => !prev)}
        sx={{ fontWeight: 600 }}
        aria-label="Show stack status"
      />
    )
  }

  return (
    <div className={`app-root${imageStandaloneMode ? ' imagen-standalone' : ''}`}>
      {!imageStandaloneMode && (
        <AppBar position="static" color="transparent" elevation={0} sx={{ px: 2, py: 1 }}>
          <Toolbar disableGutters sx={{ justifyContent: 'space-between', gap: 2 }}>
            <Typography variant="h6" component="div">
              Chaba – Voice Chat
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              {renderStatusChip()}
              <Box sx={{ display: 'flex', flexDirection: 'column', textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary">
                  LLM: {llmModel}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  STT: {whisperModel}
                </Typography>
              </Box>
              <IconButton
                color="inherit"
                aria-label="Open quick actions menu"
                onClick={handleQuickMenuToggle}
                size="small"
              >
                <MoreVertIcon />
              </IconButton>
              <Menu
                anchorEl={quickMenuAnchorEl}
                open={quickMenuOpen}
                onClose={handleQuickMenuClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <MenuItem
                  onClick={() => {
                    handleQuickMenuClose()
                    handleMenuAction('popup')
                  }}
                >
                  <Stack spacing={0.5}>
                    <Typography variant="body2">Quick tips panel</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Cheat sheet with usage ideas
                    </Typography>
                  </Stack>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    handleQuickMenuClose()
                    handleMenuAction('status')
                  }}
                >
                  <Stack spacing={0.5}>
                    <Typography variant="body2">View service status</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Open detailed health dialog
                    </Typography>
                  </Stack>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    handleQuickMenuClose()
                    handleMenuAction('reset')
                  }}
                >
                  <Stack spacing={0.5}>
                    <Typography variant="body2">Reset conversation</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Clear local history & session
                    </Typography>
                  </Stack>
                </MenuItem>
              </Menu>
            </Stack>
          </Toolbar>
        </AppBar>
      )}

      <main className={`app-main${imageStandaloneMode ? ' imagen-main' : ''}`}>
        {!imageStandaloneMode && (
          <Tabs
            value={activePanel}
            onChange={handlePanelChange}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            aria-label="Panel navigation"
          >
            {PANEL_TABS.map((tab) => (
              <Tab
                key={tab.value}
                value={tab.value}
                label={tab.label}
                sx={{ textTransform: 'none', fontWeight: 600, minHeight: 0 }}
              />
            ))}
          </Tabs>
        )}

        <div className="app-workspace">
          <div className="panel-content">
        {activePanel === 'chat' ? (
          <div className="chat-layout" aria-label="Chat interface">
            <section className="chat-panel">
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`chat-row chat-row-${m.role === 'user' ? 'right' : 'left'}`}
                  >
                    <div className={`bubble bubble-${m.role}`}>
                      <div className="bubble-text">
                        {m.text}
                        {m.role === 'assistant' && m.text ? (
                          <div className="assistant-inline-actions">
                            {(() => {
                              const { icon, label } = inlineSpeakerMetaFor(m.id)
                              return (
                                <button
                                  type="button"
                                  className="inline-speaker-button"
                                  onClick={() => handleSpeakerClick(m)}
                                  title={label}
                                  aria-label={label}
                                >
                                  {icon}
                                </button>
                              )
                            })()}
                            {mcpProviderNames.length ? (
                              <button
                                type="button"
                                className="mcp-run-button"
                                onClick={() => handleOpenMcpPanel(m)}
                                aria-label="Open MCP tools"
                                title={m.mcpToolRuns?.length ? 'View MCP results' : 'Run MCP tools'}
                              >
                                🧩
                                {m.mcpToolRuns?.length ? <span className="mcp-badge">{m.mcpToolRuns.length}</span> : null}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {m.attachments?.length ? (
                          <div className="chat-attachments">
                            {m.attachments.map((att, idx) =>
                              att.type === 'image' ? (
                                <button
                                  key={att.id || `${att.url}-${idx}`}
                                  type="button"
                                  className="chat-attachment-thumb"
                                  onClick={() => showAttachmentPreview(att.url, att.name)}
                                  aria-label={att.name || `Attachment ${att.order ?? idx + 1}`}
                                >
                                  <img src={att.url} alt={att.name} />
                                </button>
                              ) : (
                                <a
                                  key={att.id || `${att.url}-${idx}`}
                                  href={att.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="chat-attachment-file"
                                >
                                  {att.label?.trim() || att.name}
                                </a>
                              )
                            )}
                          </div>
                        ) : m.attachmentUrl ? (
                          <div className="chat-attachments">
                            {m.attachmentType === 'image' ? (
                              <button
                                type="button"
                                className="chat-attachment-thumb"
                                onClick={() => showAttachmentPreview(m.attachmentUrl, m.attachmentName)}
                                aria-label={m.attachmentName || 'Image attachment'}
                              >
                                <img src={m.attachmentUrl} alt={m.attachmentName || 'Image attachment'} />
                              </button>
                            ) : (
                              <a
                                href={m.attachmentUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="chat-attachment-file"
                              >
                                {m.attachmentName || 'Download attachment'}
                              </a>
                            )}
                          </div>
                        ) : null}
                      </div>
                      <div className="bubble-meta">
                        <span>{m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Chaba' : 'System'}</span>
                        <span>· {m.time}</span>
                        {m.model && <span>· llm: {m.model}</span>}
                        {m.sttModel && <span>· stt: {m.sttModel}</span>}
                        {m.sttLanguage && <span>· lang: {getLanguageLabel(m.sttLanguage)}</span>}
                        {m.accelerator && <span>· accel: {m.accelerator.toUpperCase()}</span>}
                      </div>
                      {m.role === 'user' && (
                        <div className="bubble-actions">
                          <button
                            type="button"
                            className="icon-button"
                            title="Edit message"
                            onClick={() => handleEditMessage(m)}
                            disabled={replying}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title="Resend message"
                            onClick={() => handleResendMessage(m)}
                            disabled={replying}
                          >
                            🔁
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {replying && (
                  <div className="chat-row chat-row-left">
                    <div className="bubble bubble-assistant">
                      <div className="thinking-indicator" aria-live="polite">
                        <span className="thinking-label">Chaba is thinking</span>
                        <span className="thinking-dot" />
                        <span className="thinking-dot" />
                        <span className="thinking-dot" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`chat-scroll-bottom ${showScrollToBottom ? 'visible' : ''}`.trim()}
                onClick={() => scrollChatToBottom(true)}
                aria-label="Scroll to latest message"
                title="Scroll to latest message"
              >
                ↓
              </button>
            </section>

            <section className="controls-panel">
              <div className="control-chips snap-scroll" role="group" aria-label="Chat settings">
                <label className="control-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🌐
                    </span>
                    <span className="chip-label">Speech lang</span>
                    <ChipInfoIcon label="Speech language" message={speechLanguageHelper} />
                  </span>
                  <select
                    value={speechLanguage}
                    onChange={(e) => setSpeechLanguage(e.target.value)}
                    className="chip-select"
                  >
                    {speechLanguageOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {speechLanguage === 'auto' && browserDetectedLanguage ? (
                    <span className="chip-helper" aria-live="polite">
                      Browser detected: {getLanguageLabel(browserDetectedLanguage) || browserDetectedLanguage}
                    </span>
                  ) : null}
                </label>
                <label className="control-chip" htmlFor="llm-provider-select" data-testid="llm-provider-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🧠
                    </span>
                    <span className="chip-label">LLM Provider</span>
                    <ChipInfoIcon label="LLM provider" message={llmProviderHelper} />
                    <button
                      type="button"
                      className="chip-refresh"
                      onClick={() => handleRefreshProviders()}
                      title="Refresh providers"
                      aria-label="Refresh providers"
                    >
                      ↺
                    </button>
                  </span>
                  <select
                    id="llm-provider-select"
                    data-testid="llm-provider-select"
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value as LlmProvider)}
                    className="chip-select"
                  >
                    {llmProviderOptions.map((option) => {
                      const optionStatus = providerHealthStatus[option.value] || 'unknown'
                      return (
                        <option key={option.value} value={option.value} disabled={optionStatus === 'error'}>
                          {option.label}
                        </option>
                      )
                    })}
                  </select>
                </label>
                <label className="control-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🤖
                    </span>
                    <span className="chip-label">LLM</span>
                  </span>
                  <select
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    className="chip-select"
                  >
                    {llmOptions.map((modelValue) => (
                      <option key={modelValue} value={modelValue}>
                        {modelValue}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="control-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🗣️
                    </span>
                    <span className="chip-label">Whisper</span>
                    <ChipInfoIcon label="Whisper" message={whisperHelper} />
                  </span>
                  <select
                    value={whisperModel}
                    onChange={(e) => setWhisperModel(e.target.value)}
                    className="chip-select"
                  >
                    <option value="tiny">tiny</option>
                    <option value="base">base</option>
                    <option value="small">small</option>
                  </select>
                </label>
                <label className="control-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🎙️
                    </span>
                    <span className="chip-label">Voice</span>
                    <ChipInfoIcon label="Voice" message={voiceStatusHelper || undefined} />
                  </span>
                  <span className={`chip-status chip-status-${voiceStatusTone}`} role="status">
                    <span className="chip-status-dot" aria-hidden />
                    {voiceStatusLabel}
                  </span>
                  <div className="voice-control-row">
                    <select
                      value={selectedVoice || ''}
                      onChange={(e) => setSelectedVoice(e.target.value || null)}
                      className="chip-select voice-select"
                      disabled={!visibleVoiceOptions.length || voicesLoading}
                    >
                      {visibleVoiceOptions.length === 0 ? (
                        <option value="">{voicesLoading ? 'Loading voices…' : 'No voices available'}</option>
                      ) : (
                        visibleVoiceOptions.map((voice) => {
                          const parts = [voice.name]
                          if ((voice.tier || 'standard') === 'premium') {
                            parts.push('Premium')
                          }
                          if (voice.sampleRate) {
                            parts.push(`${voice.sampleRate}Hz`)
                          }
                          return (
                            <option key={voice.id} value={voice.id}>
                              {parts.join(' • ')}
                            </option>
                          )
                        })
                      )}
                    </select>
                    <button
                      type="button"
                      className="voice-preview-btn"
                      onClick={() => {
                        void previewVoice()
                      }}
                      disabled={!selectedVoice || voicePreviewLoading}
                    >
                      {voicePreviewLoading ? 'Previewing…' : '▶ Preview'}
                    </button>
                  </div>
                  {(selectedVoiceInfo?.tier === 'premium' || premiumVoiceSummary) && (
                    <div className="voice-helper-row">
                      {selectedVoiceInfo?.tier === 'premium' && (
                        <span className="voice-tier-pill" aria-live="polite">
                          Premium
                        </span>
                      )}
                      {premiumVoiceSummary && (
                        <span className="voice-helper-text">{premiumVoiceSummary}</span>
                      )}
                    </div>
                  )}
                  {voiceFetchError && (
                    <span className="chip-helper" role="alert">
                      {voiceFetchError}
                    </span>
                  )}
                  {voicePreviewError && (
                    <span className="chip-helper" role="alert">
                      {voicePreviewError}
                    </span>
                  )}
                </label>
                <label className="control-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      ⚡
                    </span>
                    <span className="chip-label">Acceleration</span>
                  </span>
                  <select
                    value={acceleratorMode}
                    onChange={(e) => setAcceleratorMode(e.target.value as 'cpu' | 'gpu')}
                    className="chip-select"
                  >
                    <option value="cpu">CPU services</option>
                    <option value="gpu">GPU services</option>
                  </select>
                </label>
                <label className="control-chip">
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🎛️
                    </span>
                    <span className="chip-label">STT source</span>
                  </span>
                  <select
                    value={micMode}
                    onChange={(e) => setMicMode(e.target.value as 'browser' | 'server')}
                    className="chip-select"
                  >
                    <option value="browser">Browser STT</option>
                    <option value="server">Server STT</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={handleResetConversation}
                  className="control-chip action danger-chip"
                  data-tooltip="Clears stored chat history and starts a new session."
                >
                  <span className="chip-header">
                    <span className="chip-icon" aria-hidden>
                      🧹
                    </span>
                    <span className="chip-label">Reset</span>
                  </span>
                </button>
              </div>
              <div className="input-row">
                <textarea
                  ref={textInputRef}
                  className="text-input"
                  rows={3}
                  placeholder="Type a message or use voice controls…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={handleTextAreaPaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSendClick()
                    }
                  }}
                />
              </div>

              {pendingAttachments.length > 0 && (
                <div className="pending-attachments">
                  <div className="pending-header">
                    Pending attachments ({pendingAttachments.length})
                  </div>
                  <div className="pending-list">
                    {pendingAttachments.map((att) => (
                      <div key={att.id} className="pending-item">
                        <div className="pending-thumb">
                          {att.type === 'image' && att.preview ? (
                            <button
                              type="button"
                              className="pending-thumb-button"
                              onClick={() => showAttachmentPreview(att.preview, att.name)}
                            >
                              <img src={att.preview} alt={att.name} />
                            </button>
                          ) : (
                            <div className="pending-file-chip">{att.name}</div>
                          )}
                        </div>
                        <div className="pending-details">
                          <div className="pending-line">
                            <span className="pending-number">Attachment {att.order}</span>
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => removePendingAttachment(att.id)}
                              aria-label={`Remove ${att.name}`}
                            >
                              ✖
                            </button>
                          </div>
                          <div className="pending-file-name">{att.name}</div>
                          <input
                            type="text"
                            className="pending-label-input"
                            value={att.label || ''}
                            onChange={(e) => updatePendingAttachmentLabel(att.id, e.target.value)}
                            placeholder="Label (optional)"
                          />
                          <textarea
                            className="pending-prompt-input"
                            rows={2}
                            value={att.prompt || ''}
                            onChange={(e) => updatePendingAttachmentPrompt(att.id, e.target.value)}
                            placeholder="Prompt / instructions (optional)"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="buttons-row">
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
                <button
                  onClick={() => {
                    fileInputRef.current?.click()
                  }}
                  disabled={replying || uploadingAttachment}
                >
                  📎 Attachment
                </button>
                <button
                  onClick={() => {
                    void handlePasteFromClipboard()
                  }}
                  disabled={replying || uploadingAttachment || !clipboardSupported}
                  title={
                    clipboardSupported
                      ? 'Paste the latest image from your clipboard'
                      : 'Clipboard paste requires a supported browser and secure context'
                  }
                >
                  📋 Paste image
                </button>
                <button onClick={startCamera} disabled={replying}>
                  📷 Camera
                </button>
                <button
                  onClick={() => {
                    if (micMode === 'browser') {
                      if (!replying && !listening) {
                        startListening()
                      }
                    } else if (!replying) {
                      if (recording) {
                        stopRecording()
                      } else {
                        void startRecording()
                      }
                    }
                  }}
                  disabled={replying || (micMode === 'browser' && listening)}
                >
                  {micMode === 'browser'
                    ? listening
                      ? 'Listening…'
                      : '🎙️ Speak'
                    : recording
                      ? '■ Stop (server STT)'
                      : '⏺ Record (server STT)'}
                </button>
                {speechStatusMessage ? (
                  <div className="speech-hint" role="status">
                    {speechStatusMessage}
                  </div>
                ) : null}
                <button onClick={stopAllAudio}>⏹ Stop Audio</button>
              </div>
              {uploadingAttachment && (
                <div className="upload-indicator">
                  <span className="pulse-dot" /> Uploading attachment…
                </div>
              )}
            </section>
          </div>
        ) : activePanel === 'openvoice' ? (
          <div className="openvoice-layout" aria-label="OpenVoice reference panel">
            <section className="panel-surface openvoice-panel">
              <header className="panel-header">
                <div>
                  <h2>OpenVoice reference studio</h2>
                  <p>Capture a short clip (5–15s) of your target voice for cloning & custom voices.</p>
                </div>
                <div className={`reference-status-pill reference-status-pill-${referenceStatus}`} aria-live="polite">
                  {referenceStatusLabel}
                </div>
              </header>
              <div className="openvoice-controls">
                <div className="openvoice-primary">
                  <button
                    type="button"
                    className={`record-button ${referenceRecording ? 'recording' : ''}`}
                    onClick={() => {
                      if (referenceRecording) {
                        stopReferenceRecording()
                      } else {
                        void startReferenceRecording()
                      }
                    }}
                  >
                    {referenceRecording ? '■ Stop recording' : '⏺ Start recording'}
                  </button>
                  <div className="reference-duration" aria-live="polite">
                    Duration:&nbsp;<strong>{referenceDurationLabel}</strong>
                  </div>
                </div>
                <label className="openvoice-field">
                  <span>Filename prefix</span>
                  <input
                    type="text"
                    className="reference-name-input"
                    value={referenceFilename}
                    onChange={(e) => setReferenceFilename(e.target.value)}
                    placeholder="openvoice-reference"
                  />
                </label>
              </div>
              <div className="openvoice-audio-preview">
                {referenceAudioUrl ? (
                  <audio controls src={referenceAudioUrl} className="reference-audio-player" />
                ) : (
                  <p className="reference-empty-hint">No clip yet. Tap “Start recording” to capture a reference.</p>
                )}
              </div>
              <div className="reference-footer">
                <button type="button" onClick={downloadReferenceAudio} disabled={!referenceAudioBlob}>
                  ⬇ Download clip
                </button>
                <button type="button" onClick={clearReferenceAudio} disabled={referenceRecording || !referenceAudioBlob}>
                  ♻ Re-record
                </button>
              </div>
              {referenceRecorderError && (
                <div className="reference-error" role="alert">
                  {referenceRecorderError}
                </div>
              )}
            </section>
          </div>
        ) : activePanel === 'carwatch' ? (
          <div className="vision-panels carwatch-panels" aria-label="CarWatch preview" data-testid="carwatch-panel">
            <section className="vision-panel carwatch-panel">
              <div className="vision-header">
                <div>
                  <h2>CarWatch live monitor</h2>
                  <p>Preview the iOS experience before wiring up the real stream.</p>
                </div>
                <div className={`vision-confidence carwatch-status carwatch-status-${carwatchSnapshot?.connection || 'offline'}`}>
                  <label>
                    Status:{' '}
                    <strong>
                      {hasCarwatchSnapshot
                        ? carwatchSnapshot!.connection === 'online'
                          ? 'Streaming'
                          : carwatchSnapshot!.connection
                        : carwatchError || 'No data'}
                    </strong>
                  </label>
                  <span className="carwatch-meta">
                    {hasCarwatchSnapshot ? `Updated ${carwatchLastUpdatedLabel}` : 'Waiting for snapshot'}
                  </span>
                </div>
                <button
                  type="button"
                  className="chip-refresh"
                  onClick={handleCarwatchRefresh}
                  disabled={carwatchLoading}
                >
                  {carwatchLoading ? 'Refreshing…' : '↺ Refresh'}
                </button>
              </div>

              {hasCarwatchSnapshot ? (
                <div className="carwatch-body">
                  <div className="vision-image" aria-label="Live camera preview">
                    {carwatchSnapshot?.thumbUrl ? (
                      <img src={carwatchSnapshot.thumbUrl} alt="CarWatch live preview" />
                    ) : (
                      <div className="empty-state">Snapshot image unavailable.</div>
                    )}
                    <div className="vision-overlay">
                      <div className="carwatch-overlay-chip">
                        {carwatchSnapshot?.deviceName || 'CarWatch device'} · {carwatchSnapshot?.fps ?? '—'} FPS ·{' '}
                        {carwatchSnapshot?.latencyMs ?? '—'} ms
                      </div>
                      <div className="carwatch-overlay-chip">
                        Battery {carwatchSnapshot?.batteryPercent ?? '—'}% · {carwatchSnapshot?.temperatureC ?? '—'}°C
                      </div>
                    </div>
                  </div>

                  <div className="summary-metrics carwatch-metrics">
                    <div className="summary-metric">
                      <span className="summary-label">Vehicles</span>
                      <span className="summary-value">{carwatchVehicleCount}</span>
                      <span className="summary-sub">
                        {carwatchPrimaryDetection
                          ? `${carwatchPrimaryDetection.count}× ${carwatchPrimaryDetection.label}`
                          : 'No detections'}
                      </span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Top confidence</span>
                      <span className="summary-value">
                        {carwatchPrimaryDetection ? `${Math.round(carwatchPrimaryDetection.confidence * 100)}%` : '—'}
                      </span>
                      <span className="summary-sub">Model: YOLO CoreML</span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Link</span>
                      {carwatchSnapshot?.streamUrl ? (
                        <a className="summary-value link" href={carwatchSnapshot.streamUrl} target="_blank" rel="noreferrer">
                          Open stream ↗
                        </a>
                      ) : (
                        <span className="summary-value">—</span>
                      )}
                      <span className="summary-sub">Latency: {carwatchSnapshot?.latencyMs ?? '—'} ms</span>
                    </div>
                  </div>

                  <div className="carwatch-details">
                    <div className="carwatch-detections">
                      <h3>Detections</h3>
                      {carwatchDetections.length ? (
                        <ul className="detection-list">
                          {carwatchDetections.map((det) => (
                            <li key={det.label} className="detection-item">
                              <div className="det-main">
                                <strong>{det.label}</strong>
                                <span>{det.count} vehicles</span>
                              </div>
                              <span className="det-confidence">{Math.round(det.confidence * 100)}% confidence</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="empty-state">No detections yet.</p>
                      )}
                    </div>

                    <div className="carwatch-events">
                      <h3>Recent events</h3>
                      {carwatchEvents.length ? (
                        <ul className="event-list">
                          {carwatchEvents.map((event) => (
                            <li key={event.id} className="event-item">
                              <div className="event-main">
                                <strong>{event.label}</strong>
                                <span>{formatMeetingTimestamp(event.timestamp)}</span>
                              </div>
                              <p>{event.detail}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="empty-state">No events yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="empty-state carwatch-empty">
                  <p>{carwatchError || 'Waiting for the first CarWatch snapshot.'}</p>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={handleCarwatchRefresh}
                    disabled={carwatchLoading}
                  >
                    {carwatchLoading ? 'Refreshing…' : '↺ Try again'}
                  </button>
                </div>
              )}
            </section>
          </div>
        ) : activePanel === 'meeting' ? (
          <div className="meeting-layout" aria-label="Meeting session overview" data-testid="meeting-panel">
            <section className="meeting-sessions-panel panel-surface" data-testid="meeting-sessions-panel">
              <header className="meeting-panel-header">
                <div>
                  <h2>Sessions</h2>
                  <p>Track live transcripts captured via browser STT.</p>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => refreshMeetingSessions().catch(() => null)}
                  disabled={meetingSessionsLoading}
                  data-testid="meeting-sessions-refresh"
                >
                  {meetingSessionsLoading ? 'Refreshing…' : '↺ Refresh'}
                </button>
              </header>
              <div className="meeting-session-actions">
                <input
                  type="text"
                  className="meeting-input"
                  placeholder="Filter by title / people / tag"
                  value={meetingFilterText}
                  onChange={(e) => setMeetingFilterText(e.target.value)}
                  data-testid="meeting-filter-input"
                />
                <div className="meeting-create-row">
                  <input
                    type="text"
                    className="meeting-input"
                    placeholder="New session title"
                    value={meetingTitleInput}
                    onChange={(e) => setMeetingTitleInput(e.target.value)}
                    data-testid="meeting-title-input"
                  />
                  <button type="button" onClick={() => handleCreateMeetingSession()} data-testid="meeting-start-button">
                    ➕ Start
                  </button>
                </div>
              </div>
              {meetingSessionsError ? (
                <div className="meeting-alert" role="alert" data-testid="meeting-sessions-alert">
                  {meetingSessionsError}
                </div>
              ) : null}
              <div className="meeting-session-list" role="list" data-testid="meeting-session-list">
                {meetingSessionsLoading ? (
                  <div className="meeting-empty">Loading sessions…</div>
                ) : filteredMeetingSessions.length === 0 ? (
                  <div className="meeting-empty">No sessions yet.</div>
                ) : (
                  filteredMeetingSessions.map((session) => {
                    const isActive = session.session_id === activeMeetingSessionId
                    return (
                      <button
                        type="button"
                        key={session.session_id}
                        className={`meeting-session-card ${isActive ? 'active' : ''}`.trim()}
                        onClick={() => handleSelectMeetingSession(session.session_id)}
                        role="listitem"
                        data-testid="meeting-session-card"
                        data-session-id={session.session_id}
                      >
                        <div className="meeting-session-title">{session.title || 'Untitled session'}</div>
                        <div className="meeting-session-sub">{session.participants?.join(', ') || 'Participants TBD'}</div>
                        <div className="meeting-session-meta">
                          <span>{session.entry_count ?? 0} entries</span>
                          <span>{formatMeetingTimestamp(session.updated_at)}</span>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </section>

            <section className="meeting-detail-panel panel-surface" data-testid="meeting-detail-panel">
              <header className="meeting-panel-header">
                <div>
                  <h2>Transcript</h2>
                  <p>{activeMeetingSessionId ? 'Live notes and summaries.' : 'Select a session to inspect notes.'}</p>
                </div>
                <div className="meeting-detail-actions">
                  <button type="button" onClick={() => handleRefreshMeetingDetail()} disabled={!activeMeetingSessionId || meetingDetailLoading}
                    data-testid="meeting-detail-refresh"
                  >
                    {meetingDetailLoading ? 'Refreshing…' : '↺ Refresh detail'}
                  </button>
                  <button
                    type="button"
                    onClick={() => activeMeetingSessionId && summarizeMeeting(activeMeetingSessionId)}
                    disabled={!activeMeetingSessionId || meetingSummaryLoading}
                    data-testid="meeting-summary-button"
                  >
                    {meetingSummaryLoading ? 'Summarizing…' : '📝 Summarize'}
                  </button>
                </div>
              </header>

              {meetingSummaryError ? (
                <div className="meeting-alert" role="alert" data-testid="meeting-summary-alert">
                  {meetingSummaryError}
                </div>
              ) : null}
              {meetingDetailError ? (
                <div className="meeting-alert" role="alert" data-testid="meeting-detail-alert">
                  {meetingDetailError}
                </div>
              ) : null}

              {!activeMeetingSessionId ? (
                <div className="meeting-empty" data-testid="meeting-detail-empty">Select or create a meeting to inspect notes.</div>
              ) : meetingDetailLoading && !meetingSessionDetail ? (
                <div className="meeting-empty" data-testid="meeting-detail-loading">Loading transcript…</div>
              ) : !meetingSessionDetail ? (
                <div className="meeting-empty" data-testid="meeting-detail-missing">No transcript yet.</div>
              ) : (
                <div className="meeting-detail-content" data-testid="meeting-detail">
                  <div className="meeting-detail-meta">
                    <div>
                      <span className="label">Session ID</span>
                      <span className="value mono">{meetingSessionDetail.session_id}</span>
                    </div>
                    <div>
                      <span className="label">Updated</span>
                      <span className="value">{formatMeetingDate(meetingSessionDetail.updated_at)}</span>
                    </div>
                    <div>
                      <span className="label">Language</span>
                      <span className="value">{meetingSessionDetail.language_hint || '—'}</span>
                    </div>
                    <div>
                      <span className="label">Tags</span>
                      <span className="value">{meetingSessionDetail.tags?.join(', ') || '—'}</span>
                    </div>
                  </div>

                  {meetingSessionDetail.summary ? (
                    <article className="meeting-summary-card" data-testid="meeting-summary-card">
                      <header>Latest summary</header>
                      <p>{meetingSessionDetail.summary}</p>
                    </article>
                  ) : null}

                  <div className="meeting-entries" role="list" data-testid="meeting-entries">
                    {meetingSessionDetail.entries && meetingSessionDetail.entries.length > 0 ? (
                      meetingSessionDetail.entries.map((entry, idx) => (
                        <article
                          key={`${entry.created_at || idx}-${idx}`}
                          className="meeting-entry"
                          role="listitem"
                          data-testid="meeting-entry"
                        >
                          <div className="meeting-entry-header">
                            <div className="meeting-entry-speaker">{entry.speaker || 'Speaker'}</div>
                            <div className="meeting-entry-meta">{formatMeetingTimestamp(entry.created_at)}</div>
                          </div>
                          <p>{entry.text}</p>
                          {entry.metadata ? (
                            <div className="meeting-entry-meta-detail">
                              {Object.entries(entry.metadata).map(([key, value]) => (
                                <span key={key}>
                                  {key}: {String(value)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      ))
                    ) : (
                      <div className="meeting-empty" data-testid="meeting-entries-empty">No entries captured yet.</div>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        ) : activePanel === 'image-mcp' ? (
          <div className="image-lab-layout" aria-label="Imagen Studio">
            <section className="panel-surface image-panel">
              <header className="panel-header">
                <div>
                  <h2>Imagen Studio</h2>
                  <p>Create reproducible image prompts with guardrails before sending them to the assistant.</p>
                </div>
                <div className="image-header-actions">
                  <button
                    type="button"
                    className={`pill-button secondary image-tips-toggle ${imageTipsVisible ? 'active' : ''}`.trim()}
                    onClick={() => setImageTipsVisible((prev) => !prev)}
                  >
                    {imageTipsVisible ? 'Hide tips' : 'Best-practice tips'}
                  </button>
                  <div className={`image-status-chip ${imageBusy ? 'busy' : 'ready'}`} aria-live="polite">
                    {imageStatusLabel}
                  </div>
                </div>
              </header>
              {imageTipsVisible && (
                <aside className="image-tips-popup" role="dialog" aria-label="Imagen Studio best practices">
                  <div className="image-best-practices">
                    <div className="image-tips-header">
                      <h3>Best-practice checklist</h3>
                      <button type="button" className="pill-button secondary" onClick={() => setImageTipsVisible(false)}>
                        Close
                      </button>
                    </div>
                    <ol>
                      <li>Describe subject, style, lighting, and camera mood in the main prompt.</li>
                      <li>List undesirable traits in the negative prompt to prevent artifacts.</li>
                      <li>Increase inference steps for detail, but watch duration on CPU hosts.</li>
                      <li>Use seeds to reproduce shots and iterate on improvements.</li>
                      <li>Switch to GPU for faster drafts; keep CPU handy when GPUs are busy.</li>
                      <li>Log the aspect ratio when attaching images back into chat sessions.</li>
                    </ol>
                  </div>
                </aside>
              )}
              <div className="panel-surface image-summary-panel">
                <div className="image-summary-row">
                  {hasImageResults ? (
                    <section className="image-insights" aria-label="Imagen Studio session stats">
                      <div className="image-insight-card">
                        <span className="image-insight-label">Renders</span>
                        <strong className="image-insight-value">{imageInsights.total}</strong>
                        <span className="image-insight-hint">saved this session</span>
                      </div>
                      <div className="image-insight-card">
                        <span className="image-insight-label">Avg duration</span>
                        <strong className="image-insight-value">
                          {imageInsights.avgDurationLabel || '—'}
                        </strong>
                        <span className="image-insight-hint">across completed runs</span>
                      </div>
                      <div className="image-insight-card">
                        <span className="image-insight-label">Last output</span>
                        <strong className="image-insight-value">
                          {imageInsights.lastSize || '—'}
                        </strong>
                        <span className="image-insight-hint">{imageInsights.lastAccel || 'pending'}</span>
                      </div>
                      <div className="image-insight-card">
                        <span className="image-insight-label">Last prompt</span>
                        <p className="image-insight-description">
                          {imageInsights.lastPrompt || 'Generate to capture prompt history.'}
                        </p>
                      </div>
                    </section>
                  ) : (
                    <section className="image-empty-state" aria-live="polite">
                      <div>
                        <h3>Draft your first render</h3>
                        <p>Use the quick presets to auto-fill prompts, dimensions, and guidance.</p>
                      </div>
                      <span className="image-empty-icon" aria-hidden>
                        ✨
                      </span>
                    </section>
                  )}
                  <section className="image-preset-panel" aria-label="Imagen prompt presets">
                    <header>
                      <div>
                        <h3>Quick presets</h3>
                        <p>Tap to populate prompt, negative, and size controls.</p>
                      </div>
                    </header>
                    <div className="image-preset-grid">
                      {IMAGE_PROMPT_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.label}
                          className="image-preset-card"
                          onClick={() => applyImagePreset(preset)}
                          disabled={imageBusy}
                        >
                          <div className="image-preset-header">
                            <span>{preset.label}</span>
                            {preset.accelerator ? (
                              <span className={`image-chip-accent image-chip-accent-${preset.accelerator}`}>
                                {preset.accelerator.toUpperCase()}
                              </span>
                            ) : null}
                          </div>
                          <p>{truncateText(preset.prompt, 88)}</p>
                          <div className="image-preset-meta">
                            {preset.width && preset.height ? (
                              <span>{preset.width}×{preset.height}</span>
                            ) : null}
                            {typeof preset.guidance === 'number' ? (
                              <span>{preset.guidance.toFixed(1)}× guidance</span>
                            ) : null}
                            {typeof preset.steps === 'number' ? <span>{preset.steps} steps</span> : null}
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
              <div className="image-lab-grid">
                <div className="image-results-column">
                  {imagePreview ? (
                    <article className="image-progress-preview" role="status" aria-live="polite">
                      <div className="image-preview">
                        {imagePreview.image_base64 ? (
                          <img src={imagePreview.image_base64} alt="In-progress render" />
                        ) : (
                          <div className="image-placeholder">Preparing preview…</div>
                        )}
                      </div>
                      <footer>
                        <span>
                          {imagePreview.step && imagePreview.total_steps
                            ? `Step ${imagePreview.step}/${imagePreview.total_steps}`
                            : 'Generating…'}
                        </span>
                        <span className={`image-status-chip ${imageBusy ? 'busy' : 'ready'}`}>
                          {imageStatusLabel}
                        </span>
                      </footer>
                    </article>
                  ) : null}
                  <div className="image-history" aria-live="polite">
                    {imageResults.length === 0 ? (
                      <p className="image-placeholder">No renders yet. Craft a prompt and hit “Generate image”.</p>
                    ) : (
                      <div className="image-results-grid" data-testid="image-results">
                        {imageResults.map((result, idx) => (
                          <article className="image-result-card" key={`${result.seed ?? idx}-${result.prompt}-${idx}`}>
                            <div className="image-preview">
                              <img src={result.image_base64} alt={result.prompt || 'Generated image'} />
                            </div>
                            <div className="image-meta">
                              <div>
                                <span>Prompt</span>
                                <p>{result.prompt}</p>
                              </div>
                              {result.negative_prompt ? (
                                <div>
                                  <span>Negative</span>
                                  <p>{result.negative_prompt}</p>
                                </div>
                              ) : null}
                              <div className="image-meta-grid">
                                <span>
                                  Size <strong>{result.width}×{result.height}</strong>
                                </span>
                                <span>
                                  Guidance{' '}
                                  <strong>
                                    {typeof result.guidance_scale === 'number'
                                      ? result.guidance_scale.toFixed(1)
                                      : '—'}
                                  </strong>
                                </span>
                                <span>
                                  Steps <strong>{result.num_inference_steps ?? '—'}</strong>
                                </span>
                                <span>
                                  Seed <strong>{result.seed ?? 'auto'}</strong>
                                </span>
                                {formatImageDuration(result.duration_ms) ? (
                                  <span>
                                    Duration <strong>{formatImageDuration(result.duration_ms)}</strong>
                                  </span>
                                ) : null}
                                {result.accelerator ? (
                                  <span>
                                    Accel <strong>{result.accelerator.toUpperCase()}</strong>
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="image-result-actions">
                              <button type="button" className="pill-button secondary" onClick={() => handleReuseImagePrompt(result)}>
                                Reuse settings
                              </button>
                              <button type="button" className="pill-button" onClick={() => handleDownloadImageResult(result)}>
                                Download PNG
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="image-form" aria-label="Image generation form">
                  <label className="image-field">
                    <span>Prompt *</span>
                    <textarea
                      className="image-textarea"
                      rows={4}
                      value={imagePrompt}
                      onChange={(e) => setImagePrompt(e.target.value)}
                      placeholder="Rain-soaked Bangkok street photography, Leica look, cinematic lighting"
                    />
                  </label>
                  <label className="image-field">
                    <span>Negative prompt</span>
                    <textarea
                      className="image-textarea"
                      rows={2}
                      value={imageNegativePrompt}
                      onChange={(e) => setImageNegativePrompt(e.target.value)}
                      placeholder="blurry, low quality, extra limbs"
                    />
                  </label>
                  <div className="image-controls-panel">
                    <div className="image-controls-header">
                      <span>Controls</span>
                      <button
                        type="button"
                        className="image-controls-toggle"
                        onClick={() => setImageControlsCollapsed((prev) => !prev)}
                        aria-expanded={!imageControlsCollapsed}
                        aria-controls="image-control-grid"
                      >
                        {imageControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
                      </button>
                    </div>
                    {!imageControlsCollapsed && (
                      <div
                        id="image-control-grid"
                        className="control-chips image-chip-grid"
                        role="group"
                        aria-label="Imagen Studio controls"
                      >
                        <label className="control-chip image-chip" htmlFor="guidance-slider">
                          <span className="chip-header">
                            <span className="chip-icon" aria-hidden>
                              🧭
                            </span>
                            <span className="chip-label">Guidance</span>
                          </span>
                          <span className="chip-helper">{Number(imageGuidance).toFixed(1)}× intensity</span>
                          <input
                            id="guidance-slider"
                            type="range"
                            min={IMAGE_MIN_GUIDANCE}
                            max={IMAGE_MAX_GUIDANCE}
                            step={0.5}
                            value={imageGuidance}
                            onChange={(e) => setImageGuidance(Number(e.target.value))}
                          />
                        </label>
                        <label className="control-chip image-chip" htmlFor="step-slider">
                          <span className="chip-header">
                            <span className="chip-icon" aria-hidden>
                              📈
                            </span>
                            <span className="chip-label">Steps</span>
                          </span>
                          <span className="chip-helper">{imageSteps} iterations</span>
                          <input
                            id="step-slider"
                            type="range"
                            min={IMAGE_MIN_STEPS}
                            max={IMAGE_MAX_STEPS}
                            step={1}
                            value={imageSteps}
                            onChange={(e) => setImageSteps(Number(e.target.value))}
                          />
                        </label>
                        <label className="control-chip image-chip">
                          <span className="chip-header">
                            <span className="chip-icon" aria-hidden>
                              ↔️
                            </span>
                            <span className="chip-label">Width</span>
                          </span>
                          <select
                            className="chip-select"
                            value={imageWidth}
                            onChange={(e) => setImageWidth(Number(e.target.value) || 512)}
                          >
                            {imageWidthOptions.map((option) => (
                              <option key={`w-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="control-chip image-chip">
                          <span className="chip-header">
                            <span className="chip-icon" aria-hidden>
                              ↕️
                            </span>
                            <span className="chip-label">Height</span>
                          </span>
                          <select
                            className="chip-select"
                            value={imageHeight}
                            onChange={(e) => setImageHeight(Number(e.target.value) || 512)}
                          >
                            {imageHeightOptions.map((option) => (
                              <option key={`h-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="control-chip image-chip">
                          <span className="chip-header">
                            <span className="chip-icon" aria-hidden>
                              🎲
                            </span>
                            <span className="chip-label">Seed</span>
                          </span>
                          <input
                            className="chip-input"
                            type="text"
                            value={imageSeed}
                            onChange={(e) => setImageSeed(e.target.value)}
                            placeholder="auto"
                            inputMode="numeric"
                          />
                        </label>
                        <label className="control-chip image-chip" htmlFor="image-accelerator-select">
                          <span className="chip-header">
                            <span className="chip-icon" aria-hidden>
                              ⚡
                            </span>
                            <span className="chip-label">Accelerator</span>
                          </span>
                          <select
                            id="image-accelerator-select"
                            className="chip-select"
                            value={imageAccelerator}
                            onChange={(e) => setImageAccelerator(e.target.value as 'cpu' | 'gpu')}
                          >
                            {IMAGE_ACCELERATOR_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </div>
                  {imageError ? (
                    <div className="form-error" role="alert">
                      {imageError}
                    </div>
                  ) : null}
                  <div className="image-actions">
                    <button
                      type="button"
                      className="pill-button primary"
                      onClick={handleGenerateImage}
                      disabled={imageBusy}
                    >
                      {imageBusy ? 'Generating…' : 'Generate image'}
                    </button>
                    <button
                      type="button"
                      className="pill-button secondary"
                      onClick={resetImageForm}
                      disabled={imageBusy}
                    >
                      Reset form
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        ) : activePanel === 'yolo-detection' ? (
          <div className="vision-panels">
            <section className="vision-panel" aria-label="YOLO detection panel" data-testid="yolo-panel-primary">
              <div className="vision-header">
                <div>
                  <h2>YOLO Object Detection</h2>
                  <p>Upload an image and run the MCP-powered YOLOv8n detector.</p>
                </div>
                <div className="vision-confidence">
                  <label htmlFor="confidence-slider">
                    Confidence threshold: <strong>{Math.round(detectConfidence * 100)}%</strong>
                  </label>
                  <input
                    id="confidence-slider"
                    type="range"
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    value={detectConfidence}
                    onChange={(e) => setDetectConfidence(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="vision-controls">
                <input
                  type="file"
                  accept="image/*"
                  ref={detectFileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleDetectFileChange}
                />
                <button onClick={() => detectFileInputRef.current?.click()} disabled={detecting}>
                  {detecting ? 'Detecting…' : 'Upload image for detection'}
                </button>
                <button
                  type="button"
                  onClick={handleRedetectPrimary}
                  disabled={detecting || !lastDetectionFile}
                >
                  Re-run last image
                </button>
                {detecting && (
                  <div className="vision-loading">
                    <span className="pulse-dot" /> Running YOLO detection…
                  </div>
                )}
              </div>

              {detectionError && <div className="vision-error">{detectionError}</div>}

              {detectionImage ? (
                <div className="vision-result">
                  <div className="vision-toggle-row">
                    <button
                      type="button"
                      className="vision-toggle-btn"
                      onClick={() => setShowDetectionBoxes((prev) => !prev)}
                      disabled={!detectionPreviewUrl && !detectionImage}
                    >
                      {showDetectionBoxes ? 'Hide boxes' : 'Show boxes'}
                    </button>
                  </div>
                  <div className={`vision-image ${detectionExpanded ? 'expanded' : ''}`} data-testid="primary-detection-image">
                    <button
                      type="button"
                      className="vision-expand-btn"
                      onClick={() => setDetectionExpanded((prev) => !prev)}
                      aria-label={detectionExpanded ? 'Collapse preview' : 'Expand preview'}
                    >
                      {detectionExpanded ? '⤡' : '⤢'}
                    </button>
                    <img
                      src={showDetectionBoxes && detectionImage ? detectionImage : detectionPreviewUrl || detectionImage}
                      alt="Detection result"
                      onLoad={handleDetectionImageLoad}
                    />
                    {renderDetectionBoxes()}
                  </div>
                  <div className="vision-detections">
                    <h3 data-testid="primary-detection-count">Detections ({detectionResults.length || 0})</h3>
                    {detectionResults.length === 0 && <p>No objects above the threshold.</p>}
                    {detectionResults.length > 0 && (
                      <ul className="detection-list">
                        {detectionResults.map((det, idx) => (
                          <li key={`${det.class_name || det.class_id || 'det'}-${idx}`} className="detection-item">
                            <div className="det-main">
                              <strong>{det.class_name || `Class ${det.class_id ?? '?'}`}</strong>
                              {typeof det.confidence === 'number' && (
                                <span>{(det.confidence * 100).toFixed(1)}%</span>
                              )}
                            </div>
                            {Array.isArray(det.bbox) && det.bbox.length === 4 && (
                              <div className="det-bbox">
                                bbox: {det.bbox.map((n) => Math.round(n)).join(', ')}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : detectionPreviewUrl ? (
                <div className="vision-preview">
                  <div className={`vision-image ${detectionExpanded ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="vision-expand-btn"
                      onClick={() => setDetectionExpanded((prev) => !prev)}
                      aria-label={detectionExpanded ? 'Collapse preview' : 'Expand preview'}
                    >
                      {detectionExpanded ? '⤡' : '⤢'}
                    </button>
                    <img src={detectionPreviewUrl} alt="Selected image preview" />
                  </div>
                  <p className="vision-preview-hint">
                    {detecting ? 'Running detection…' : 'Preview ready. Click "Upload image for detection" to run.'}
                  </p>
                </div>
              ) : (
                <div className="vision-placeholder">Upload an image to preview detections.</div>
              )}
            </section>

            <section
              className="vision-panel vision-panel-alt"
              aria-label="YOLO detection panel with linked highlights"
              data-testid="yolo-panel-linked"
            >
              <div className="vision-header">
                <div>
                  <h2>YOLO Detection (Linked)</h2>
                  <p>Hover detections to highlight boxes in the preview.</p>
                </div>
                <div className="vision-confidence">
                  <label htmlFor="confidence-slider-alt">
                    Confidence threshold: <strong>{Math.round(detectConfidenceAlt * 100)}%</strong>
                  </label>
                  <input
                    id="confidence-slider-alt"
                    type="range"
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    value={detectConfidenceAlt}
                    onChange={(e) => setDetectConfidenceAlt(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="target-chip-section" aria-label="Detection targets">
                <span className="target-chip-label">Focus on:</span>
                <div className="target-chip-row">
                  <button
                    type="button"
                    className={`target-chip ${secondaryDetectionTargets.length === 0 ? 'active' : ''}`.trim()}
                    onClick={() => toggleSecondaryDetectionTarget('__all__')}
                  >
                    All objects
                  </button>
                  {detectionTargetOptions.map((option) => {
                    const isActive = secondaryDetectionTargets.includes(option.value)
                    return (
                      <button
                        type="button"
                        key={option.value}
                        className={`target-chip ${isActive ? 'active' : ''}`.trim()}
                        onClick={() => toggleSecondaryDetectionTarget(option.value)}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="vision-controls">
                <input
                  type="file"
                  accept="image/*"
                  ref={detectFileInputRefAlt}
                  style={{ display: 'none' }}
                  onChange={handleDetectFileChangeAlt}
                />
                <button onClick={() => detectFileInputRefAlt.current?.click()} disabled={detectingAlt}>
                  {detectingAlt ? 'Detecting…' : 'Upload image for detection'}
                </button>
                <button
                  type="button"
                  onClick={handleRedetectLinked}
                  disabled={detectingAlt || !lastDetectionFileAlt}
                >
                  Re-run last image
                </button>
                {detectingAlt && (
                  <div className="vision-loading">
                    <span className="pulse-dot" /> Linking detections…
                  </div>
                )}
              </div>

              {detectionErrorAlt && <div className="vision-error">{detectionErrorAlt}</div>}

              {detectionImageAlt ? (
                <div className="vision-result">
                  <div className="vision-toggle-row">
                    <button
                      type="button"
                      className="vision-toggle-btn"
                      onClick={() => setShowDetectionBoxesAlt((prev) => !prev)}
                      disabled={!detectionPreviewUrlAlt && !detectionImageAlt}
                    >
                      {showDetectionBoxesAlt ? 'Hide boxes' : 'Show boxes'}
                    </button>
                  </div>
                  <div className={`vision-image ${detectionExpandedAlt ? 'expanded' : ''}`} data-testid="linked-detection-image">
                    <button
                      type="button"
                      className="vision-expand-btn"
                      onClick={() => setDetectionExpandedAlt((prev) => !prev)}
                      aria-label={detectionExpandedAlt ? 'Collapse preview' : 'Expand preview'}
                    >
                      {detectionExpandedAlt ? '⤡' : '⤢'}
                    </button>
                    <img
                      src={
                        showDetectionBoxesAlt && detectionImageAlt ? detectionImageAlt : detectionPreviewUrlAlt || detectionImageAlt
                      }
                      alt="Detection result (linked)"
                      onLoad={handleDetectionImageLoadAlt}
                    />
                    {renderDetectionBoxesAlt(filteredLinkedDetections)}
                  </div>
                  <div className="vision-detections">
                    <h3 data-testid="linked-detection-count">Detections ({linkedDetectionsHeading})</h3>
                    {filteredLinkedDetections.length === 0 ? (
                      <p>
                        {secondaryDetectionTargets.length
                          ? 'No detections matched the selected targets.'
                          : 'No objects above the threshold.'}
                      </p>
                    ) : (
                      <ul className="detection-list">
                        {filteredLinkedDetections.map((det, idx) => (
                          <li
                            key={`${det.class_name || det.class_id || 'det'}-${idx}`}
                            className={`detection-item ${hoveredDetectionAlt === idx ? 'hovered' : ''}`.trim()}
                            data-testid="linked-detection-item"
                            onMouseEnter={() => setHoveredDetectionAlt(idx)}
                            onMouseLeave={() => setHoveredDetectionAlt(null)}
                            onFocus={() => setHoveredDetectionAlt(idx)}
                            onBlur={() => setHoveredDetectionAlt(null)}
                            tabIndex={0}
                          >
                            <div className="det-main">
                              <strong>{det.class_name || `Class ${det.class_id ?? '?'}`}</strong>
                              {typeof det.confidence === 'number' && (
                                <span>{(det.confidence * 100).toFixed(1)}%</span>
                              )}
                            </div>
                            {Array.isArray(det.bbox) && det.bbox.length === 4 && (
                              <div className="det-bbox">
                                bbox: {det.bbox.map((n) => Math.round(n)).join(', ')}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : detectionPreviewUrlAlt ? (
                <div className="vision-preview">
                  <div className={`vision-image ${detectionExpandedAlt ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="vision-expand-btn"
                      onClick={() => setDetectionExpandedAlt((prev) => !prev)}
                      aria-label={detectionExpandedAlt ? 'Collapse preview' : 'Expand preview'}
                    >
                      {detectionExpandedAlt ? '⤡' : '⤢'}
                    </button>
                    <img src={detectionPreviewUrlAlt} alt="Selected image preview (linked panel)" />
                  </div>
                  <p className="vision-preview-hint">
                    {detectingAlt ? 'Running detection…' : 'Preview ready. Click "Upload image for detection" to run.'}
                  </p>
                </div>
              ) : (
                <div className="vision-placeholder">Upload an image to preview detections.</div>
              )}
            </section>
          </div>
        ) : (
          <div className="vision-panels bank-panels">
            <section className="vision-panel bank-panel" aria-label="Bank slip vehicle detection panel">
              <div className="vision-header">
                <div>
                  <h2>Bank Slip Vehicle Detection</h2>
                  <p>Upload a slip photo to detect cars, registration plates, and other vehicle cues.</p>
                </div>
                <div className="vision-confidence">
                  <label htmlFor="bank-confidence-slider">
                    Confidence threshold: <strong>{Math.round(bankDetectConfidence * 100)}%</strong>
                  </label>
                  <input
                    id="bank-confidence-slider"
                    type="range"
                    min={0.1}
                    max={0.95}
                    step={0.05}
                    value={bankDetectConfidence}
                    onChange={(e) => setBankDetectConfidence(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="vision-controls">
                <input
                  type="file"
                  accept="image/*"
                  ref={detectFileInputRefBank}
                  style={{ display: 'none' }}
                  onChange={handleDetectFileChangeBank}
                />
                <button onClick={() => detectFileInputRefBank.current?.click()} disabled={bankDetecting}>
                  {bankDetecting ? 'Detecting…' : 'Upload slip image'}
                </button>
                <button
                  type="button"
                  className="vision-toggle-btn"
                  onClick={() => setBankShowDetectionBoxes((prev) => !prev)}
                  disabled={!bankDetectionPreviewUrl && !bankDetectionImage}
                >
                  {bankShowDetectionBoxes ? 'Hide boxes' : 'Show boxes'}
                </button>
                <label className="vision-select-inline">
                  <span>OCR language</span>
                  <select value={bankOcrLang} onChange={(e) => setBankOcrLang(e.target.value)}>
                    {BANK_OCR_LANG_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (!bankDetectionSourceFile) return
                    void runBankOcr(bankDetectionSourceFile, bankOcrLang)
                  }}
                  disabled={!bankDetectionSourceFile || bankOcrBusy}
                >
                  {bankOcrBusy ? 'Running OCR…' : bankOcrResult ? 'Re-run OCR' : 'Run OCR'}
                </button>
                {bankDetecting && (
                  <div className="vision-loading">
                    <span className="pulse-dot" /> Running detection…
                  </div>
                )}
                {bankOcrBusy && !bankDetecting ? (
                  <div className="vision-loading">
                    <span className="pulse-dot" /> Extracting text ({resolvedBankOcrLangLabel})…
                  </div>
                ) : null}
              </div>

              {bankDetectionError && <div className="vision-error">{bankDetectionError}</div>}
              {bankOcrError && <div className="vision-error">{bankOcrError}</div>}

              {bankDetectionImage ? (
                <div className="vision-result">
                  <div className="bank-summary-row">
                    <div className="summary-metric">
                      <span className="summary-label">Extracted fields</span>
                      <span className="summary-value">{bankSummaryFieldCount}</span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Detections</span>
                      <span className="summary-value">{bankDetectionResults.length}</span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Confidence</span>
                      <span className="summary-value">{bankSummaryAvgConfidence}</span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Provider</span>
                      <span className="summary-value">{bankVerificationProviderLabel}</span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Status</span>
                      <span className="summary-value">{bankVerificationStatusLabel}</span>
                    </div>
                    <div className="summary-metric">
                      <span className="summary-label">Reference</span>
                      <span className="summary-value">{bankVerificationReferenceLabel}</span>
                    </div>
                  </div>
                  <div className="bank-ocr-summary" aria-live="polite">
                    <div className="bank-ocr-header">
                      <h3>OCR summary ({resolvedBankOcrLangLabel})</h3>
                      {typeof bankOcrResult?.confidence === 'number' && (
                        <span className="confidence-chip">{bankOcrResult.confidence.toFixed(1)}%</span>
                      )}
                    </div>
                    <div className="bank-ocr-body">
                      {bankOcrResult?.text ? (
                        <pre className="bank-ocr-text">
                          {bankOcrResult.text}
                        </pre>
                      ) : (
                        <p className="bank-ocr-placeholder">
                          {bankOcrBusy
                            ? 'OCR running...'
                            : bankDetectionSourceFile
                              ? 'Run OCR to extract raw text from the slip.'
                              : 'Upload a slip image to enable OCR.'}
                        </p>
                      )}
                      {bankOcrResult?.lines?.length ? (
                        <div className="bank-ocr-lines">
                          <strong>Detected lines ({bankOcrResult.lines.length}):</strong>
                          <ul>
                            {bankOcrResult.lines.slice(0, 8).map((line) => (
                              <li key={line.id}>
                                <span>{line.text || '—'}</span>
                                {typeof line.confidence === 'number' && (
                                  <span className="confidence-chip">{line.confidence.toFixed(1)}%</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className={`vision-image ${bankDetectionExpanded ? 'expanded' : ''}`} data-testid="bank-detection-image">
                    <button
                      type="button"
                      className="vision-expand-btn"
                      onClick={() => setBankDetectionExpanded((prev) => !prev)}
                      aria-label={bankDetectionExpanded ? 'Collapse preview' : 'Expand preview'}
                    >
                      {bankDetectionExpanded ? '⤡' : '⤢'}
                    </button>
                    <img
                      src={
                        bankShowDetectionBoxes && bankDetectionImage
                          ? bankDetectionImage
                          : bankDetectionPreviewUrl || bankDetectionImage
                      }
                      alt="Bank slip detection result"
                      onLoad={handleBankDetectionImageLoad}
                    />
                    {renderBankDetectionBoxes()}
                  </div>

                  <div className="insight-grid">
                    {BANK_FIELD_ORDER.map((fieldType) => {
                      const sortedFields = bankFields
                        .filter((field) => field.type === fieldType)
                        .sort((a, b) => {
                          const confDelta = (b.confidence ?? 0) - (a.confidence ?? 0)
                          if (confDelta !== 0) return confDelta
                          return (b.value?.length ?? 0) - (a.value?.length ?? 0)
                        })
                      const [primaryField, ...alternateFields] = sortedFields
                      const fieldCount = sortedFields.length

                      return (
                        <div className="insight-card" key={`bank-field-${fieldType}`}>
                          <div className="insight-card-header">
                            <div>
                              <h3>{BANK_FIELD_LABELS[fieldType]}</h3>
                              <span className="insight-count">{fieldCount}</span>
                            </div>
                            {primaryField && typeof primaryField.confidence === 'number' ? (
                              <span className="confidence-chip" title="Highest-confidence match">
                                {(primaryField.confidence * 100).toFixed(1)}%
                              </span>
                            ) : null}
                          </div>

                          {!primaryField ? (
                            <p className="insight-empty">No {BANK_FIELD_LABELS[fieldType].toLowerCase()} detected.</p>
                          ) : (
                            <>
                              <div className="insight-primary">
                                <div className="insight-item-header">
                                  <strong>{primaryField.value || primaryField.label || '—'}</strong>
                                </div>
                                {primaryField.label && primaryField.value && primaryField.value !== primaryField.label && (
                                  <div className="insight-detail-row">
                                    <span>Label</span>
                                    <span className="insight-detail-value">{primaryField.label}</span>
                                  </div>
                                )}
                                {primaryField.bbox && primaryField.bbox.length === 4 && (
                                  <div className="insight-detail-row">
                                    <span>bbox</span>
                                    <span className="insight-detail-value">
                                      {primaryField.bbox.map((n) => Math.round(n)).join(', ')}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {alternateFields.length ? (
                                <details className="insight-alt">
                                  <summary>Alternates ({alternateFields.length})</summary>
                                  <ul className="insight-list">
                                    {alternateFields.map((field) => (
                                      <li key={field.id} className="insight-item">
                                        <div className="insight-item-header">
                                          <strong>{field.value || field.label}</strong>
                                          {typeof field.confidence === 'number' && (
                                            <span className="confidence-chip">{(field.confidence * 100).toFixed(1)}%</span>
                                          )}
                                        </div>
                                        {field.label && field.value && field.value !== field.label && (
                                          <div className="insight-detail-row">
                                            <span>Label</span>
                                            <span className="insight-detail-value">{field.label}</span>
                                          </div>
                                        )}
                                        {field.bbox && field.bbox.length === 4 && (
                                          <div className="insight-detail-row">
                                            <span>bbox</span>
                                            <span className="insight-detail-value">
                                              {field.bbox.map((n) => Math.round(n)).join(', ')}
                                            </span>
                                          </div>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : bankDetectionPreviewUrl ? (
                <div className="vision-preview">
                  <div className={`vision-image ${bankDetectionExpanded ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="vision-expand-btn"
                      onClick={() => setBankDetectionExpanded((prev) => !prev)}
                      aria-label={bankDetectionExpanded ? 'Collapse preview' : 'Expand preview'}
                    >
                      {bankDetectionExpanded ? '⤡' : '⤢'}
                    </button>
                    <img src={bankDetectionPreviewUrl} alt="Selected bank slip preview" />
                  </div>
                  <p className="vision-preview-hint">
                    {bankDetecting ? 'Running detection…' : 'Preview ready. Click "Upload slip image" to run the detector.'}
                  </p>
                </div>
              ) : (
                <div className="vision-placeholder">Upload a bank slip image to start detecting vehicles.</div>
              )}
            </section>
          </div>
        )}
          </div>
          {!imageStandaloneMode && (
            <aside
              className={`stack-sidebar ${stackSidebarCollapsed ? 'collapsed' : ''}`}
              aria-label="Stack status sidebar"
            >
              <button
                type="button"
                className="stack-sidebar-toggle"
                onClick={() => setStackSidebarCollapsed((prev) => !prev)}
                aria-expanded={!stackSidebarCollapsed}
              >
                <span className="toggle-icon" aria-hidden="true">
                  {stackSidebarCollapsed ? '▶' : '◀'}
                </span>
                <span className="toggle-label">Stack status</span>
                <span className="stack-summary-count">
                  {stackSummary.ok}/{stackSummary.total}
                </span>
              </button>
              <div className="stack-sidebar-content">
                <div className="stack-summary-counters">
                  <div className="stack-summary-item" aria-label="Healthy services">
                    <span className="label">Healthy</span>
                    <span className="value">{stackSummary.ok}</span>
                  </div>
                  <div className="stack-summary-item" aria-label="Services with issues">
                    <span className="label">Issues</span>
                    <span className="value">{stackSummary.unhealthy}</span>
                  </div>
                </div>
                {serviceStatuses.length ? (
                  <ul className="stack-service-list">
                    {serviceStatuses.map((svc) => {
                      const pillState = svc.status === 'ok' ? 'ok' : svc.status === 'unconfigured' ? 'unknown' : 'error'
                      return (
                        <li key={svc.name} className="stack-service-item">
                          <span className={`status-indicator status-${pillState}`}>
                            <span className="dot" /> {svc.label}
                          </span>
                          <span className="stack-service-meta">{svc.type}</span>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="stack-sidebar-empty">No status data yet.</p>
                )}
              </div>
            </aside>
          )}
        </div>
      </main>

      {!imageStandaloneMode && statusExpanded ? (
        <div
          className="floating-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Service status details"
          onClick={() => setStatusExpanded(false)}
        >
          <div className="floating-card status-popup" onClick={(e) => e.stopPropagation()}>
            <header className="status-popup-header">
              <div>
                <p className="status-popup-eyebrow">Stack health</p>
                <h3>{statusLabel}</h3>
              </div>
              <button
                type="button"
                className="icon-button close-button"
                onClick={() => setStatusExpanded(false)}
                aria-label="Close status panel"
              >
                ✕
              </button>
            </header>
            <div className="status-popup-body">
              <div className="status-details" role="document" aria-label="Service status and model details">
                <div className="status-details-header">Service health</div>
                <div className="status-details-content">
                  {groupedServiceStatuses.length ? (
                    <div className="status-details-groups">
                      {groupedServiceStatuses.map((group) => (
                        <section className="status-group" key={group.key} aria-label={group.meta.title}>
                          <header className="status-group-heading">
                            <span className="status-group-icon" aria-hidden="true">{group.meta.icon}</span>
                            <div className="status-group-text">
                              <div className="status-group-title">{group.meta.title}</div>
                              <div className="status-group-subtitle">{group.meta.subtitle}</div>
                            </div>
                          </header>
                          <div className="status-group-list">
                            {group.services.map((svc) => {
                              const pillState = svc.status === 'ok' ? 'ok' : svc.status === 'unconfigured' ? 'unknown' : 'error'
                              const detailText = formatStatusDetail(svc.detail)
                              const typeClass = `status-type-${svc.type.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
                              return (
                                <div className="status-service-card" key={svc.name}>
                                  <div className="status-service-header">
                                    <span className="status-service-label">{svc.label}</span>
                                    <span className={`status-type-pill ${typeClass}`}>{svc.type}</span>
                                  </div>
                                  <div className="status-service-body">
                                    <span className={`status-indicator status-${pillState}`}>
                                      <span className="dot" /> {svc.status}
                                    </span>
                                    {detailText ? <span className="status-details-meta">{detailText}</span> : null}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="status-empty">No service data yet.</div>
                  )}
                  <div className="status-model-info-section">
                    <div className="status-details-header">Model info</div>
                    <div className="status-model-info-grid">
                      <div className="status-model-info-item">
                        <span className="label">LLM</span>
                        <span className="value">{llmModel}</span>
                      </div>
                      <div className="status-model-info-item">
                        <span className="label">STT</span>
                        <span className="value">{whisperModel}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog
        open={Boolean(attachmentPreview)}
        onClose={closeAttachmentPreview}
        fullWidth
        maxWidth="sm"
        aria-labelledby="attachment-preview-title"
      >
        {attachmentPreview ? (
          <>
            <DialogTitle id="attachment-preview-title" sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" component="span">
                {attachmentPreview.name || 'Attachment preview'}
              </Typography>
              <IconButton onClick={closeAttachmentPreview} aria-label="Close attachment preview" size="small">
                <CloseIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent dividers sx={{ display: 'flex', justifyContent: 'center' }}>
              <Box
                component="img"
                src={attachmentPreview.src}
                alt={attachmentPreview.name || 'Attachment preview'}
                sx={{ maxWidth: '100%', borderRadius: 1, boxShadow: 3 }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={closeAttachmentPreview}>Close</Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>

      {showCamera && (
        <div className="camera-overlay">
          <div className="camera-modal">
            <video ref={videoRef} autoPlay muted style={{ maxWidth: '100%' }} />
            <div className="buttons-row" style={{ marginTop: '0.5rem' }}>
              <button onClick={handleCapture}>Capture</button>
              <button onClick={stopCamera}>Close</button>
            </div>
          </div>
        </div>
      )}
      {mcpPanelOpen && activeMcpMessage ? (
        <div
          className="floating-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="MCP tools panel"
          onClick={closeMcpPanel}
        >
          <div className="floating-card mcp-panel" onClick={(e) => e.stopPropagation()}>
            <header className="modal-header">
              <div>
                <div className="modal-title">MCP tools</div>
                <div className="modal-subtitle">Message at {activeMcpMessage.time}</div>
              </div>
              <button type="button" className="icon-button" onClick={closeMcpPanel} aria-label="Close MCP panel">
                ✕
              </button>
            </header>
            <div className="mcp-panel-content">
              <section>
                <h4>Automatic tool calls</h4>
                {activeMcpMessage.mcpToolRuns?.length ? (
                  <ul className="mcp-run-list">
                    {activeMcpMessage.mcpToolRuns.map((run, idx) => (
                      <li key={`${run.provider}-${run.tool}-${idx}`}>
                        <div className="mcp-run-head">
                          <strong>{run.provider || 'unknown'}</strong>
                          <span>{run.tool || 'tool'}</span>
                          {run.error ? <span className="mcp-run-error">{run.error}</span> : <span className="mcp-run-success">success</span>}
                        </div>
                        {run.args ? (
                          <pre className="mcp-code">{JSON.stringify(run.args, null, 2)}</pre>
                        ) : null}
                        {typeof run.result !== 'undefined' ? (
                          <pre className="mcp-code">{JSON.stringify(run.result, null, 2)}</pre>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mcp-empty">No tool calls were embedded in this reply.</p>
                )}
              </section>
              <section>
                <h4>Manual invocation</h4>
                {mcpProviderNames.length ? (
                  <div className="mcp-form">
                    <label>
                      Provider
                      <select value={mcpManualProvider} onChange={(e) => setMcpManualProvider(e.target.value)}>
                        {mcpProviderNames.map((name) => (
                          <option value={name} key={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Tool
                      <select
                        value={mcpManualTool}
                        onChange={(e) => setMcpManualTool(e.target.value)}
                        disabled={!availableManualTools.length}
                      >
                        {availableManualTools.map((tool) => (
                          <option value={tool} key={tool}>
                            {tool}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Arguments (JSON)
                      <textarea value={mcpManualArgs} onChange={(e) => setMcpManualArgs(e.target.value)} rows={4} />
                    </label>
                    <div className="mcp-form-actions">
                      <button type="button" onClick={handleRunManualTool} disabled={mcpManualLoading}>
                        {mcpManualLoading ? 'Running…' : 'Run tool'}
                      </button>
                      <button type="button" className="secondary" onClick={() => setMcpManualArgs('{}')}>
                        Reset args
                      </button>
                    </div>
                    {mcpManualError ? <div className="mcp-error">{mcpManualError}</div> : null}
                    {typeof mcpManualResult !== 'undefined' && mcpManualResult !== null ? (
                      <pre className="mcp-code">{JSON.stringify(mcpManualResult, null, 2)}</pre>
                    ) : null}
                  </div>
                ) : (
                  <p className="mcp-empty">MCP providers unavailable.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
