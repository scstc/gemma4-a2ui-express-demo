import { chatMessages } from "../chat-messages";
import type { LocalModel, ModelAvailability, ModelInfo } from "../local-model";

/** Remote inference through the same-origin proxy; credentials stay server-side. */
export class DeepSeekModel implements LocalModel {
  readonly info: ModelInfo = {
    backend: "deepseek",
    model: "DeepSeek",
    device: "DeepSeek API · remote",
  };
  #system?: string;

  async availability(): Promise<ModelAvailability> {
    return "available";
  }

  async enable(
    system: string,
    signal: AbortSignal,
    progress: (value: number) => void,
  ) {
    this.destroy();
    const response = await fetch("/api/deepseek/config", { signal });
    if (!response.ok)
      throw new Error(
        "DeepSeek proxy is unavailable. Start pnpm api and retry.",
      );
    const config = await response.json();
    signal.throwIfAborted();
    if (!config.configured || typeof config.model !== "string")
      throw new Error("Set DEEPSEEK_API_KEY in .env and restart pnpm api.");
    this.info.model = config.model;
    this.#system = system;
    progress(1);
  }

  async *generate(input: string, system: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#system !== system)
      throw new Error(
        "Enable DeepSeek for the current catalog before generating.",
      );
    const response = await fetch("/api/deepseek/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, ...chatMessages(input)],
      }),
      signal,
    });
    if (!response.ok)
      throw new Error(
        `DeepSeek request failed (HTTP ${response.status}). Check the proxy, server key and account availability.`,
      );
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      throw new Error("DeepSeek did not return an event stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopped = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue; // Keep-alive comments carry no model text.
          if (data === "[DONE]") {
            if (!stopped)
              throw new Error("DeepSeek ended without a completed answer.");
            return;
          }
          const chunk = JSON.parse(data);
          if (chunk.error)
            throw new Error("DeepSeek reported a streaming error.");
          const choice = chunk.choices?.[0];
          const reason = choice?.finish_reason;
          if (reason && reason !== "stop")
            throw new Error(
              `DeepSeek generation stopped: ${reason}. Try a smaller interface.`,
            );
          if (reason === "stop") stopped = true;
          const text = choice?.delta?.content;
          if (typeof text === "string" && text) yield text;
        }
        if (done)
          throw new Error("DeepSeek stream was interrupted. Try again.");
        if (buffer.length > 1_000_000)
          throw new Error("DeepSeek stream event is too large.");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async resetContext(signal: AbortSignal) {
    signal.throwIfAborted();
  }

  destroy() {
    this.#system = undefined;
  }
}
