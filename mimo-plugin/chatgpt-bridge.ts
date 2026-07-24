import type { Plugin } from "@mimo-ai/plugin"

const delivered = new Map<string, number>()
const MAX_DELIVERED_EVENTS = 1000

function rememberDelivered(eventID: string) {
  delivered.set(eventID, Date.now())
  if (delivered.size <= MAX_DELIVERED_EVENTS) return
  const oldest = delivered.keys().next().value
  if (oldest) delivered.delete(oldest)
}

function getData<T>(response: unknown): T {
  if (response && typeof response === "object" && "data" in response) {
    return (response as { data: T }).data
  }
  return response as T
}

function extractAssistantText(messages: unknown[]) {
  const message = [...messages]
    .reverse()
    .find((item: any) => item?.info?.role === "assistant") as any

  if (!message) return null
  const text = Array.isArray(message.parts)
    ? message.parts
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
    : ""

  return {
    messageID: String(message.info?.id || "unknown"),
    text,
  }
}

async function postWithRetry(url: string, token: string, payload: unknown) {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        throw new Error(`Bridge returned HTTP ${response.status}: ${await response.text()}`)
      }
      return
    } catch (error) {
      lastError = error as Error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  throw lastError || new Error("Bridge request failed")
}

export const ChatGPTBridgePlugin: Plugin = async ({ client, directory, worktree }) => {
  const bridgeUrl = process.env.MIMO_BRIDGE_URL || "http://127.0.0.1:8787"
  const bridgeToken = process.env.MIMO_BRIDGE_TOKEN || ""

  return {
    event: async ({ event }: any) => {
      if (event?.type !== "session.status") return
      if (event?.properties?.status?.type !== "idle") return
      if (!bridgeToken) {
        await client.app.log({
          body: {
            service: "mimo-chatgpt-bridge",
            level: "error",
            message: "MIMO_BRIDGE_TOKEN is missing; completion was not forwarded.",
          },
        })
        return
      }

      const sessionID = String(event.properties.sessionID)
      const response = await client.session.messages({ path: { id: sessionID } })
      const messages = getData<unknown[]>(response) || []
      const assistant = extractAssistantText(Array.isArray(messages) ? messages : [])
      if (!assistant) return

      const eventID = `${sessionID}:${assistant.messageID}`
      if (delivered.has(eventID)) return
      rememberDelivered(eventID)

      try {
        await postWithRetry(`${bridgeUrl}/hooks/mimo-completed`, bridgeToken, {
          eventID,
          sessionID,
          assistantMessageID: assistant.messageID,
          assistantText: assistant.text,
          directory,
          worktree,
          completedAt: new Date().toISOString(),
        })
        await client.app.log({
          body: {
            service: "mimo-chatgpt-bridge",
            level: "info",
            message: `Forwarded completion ${eventID}`,
          },
        })
      } catch (error) {
        delivered.delete(eventID)
        await client.app.log({
          body: {
            service: "mimo-chatgpt-bridge",
            level: "error",
            message: `Failed to forward completion: ${(error as Error).message}`,
          },
        })
      }
    },
  }
}
