import React, { createContext, useContext } from 'react'
import type { EdgeJobAgentState } from '../hooks/useEdgeJobAgent'

const EdgeJobContext = createContext<EdgeJobAgentState | null>(null)

interface EdgeJobProviderProps {
  value: EdgeJobAgentState
  children: React.ReactNode
}

export const EdgeJobProvider = ({ value, children }: EdgeJobProviderProps) => {
  return <EdgeJobContext.Provider value={value}>{children}</EdgeJobContext.Provider>
}

export const useEdgeJobState = () => {
  const ctx = useContext(EdgeJobContext)
  if (!ctx) {
    throw new Error('useEdgeJobState must be used within an EdgeJobProvider')
  }
  return ctx
}
