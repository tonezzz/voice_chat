import React, { useEffect, useMemo, useRef, useState } from 'react'
import './style.css'
import type { DetectionResult, DetectionTestPayload } from './types/yolo'

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3002')
const API_URL = `${API_BASE}/voice-chat`
const API_AUDIO_URL = `${API_BASE}/voice-chat-audio`
const HEALTH_URL = `${API_BASE}/health`
const DETECT_URL = `${API_BASE}/detect-image`

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
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  time: string
  model?: string
  sttModel?: string
  attachmentType?: AttachmentType
  attachmentName?: string
  attachmentUrl?: string
  accelerator?: 'cpu' | 'gpu'
  attachments?: ChatAttachment[]
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

interface PendingAttachment {
  id: string
  file: File
  name: string
  type: AttachmentType
  preview?: string
  label?: string
  order: number
  prompt?: string
}

interface UploadedAttachment {
  id?: string
  type: AttachmentType
  name: string
  url: string
  label?: string
  order?: number
  prompt?: string
}

const builtInLlmModels = ['llama3.2-vision:11b', 'llama3.2:1b', 'llama3.2:3b', 'llama3.1:8b', 'phi3:mini'] as const

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

const defaultModels = {
  llm: builtInLlmModels[0],
  whisper: 'tiny'
}

const STORAGE_KEYS = {
  messages: 'chaba.messages',
  sessionId: 'chaba.sessionId',
  accelerator: 'chaba.accelerator'
}

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
  const [listening, setListening] = useState(false)
  const [recording, setRecording] = useState(false)
  const [health, setHealth] = useState<'unknown' | 'ok' | 'error'>('unknown')
  const [healthInfo, setHealthInfo] = useState<any>(null)
  const [llmModel, setLlmModel] = useState<string>(defaultModels.llm)
  const [whisperModel, setWhisperModel] = useState(defaultModels.whisper)
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
  const [detectConfidence, setDetectConfidence] = useState(0.25)
  const [detecting, setDetecting] = useState(false)
  const [detectionImage, setDetectionImage] = useState<string | null>(null)
  const [detectionPreviewUrl, setDetectionPreviewUrl] = useState<string | null>(null)
  const [detectionExpanded, setDetectionExpanded] = useState(false)
  const [showDetectionBoxes, setShowDetectionBoxes] = useState(true)
  const [detectionResults, setDetectionResults] = useState<DetectionResult[]>([])
  const [detectionImageSize, setDetectionImageSize] = useState<{ width: number; height: number } | null>(null)
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [secondaryDetectionTargets, setSecondaryDetectionTargets] = useState<string[]>(['face'])
  const [detectConfidenceAlt, setDetectConfidenceAlt] = useState(0.3)
  const [detectingAlt, setDetectingAlt] = useState(false)
  const [detectionImageAlt, setDetectionImageAlt] = useState<string | null>(null)
  const [detectionPreviewUrlAlt, setDetectionPreviewUrlAlt] = useState<string | null>(null)
  const [detectionExpandedAlt, setDetectionExpandedAlt] = useState(false)
  const [showDetectionBoxesAlt, setShowDetectionBoxesAlt] = useState(true)
  const [detectionResultsAlt, setDetectionResultsAlt] = useState<DetectionResult[]>([])
  const [hoveredDetectionAlt, setHoveredDetectionAlt] = useState<number | null>(null)
  const [detectionImageSizeAlt, setDetectionImageSizeAlt] = useState<{ width: number; height: number } | null>(null)
  const [detectionErrorAlt, setDetectionErrorAlt] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<'chat' | 'yolo-detection'>('chat')
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return window.localStorage.getItem(STORAGE_KEYS.sessionId)
    } catch (err) {
      console.warn('Failed to read stored sessionId', err)
      return null
    }
  })

  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const [micMode, setMicMode] = useState<'browser' | 'server'>('browser')
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [showCamera, setShowCamera] = useState(false)
  const [attachmentPreview, setAttachmentPreview] = useState<{ src: string; name: string } | null>(
    null
  )
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const detectFileInputRef = useRef<HTMLInputElement | null>(null)
  const detectFileInputRefAlt = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)

  const pendingPreviewRef = useRef<PendingAttachment[]>([])
  const attachmentCounterRef = useRef(1)

  useEffect(() => {
    pendingPreviewRef.current = pendingAttachments
  }, [pendingAttachments])

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
    setHoveredDetectionAlt(null)
  }, [detectionResultsAlt])

  useEffect(() => {
    setHoveredDetectionAlt(null)
  }, [secondaryDetectionTargets])

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
    }
  }

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return
    stopSpeech()
    const utter = new SpeechSynthesisUtterance(text)
    window.speechSynthesis.speak(utter)
  }

  const stopAudioPlayback = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      audioPlayerRef.current.src = ''
      audioPlayerRef.current = null
    }
  }

  const playResponseAudio = (audioPath?: string) => {
    if (!audioPath) return false
    const absolute = absoluteServerUrl(audioPath)
    if (!absolute) return false

    try {
      stopAudioPlayback()
      const player = new Audio(absolute)
      audioPlayerRef.current = player
      void player.play().catch((err) => {
        console.error('Audio playback failed', err)
      })
      return true
    } catch (err) {
      console.error('Audio playback setup failed', err)
      return false
    }
  }

  const addMessage = (msg: Omit<ChatMessage, 'id' | 'time'>) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${prev.length}`,
        time: nowString(),
        ...msg
      }
    ])
  }

  const fetchHealth = async () => {
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
  }

  useEffect(() => {
    fetchHealth()
  }, [])

  useEffect(() => {
    setClipboardSupported(typeof navigator !== 'undefined' && !!navigator.clipboard?.read)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEYS.accelerator, acceleratorMode)
    } catch (err) {
      console.error('Failed to persist acceleratorMode', err)
    }
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
      lines.push(`- ${name}: ${att.url}`)
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
    opts?: { accelerator?: 'cpu' | 'gpu'; attachments?: UploadedAttachment[] }
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
      attachments: attachmentsWithIds,
      attachmentType: firstAttachment?.type,
      attachmentName: firstAttachment?.name,
      attachmentUrl: firstAttachment?.url
    })
    setInput('')
    setReplying(true)

    try {
      const makeRequest = async (acc: 'cpu' | 'gpu') => {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: contentForServer,
            model: llmModel,
            accelerator: acc,
            sessionId,
            history: historyPayload
          })
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
      addMessage({ role: 'assistant', text: reply, model: llmModel, accelerator: acceleratorUsed })
      if (reply) {
        const played = playResponseAudio(data.audioUrl)
        if (!played) {
          speak(reply)
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

  const startListening = () => {
    if (!SpeechRecognitionImpl) {
      alert('SpeechRecognition not supported in this browser')
      return
    }

    stopSpeech()

    const Recog = SpeechRecognitionImpl
    const recognition = new Recog()
    recognition.lang = 'en-US' // change to 'th-TH' if you prefer
    recognition.interimResults = true
    recognition.continuous = false

    setListening(true)

    let finalText = ''

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript
      }
      finalText = text
    }

    recognition.onerror = (event) => {
      console.error(event)
      setListening(false)
    }

    recognition.onend = () => {
      setListening(false)
      if (finalText.trim()) {
        setInput(finalText)
        void sendMessage(finalText)
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
          accelerator: acceleratorUsed
        })
      }

      if (data.reply) {
        addMessage({
          role: 'assistant',
          text: data.reply,
          model: llmModel,
          sttModel: usedWhisperModel,
          accelerator: acceleratorUsed
        })
        const played = playResponseAudio(data.audioUrl)
        if (!played) {
          speak(data.reply)
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

  const stopAllAudio = () => {
    stopSpeech()
    stopAudioPlayback()
  }

  const showAttachmentPreview = (src?: string, name?: string) => {
    if (!src) return
    setAttachmentPreview({ src, name: name || 'Attachment preview' })
  }

  const closeAttachmentPreview = () => setAttachmentPreview(null)

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
    return `${API_BASE}${normalized}`
  }

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
      prompt: ''
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
          prompt: att.prompt
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

  const handleDetectFile = async (rawFile: File) => {
    const file = ensureFileHasName(rawFile)
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
      console.error('Detection failed', err)
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

  const handleSpeakerClick = (text: string) => {
    if (!text?.trim()) return
    speak(text)
  }

  const handleResetConversation = () => {
    stopAllAudio()
    setMessages([])
    setSessionId(null)
    setInput('')
  }

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

  const renderDetectionBoxes = () => {
    if (!showDetectionBoxes || !detectionImage || !detectionImageSize || detectionResults.length === 0) {
      return null
    }

    const width = detectionImageSize.width || 1
    const height = detectionImageSize.height || 1

    return (
      <div className="vision-overlay">
        {detectionResults.map((det, idx) => {
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

  const renderDetectionBoxesAlt = (detections: DetectionResult[]) => {
    if (
      !showDetectionBoxesAlt ||
      !detectionImageAlt ||
      !detectionImageSizeAlt ||
      detections.length === 0
    ) {
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
          const isActive = hoveredDetectionAlt === idx

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

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="title">Chaba – Voice Chat</div>
        <div className={`status-pill status-${health}`}>
          <span className="dot" /> {statusLabel}
        </div>
        <div className="model-info">
          LLM: {llmModel} | STT: {whisperModel}
        </div>
      </header>

      <main className="app-main">
        <div className="panel-tabs">
          <button
            type="button"
            className={`panel-tab ${activePanel === 'chat' ? 'active' : ''}`}
            onClick={() => setActivePanel('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={`panel-tab ${activePanel === 'yolo-detection' ? 'active' : ''}`}
            onClick={() => setActivePanel('yolo-detection')}
          >
            YOLO detection
          </button>
        </div>

        {activePanel === 'chat' ? (
          <div className="chat-layout" aria-label="Chat interface">
            <section className="chat-panel">
              <div className="chat-messages">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`chat-row chat-row-${m.role === 'user' ? 'right' : 'left'}`}
                  >
                    <div className={`bubble bubble-${m.role}`}>
                      <div className="bubble-text">
                        {m.text}
                        {m.role === 'assistant' && m.text && (
                          <button
                            type="button"
                            className="inline-speaker-button"
                            onClick={() => handleSpeakerClick(m.text)}
                            title="Replay reply audio"
                            aria-label="Replay reply audio"
                          >
                            🔊
                          </button>
                        )}
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
            </section>

            <section className="controls-panel">
              <div className="control-chips snap-scroll" role="group" aria-label="Chat settings">
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
                <button onClick={stopAllAudio}>⏹ Stop Audio</button>
              </div>
              {uploadingAttachment && (
                <div className="upload-indicator">
                  <span className="pulse-dot" /> Uploading attachment…
                </div>
              )}
            </section>
          </div>
        ) : (
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
        )}
      </main>

      {attachmentPreview && (
        <div className="attachment-preview-overlay" onClick={closeAttachmentPreview}>
          <div className="attachment-preview-modal" onClick={(e) => e.stopPropagation()}>
            <img src={attachmentPreview.src} alt={attachmentPreview.name || 'Attachment preview'} />
            <div className="attachment-preview-name">{attachmentPreview.name}</div>
            <button type="button" onClick={closeAttachmentPreview}>
              Close
            </button>
          </div>
        </div>
      )}

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
    </div>
  )
}

export default App
