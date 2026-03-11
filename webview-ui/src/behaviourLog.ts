/** Shared behaviour log — captures agent activity events for display in the log panel */

export interface BehaviourEntry {
  timestamp: number
  agentId: number
  agentName: string
  message: string
  type: 'tool' | 'status' | 'idle' | 'info'
}

const MAX_ENTRIES = 200
const entries: BehaviourEntry[] = []
const listeners: Set<() => void> = new Set()

export function addBehaviourEntry(entry: Omit<BehaviourEntry, 'timestamp'>): void {
  entries.push({ ...entry, timestamp: Date.now() })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  for (const listener of listeners) listener()
}

export function getBehaviourEntries(): readonly BehaviourEntry[] {
  return entries
}

export function clearBehaviourLog(): void {
  entries.length = 0
  for (const listener of listeners) listener()
}

export function subscribeBehaviourLog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
