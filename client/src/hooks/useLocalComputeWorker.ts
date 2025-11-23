import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LocalComputeHostMessage,
  LocalComputeTaskRequest,
  LocalComputeTaskResult,
  LocalComputeWorkerMessage
} from '../types/localCompute'

interface TaskResolver {
  resolve: (value: LocalComputeTaskResult) => void
  reject: (reason?: unknown) => void
}

const createWorker = () =>
  new Worker(new URL('../workers/localCompute.worker.ts', import.meta.url), {
    type: 'module'
  })

export const useLocalComputeWorker = (enabled: boolean) => {
  const workerRef = useRef<Worker | null>(null)
  const resolversRef = useRef<Map<string, TaskResolver>>(new Map())
  const taskCounterRef = useRef(0)
  const supported = typeof window !== 'undefined' && typeof Worker !== 'undefined'

  const [ready, setReady] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !supported) {
      return () => {}
    }

    const worker = createWorker()
    workerRef.current = worker
    setReady(false)
    setLastError(null)

    const handleMessage = (event: MessageEvent<LocalComputeWorkerMessage>) => {
      const message = event.data
      if (!message) return

      if (message.type === 'ready') {
        setReady(true)
        return
      }

      if (message.type === 'result') {
        const resolver = resolversRef.current.get(message.id)
        if (resolver) {
          resolversRef.current.delete(message.id)
          resolver.resolve(message.result)
        }
        return
      }

      if (message.type === 'error') {
        setLastError(message.error)
        if (message.id) {
          const resolver = resolversRef.current.get(message.id)
          if (resolver) {
            resolversRef.current.delete(message.id)
            resolver.reject(new Error(message.error))
          }
        }
        return
      }
    }

    const handleError = (event: ErrorEvent) => {
      setLastError(event.message)
      setReady(false)
    }

    worker.addEventListener('message', handleMessage as EventListener)
    worker.addEventListener('error', handleError)

    const initMessage: LocalComputeHostMessage = { type: 'init', options: { warmup: true } }
    worker.postMessage(initMessage)

    return () => {
      worker.removeEventListener('message', handleMessage as EventListener)
      worker.removeEventListener('error', handleError)
      worker.terminate()
      workerRef.current = null
      setReady(false)
      resolversRef.current.forEach((resolver) => {
        resolver.reject(new Error('Local worker terminated'))
      })
      resolversRef.current.clear()
    }
  }, [enabled, supported])

  const runTask = useCallback(
    (task: LocalComputeTaskRequest) => {
      if (!enabled) {
        return Promise.reject(new Error('Local compute disabled'))
      }
      if (!supported) {
        return Promise.reject(new Error('Web Workers unsupported'))
      }
      if (!ready || !workerRef.current) {
        return Promise.reject(new Error('Local worker not ready'))
      }

      const id = `task_${Date.now()}_${taskCounterRef.current++}`
      const message: LocalComputeHostMessage = { type: 'task', id, task }
      workerRef.current.postMessage(message)

      return new Promise<LocalComputeTaskResult>((resolve, reject) => {
        resolversRef.current.set(id, { resolve, reject })
      })
    },
    [enabled, ready, supported]
  )

  return useMemo(
    () => ({
      supported,
      ready: enabled && ready,
      lastError,
      runTask
    }),
    [enabled, lastError, ready, runTask, supported]
  )
}
