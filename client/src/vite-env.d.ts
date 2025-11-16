/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly [key: string]: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

type SpeechRecognitionConstructor = new () => SpeechRecognition

declare global {
  interface SpeechRecognition {
    lang: string
    interimResults: boolean
    continuous: boolean
    start: () => void
    stop: () => void
    onresult?: (event: SpeechRecognitionEvent) => void
    onerror?: (event: Event) => void
    onend?: () => void
  }

  interface SpeechRecognitionEvent {
    readonly results: SpeechRecognitionResultList
  }

  interface SpeechRecognitionResultList {
    readonly length: number
    [index: number]: SpeechRecognitionResult
  }

  interface SpeechRecognitionResult {
    readonly length: number
    [index: number]: SpeechRecognitionAlternative
  }

  interface SpeechRecognitionAlternative {
    readonly transcript: string
  }

  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

export {}
