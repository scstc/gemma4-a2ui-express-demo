import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/** The key and model are server configuration, never browser input. */
export function createDeepSeekServer({
  apiKey = process.env.DEEPSEEK_API_KEY?.trim(),
  model = process.env.DEEPSEEK_MODEL || "deepseek-flash",
  fetch: request = globalThis.fetch,
} = {}) {
  return createServer(async (req, res) => {
    const json = (status, message) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(message));
    };
    if (req.url === "/api/deepseek/config" && req.method === "GET") {
      return json(200, { configured: !!apiKey, model });
    }
    if (req.url !== "/api/deepseek/completions" || req.method !== "POST")
      return json(404, { error: "Not found" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(415, { error: "Expected application/json" });
    if (!apiKey)
      return json(503, { error: "Set DEEPSEEK_API_KEY and restart pnpm api." });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    res.on("close", () => controller.abort());
    try {
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1_000_000)
          return json(413, { error: "Request is too large" });
      }
      let messages;
      try {
        ({ messages } = JSON.parse(body));
      } catch {
        return json(400, { error: "Invalid JSON" });
      }
      if (
        !Array.isArray(messages) ||
        !messages.length ||
        !messages.every(
          (message) =>
            message &&
            ["system", "user", "assistant"].includes(message.role) &&
            typeof message.content === "string",
        )
      )
        return json(400, { error: "Expected text chat messages" });

      const upstream = await request(
        "https://api.deepseek.com/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: messages.map(({ role, content }) => ({ role, content })),
            stream: true,
            max_tokens: 3072,
            temperature: 0,
            thinking: { type: "disabled" },
          }),
          signal: controller.signal,
        },
      );
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return json(upstream.status, {
          error: `DeepSeek returned HTTP ${upstream.status}. Check the server key, model and account availability.`,
        });
      }
      if (
        !upstream.body ||
        !upstream.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await upstream.body?.cancel();
        return json(502, { error: "DeepSeek did not return an event stream" });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else
        json(502, {
          error: "DeepSeek connection failed or timed out. Try again.",
        });
    } finally {
      clearTimeout(timer);
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.API_PORT || 4212);
  createDeepSeekServer().listen(port, "127.0.0.1", () => {
    console.log(`DeepSeek proxy listening on http://127.0.0.1:${port}`);
  });
}
