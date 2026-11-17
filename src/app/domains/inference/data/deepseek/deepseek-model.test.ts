import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekModel } from "./deepseek-model";

const signal = () => new AbortController().signal;
const frame = (content: string, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\r\n\r\n`;

async function collect(
  model: DeepSeekModel,
  input = "Make a card",
  abort = signal(),
) {
  let text = "";
  for await (const chunk of model.generate(input, "SDK catalog", abort))
    text += chunk;
  return text;
}

function fixture() {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ configured: true, model: "deepseek-flash" }),
    );
  vi.stubGlobal("fetch", request);
  const model = new DeepSeekModel();
  return { request, model };
}

function stream(source: string) {
  const bytes = new TextEncoder().encode(source);
  // Split every UTF-8 sequence and SSE delimiter across transport chunks.
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek remote inference", () => {
  it("preserves the catalog, history and action data without sending credentials", async () => {
    const { request, model } = fixture();
    await model.enable("SDK catalog", signal(), () => {});
    request.mockResolvedValueOnce(
      stream(
        ": keepalive\r\n\r\n" +
          frame("你好") +
          frame("", "stop") +
          "data: [DONE]\r\n\r\n",
      ),
    );
    const input = JSON.stringify({
      conversation: [
        { role: "user", content: "Create" },
        { role: "assistant", content: "Card" },
        { role: "user", content: "Edit" },
      ],
      values: { name: "Simple" },
    });
    expect(await collect(model, input)).toBe("你好");
    const [url, options] = request.mock.calls[1];
    expect(url).toBe("/api/deepseek/completions");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(options.body).messages).toEqual([
      { role: "system", content: "SDK catalog" },
      { role: "user", content: "Create" },
      { role: "assistant", content: "Card" },
      { role: "user", content: expect.stringContaining('"name":"Simple"') },
    ]);
    expect(model.info.model).toBe("deepseek-flash");
    await model.resetContext(signal());
    model.destroy();
    await expect(collect(model)).rejects.toThrow("Enable DeepSeek");
  });

  it.each([
    [frame("partial"), "interrupted"],
    [frame("partial", "length") + "data: [DONE]\r\n\r\n", "length"],
    ["data: [DONE]\r\n\r\n", "without a completed answer"],
    ['data: {"error":{"message":"failed"}}\r\n\r\n', "streaming error"],
  ])(
    "rejects incomplete or failed output so the agent can roll back (%s)",
    async (source, error) => {
      const { request, model } = fixture();
      await model.enable("SDK catalog", signal(), () => {});
      request.mockResolvedValueOnce(stream(source));
      await expect(collect(model)).rejects.toThrow(error);
    },
  );

  it("reports missing configuration and HTTP failures without a local-model fallback", async () => {
    const { request, model } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(Response.json({ configured: false }));
    await expect(
      model.enable("SDK catalog", signal(), () => {}),
    ).rejects.toThrow("DEEPSEEK_API_KEY");
    request.mockResolvedValueOnce(
      Response.json({ configured: true, model: "deepseek-flash" }),
    );
    await model.enable("SDK catalog", signal(), () => {});
    request.mockResolvedValueOnce(new Response("denied", { status: 401 }));
    await expect(collect(model)).rejects.toThrow("HTTP 401");
  });

  it("passes cancellation to fetch and rejects cancelled output", async () => {
    const { request, model } = fixture();
    await model.enable("SDK catalog", signal(), () => {});
    const controller = new AbortController();
    request.mockImplementationOnce(async (_url, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return stream(
        frame("stale") + frame("", "stop") + "data: [DONE]\r\n\r\n",
      );
    });
    await expect(
      collect(model, "request", controller.signal),
    ).rejects.toThrow();
  });
});
