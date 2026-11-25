/** A local sidebar row that exists before the native session is ready. It keeps one stable key
 *  from click through preparation so the row can be clicked, retried and then replaced in place. */
export interface PendingChatRow {
  key: string
  directory: string | null
  status: "draft" | "connecting" | "retryable"
  sessionId?: string
}
