import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createDeepSeekServer } from "./deepseek.mjs";

async function fixture(t, options) {
  const server = createDeepSeekServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const root = `http://127.0.0.1:${server.address().port}`;
  return (path, init) => fetch(root + path, init);
}

const completion = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const messages = [
  { role: "system", content: "Catalog" },
  { role: "user", content: "你好" },
];

test("keeps credentials server-side and streams only to the configured official endpoint", async (t) => {
  const source =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  const request = await fixture(t, {
    apiKey: "test-secret",
    model: "deepseek-flash",
    fetch: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "deepseek-flash");
      assert.equal(body.stream, true);
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.deepEqual(body.messages, messages);
      return new Response(source, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  assert.deepEqual(await (await request("/api/deepseek/config")).json(), {
    configured: true,
    model: "deepseek-flash",
  });
  const response = await request(
    "/api/deepseek/completions",
    completion({
      messages,
      model: "ignored",
      apiKey: "ignored",
      url: "https://ignored.test",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), source);
});

test("rejects missing keys and invalid requests before calling DeepSeek", async (t) => {
  const never = () => {
    throw new Error("Must not call upstream");
  };
  const missing = await fixture(t, { apiKey: "", fetch: never });
  assert.equal(
    (await missing("/api/deepseek/completions", completion({ messages })))
      .status,
    503,
  );
  const request = await fixture(t, { apiKey: "test-secret", fetch: never });
  assert.equal(
    (
      await request(
        "/api/deepseek/completions",
        completion({ messages: [{ role: "tool", content: "bad" }] }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/deepseek/completions", {
        method: "POST",
        body: "not json",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request(
        "/api/deepseek/completions",
        completion({
          messages: [{ role: "user", content: "x".repeat(1_000_001) }],
        }),
      )
    ).status,
    413,
  );
});

test("redacts upstream errors and forwards status for authentication/account diagnosis", async (t) => {
  const request = await fixture(t, {
    apiKey: "test-secret",
    fetch: async () => new Response("test-secret", { status: 401 }),
  });
  const response = await request(
    "/api/deepseek/completions",
    completion({ messages }),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes("test-secret"), false);
});

test("aborts upstream generation when the browser disconnects", async (t) => {
  let cancelled;
  const aborted = new Promise((resolve) => {
    cancelled = resolve;
  });
  const request = await fixture(t, {
    apiKey: "test-secret",
    fetch: async (_url, { signal }) => {
      signal.addEventListener("abort", cancelled, { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const response = await request(
    "/api/deepseek/completions",
    completion({ messages }),
  );
  await response.body.cancel();
  await Promise.race([
    aborted,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Upstream was not cancelled")),
        2000,
      );
      timer.unref();
    }),
  ]);
});
