/* eslint-disable @typescript-eslint/no-use-before-define */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceCapabilities } from './useDeviceCapabilities'
import type { LocalComputeTaskRequest, LocalComputeTaskResult } from '../types/localCompute'

interface EdgeJobAgentOptions {
  enabled: boolean
  apiBase: string
  capabilities: DeviceCapabilities | null
  localWorkerReady: boolean
  runTask: (task: LocalComputeTaskRequest) => Promise<LocalComputeTaskResult>
}

export interface EdgeJobAgentState {
  enabled: boolean
  workerId: string | null
  registering: boolean
  registered: boolean
  leaseMs: number | null
  heartbeatIntervalMs: number | null
  jobsCompleted: number
  jobsFailed: number
  activeJobId: string | null
  error: string | null
  lastJobId: string | null
  lastJobKind: string | null
  lastJobResult: LocalComputeTaskResult | null
  lastJobErrorDetail: string | null
}

const EDGE_POLL_INTERVAL_MS = 5000
const EDGE_REGISTER_RETRY_MS = 15000
const EDGE_HEARTBEAT_FALLBACK_MS = 45000
const EDGE_WORKER_STORAGE_KEY = 'edge_worker_id'

const createWorkerId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `edge-worker-${crypto.randomUUID()}`
  }
  return `edge-worker-${Math.random().toString(36).slice(2, 10)}`
}

const getStoredWorkerId = () => {
  if (typeof window === 'undefined') return null
  try {
    const existing = window.localStorage.getItem(EDGE_WORKER_STORAGE_KEY)
    if (existing?.trim()) {
      return existing.trim()
    }
    const created = createWorkerId()
    window.localStorage.setItem(EDGE_WORKER_STORAGE_KEY, created)
    return created
  } catch (err) {
    console.warn('Failed to access worker ID storage', err)
    return createWorkerId()
  }
}

export const deriveCapabilityTags = (capabilities: DeviceCapabilities | null) => {
  if (!capabilities) return [] as string[]
  const tags: string[] = []
  if (capabilities.isMobile) {
    tags.push('mobile')
  } else {
    tags.push('desktop')
  }
  if (capabilities.hasWebGPU) {
    tags.push('webgpu')
  }
  if (capabilities.hasWasmSimd) {
    tags.push('wasm-simd')
  }
  if (capabilities.hardwareConcurrency && capabilities.hardwareConcurrency >= 8) {
    tags.push('hc8')
  }
  if (capabilities.deviceMemory && capabilities.deviceMemory >= 8) {
    tags.push('mem8')
  }
  if (capabilities.battery?.charging) {
    tags.push('charging')
  }
  return tags
}

const sanitizeCapabilities = (capabilities: DeviceCapabilities | null) => {
  if (!capabilities) return null
  return {
    hardwareConcurrency: capabilities.hardwareConcurrency ?? null,
    deviceMemory: capabilities.deviceMemory ?? null,
    hasWebGPU: capabilities.hasWebGPU,
    hasWasmSimd: capabilities.hasWasmSimd,
    isMobile: capabilities.isMobile,
    platform: capabilities.platform,
    userAgent: capabilities.userAgent
  }
}

const initialState: EdgeJobAgentState = {
  enabled: false,
  workerId: typeof window === 'undefined' ? null : getStoredWorkerId(),
  registering: false,
  registered: false,
  leaseMs: null,
  heartbeatIntervalMs: null,
  jobsCompleted: 0,
  jobsFailed: 0,
  activeJobId: null,
  error: null,
  lastJobId: null,
  lastJobKind: null,
  lastJobResult: null,
  lastJobErrorDetail: null
}

export const useEdgeJobAgent = ({ enabled, apiBase, capabilities, localWorkerReady, runTask }: EdgeJobAgentOptions) => {
  const [state, setState] = useState<EdgeJobAgentState>(initialState)
  const workerIdRef = useRef<string | null>(state.workerId)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const registerRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      enabled,
      error: enabled ? prev.error : null,
      activeJobId: enabled ? prev.activeJobId : null,
      registered: enabled ? prev.registered : false,
      registering: enabled ? prev.registering : false,
      lastJobId: enabled ? prev.lastJobId : null,
      lastJobKind: enabled ? prev.lastJobKind : null,
      lastJobResult: enabled ? prev.lastJobResult : null,
      lastJobErrorDetail: enabled ? prev.lastJobErrorDetail : null
    }))
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return () => {}
    }

    const workerId = workerIdRef.current || getStoredWorkerId()
    workerIdRef.current = workerId
    setState((prev) => ({ ...prev, workerId }))

    let cancelled = false

    const register = async () => {
      if (cancelled) return
      setState((prev) => ({ ...prev, registering: true, error: null }))
      try {
        const res = await fetch(`${apiBase}/edge-workers/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workerId,
            tags: deriveCapabilityTags(capabilities),
            battery: capabilities?.battery || null,
            capabilities: sanitizeCapabilities(capabilities)
          })
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          throw new Error(detail || 'edge_worker_register_failed')
        }
        const data = await res.json()
        if (cancelled) return
        setState((prev) => ({
          ...prev,
          registering: false,
          registered: true,
          leaseMs: typeof data?.leaseMs === 'number' ? data.leaseMs : prev.leaseMs,
          heartbeatIntervalMs: typeof data?.heartbeatIntervalMs === 'number' ? data.heartbeatIntervalMs : prev.heartbeatIntervalMs,
          error: null
        }))
      } catch (err) {
        if (cancelled) return
        setState((prev) => ({
          ...prev,
          registering: false,
          registered: false,
          error: err instanceof Error ? err.message : 'edge_worker_register_failed'
        }))
        registerRetryRef.current = setTimeout(register, EDGE_REGISTER_RETRY_MS)
      }
    }

    register()

    return () => {
      cancelled = true
      if (registerRetryRef.current) {
        clearTimeout(registerRetryRef.current)
        registerRetryRef.current = null
      }
    }
  }, [enabled, apiBase, capabilities])

  useEffect(() => {
    if (!enabled || !state.registered || !state.workerId) {
      return () => {}
    }

    let cancelled = false
    const intervalMs = state.heartbeatIntervalMs ?? EDGE_HEARTBEAT_FALLBACK_MS

    const sendHeartbeat = async () => {
      try {
        await fetch(`${apiBase}/edge-workers/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workerId: state.workerId,
            tags: deriveCapabilityTags(capabilities),
            battery: capabilities?.battery || null,
            capabilities: sanitizeCapabilities(capabilities),
            activeJobId: state.activeJobId || undefined
          })
        })
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : 'edge_worker_heartbeat_failed'
          }))
        }
      }
    }

    sendHeartbeat()
    const heartbeatId = setInterval(sendHeartbeat, intervalMs)

    return () => {
      cancelled = true
      clearInterval(heartbeatId)
    }
  }, [enabled, state.registered, state.workerId, state.heartbeatIntervalMs, state.activeJobId, apiBase, capabilities])

  const capabilityTags = useMemo(() => deriveCapabilityTags(capabilities), [capabilities])
  const tagsKey = capabilityTags.join(',')

  useEffect(() => {
    if (!enabled || !state.registered || !state.workerId || !localWorkerReady) {
      return () => {}
    }

    let cancelled = false

    const scheduleNext = (delay = EDGE_POLL_INTERVAL_MS) => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
      }
      pollTimerRef.current = setTimeout(runLoop, delay)
    }

    const completeJob = async (
      jobId: string,
      payload: { status: 'completed' | 'error'; result?: unknown; detail?: unknown }
    ) => {
      try {
        await fetch(`${apiBase}/edge-jobs/${jobId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'edge_job_report_failed'
        }))
      }
    }

    const runLoop = async () => {
      if (cancelled || busyRef.current) {
        scheduleNext()
        return
      }
      busyRef.current = true
      try {
        const params = new URLSearchParams({ workerId: state.workerId!, tags: tagsKey })
        const url = `${apiBase}/edge-jobs/next?${params.toString()}`
        const response = await fetch(url)
        if (response.status === 204) {
          return
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail || 'edge_job_fetch_failed')
        }
        const data = await response.json()
        const job = data?.job
        if (!job) {
          return
        }
        setState((prev) => ({ ...prev, activeJobId: job.id, error: null }))
        try {
          const result = await runTask(job.task)
          await completeJob(job.id, { status: 'completed', result })
          setState((prev) => ({
            ...prev,
            jobsCompleted: prev.jobsCompleted + 1,
            activeJobId: null,
            error: null,
            lastJobId: job.id || prev.lastJobId,
            lastJobKind: job.task?.kind || prev.lastJobKind,
            lastJobResult: result,
            lastJobErrorDetail: null
          }))
        } catch (taskErr) {
          const message = taskErr instanceof Error ? taskErr.message : 'edge_job_task_failed'
          await completeJob(job.id, { status: 'error', detail: message })
          setState((prev) => ({
            ...prev,
            jobsFailed: prev.jobsFailed + 1,
            activeJobId: null,
            error: message,
            lastJobId: job.id || prev.lastJobId,
            lastJobKind: job.task?.kind || prev.lastJobKind,
            lastJobResult: null,
            lastJobErrorDetail: message
          }))
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : 'edge_job_loop_failed'
          }))
        }
      } finally {
        busyRef.current = false
        if (!cancelled) {
          scheduleNext()
        }
      }
    }

    scheduleNext(0)

    return () => {
      cancelled = true
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
      busyRef.current = false
    }
  }, [enabled, state.registered, state.workerId, localWorkerReady, apiBase, tagsKey, runTask])

  return state
}
