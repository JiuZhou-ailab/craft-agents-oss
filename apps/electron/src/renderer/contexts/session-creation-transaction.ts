// input: Explicit send acceptance and a server-guarded empty-Session cleanup
// output: Whether the send was accepted; unknown results always retain the Session
// pos: Renderer create-and-send boundary; transport failure is not deletion authority

export type SessionSendResult = 'accepted' | 'rejected' | 'unknown'

export async function commitCreatedSessionSend(
  send: () => SessionSendResult | void | Promise<SessionSendResult | void>,
  rollback: () => Promise<void>,
): Promise<boolean> {
  const result = await send()
  if (result === 'rejected') {
    await rollback()
    return false
  }
  return result === 'accepted'
}
