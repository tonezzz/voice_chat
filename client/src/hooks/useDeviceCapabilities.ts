import { useEffect, useState } from 'react'

export interface DeviceCapabilities {
  hardwareConcurrency: number | null
  deviceMemory: number | null
  platform: string | null
  userAgent: string | null
  hasWebGPU: boolean
  hasWasmSimd: boolean
  isMobile: boolean
  battery?: {
    charging: boolean
    level: number | null
  }
  detectedAt: number
}

const wasmSimdProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 65, 0, 253, 15, 11
])

const detectWasmSimd = () => {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return false
  }
  try {
    return WebAssembly.validate(wasmSimdProbe)
  } catch (err) {
    console.warn('WASM SIMD probe failed', err)
    return false
  }
}

const detectWebGPU = () => typeof navigator !== 'undefined' && typeof (navigator as any).gpu === 'object'

const isProbablyMobile = () => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua)
}

export const useDeviceCapabilities = () => {
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      setCapabilities(null)
      setLoading(false)
      return
    }

    let cancelled = false

    const collect = async () => {
      try {
        const nav = navigator as Navigator & { deviceMemory?: number; getBattery?: () => Promise<any> }
        const battery = typeof nav.getBattery === 'function' ? await nav.getBattery().catch(() => null) : null
        if (cancelled) return
        const now = Date.now()
        setCapabilities({
          hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
          deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
          platform: navigator.platform || null,
          userAgent: navigator.userAgent || null,
          hasWebGPU: detectWebGPU(),
          hasWasmSimd: detectWasmSimd(),
          isMobile: isProbablyMobile(),
          battery: battery
            ? {
                charging: Boolean(battery.charging),
                level: typeof battery.level === 'number' ? battery.level : null
              }
            : undefined,
          detectedAt: now
        })
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void collect()

    return () => {
      cancelled = true
    }
  }, [])

  return { capabilities, loading }
}
