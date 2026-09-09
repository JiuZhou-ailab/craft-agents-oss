export function appendUniqueRequestById<T extends { requestId: string }>(queue: T[], request: T): T[] {
  if (queue.some(item => item.requestId === request.requestId)) return queue
  return [...queue, request]
}

export function appendUniqueRequestForSession<T extends { requestId: string }>(
  queues: Map<string, T[]>,
  sessionId: string,
  request: T
): Map<string, T[]> {
  const queue = queues.get(sessionId) ?? []
  const nextQueue = appendUniqueRequestById(queue, request)
  if (nextQueue === queue) return queues

  const next = new Map(queues)
  next.set(sessionId, nextQueue)
  return next
}

export function removeFirstRequestForSession<T>(queues: Map<string, T[]>, sessionId: string): Map<string, T[]> {
  const queue = queues.get(sessionId) ?? []
  if (queue.length === 0) return queues

  const next = new Map(queues)
  const remainingQueue = queue.slice(1)
  if (remainingQueue.length === 0) {
    next.delete(sessionId)
  } else {
    next.set(sessionId, remainingQueue)
  }
  return next
}

export function removeRequestForSession<T extends { requestId: string }>(
  queues: Map<string, T[]>, sessionId: string, requestId: string,
): Map<string, T[]> {
  const queue = queues.get(sessionId)
  if (!queue?.some(request => request.requestId === requestId)) return queues
  const next = new Map(queues)
  const remaining = queue.filter(request => request.requestId !== requestId)
  if (remaining.length) next.set(sessionId, remaining)
  else next.delete(sessionId)
  return next
}
