
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/test-ai") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const key = request.headers.get("X-AGC-Test-Key");

    if (!env.AGC_TEST_KEY || key !== env.AGC_TEST_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!env.DEEPSEEK_API_KEY) {
      return new Response("DeepSeek key missing", { status: 503 });
    }

    try {
      const response = await fetch(
        "https://api.deepseek.com/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              {
                role: "user",
                content: "Ответь одним словом: работает?"
              }
            ],
            max_tokens: 30
          })
        }
      );

      if (!response.ok) {
        return Response.json(
          { ok: false, deepseekStatus: response.status },
          { status: 502 }
        );
      }

      const data = await response.json();

      return Response.json({
        ok: true,
        answer: data.choices?.[0]?.message?.content
      });
    } catch {
      return Response.json(
        { ok: false, error: "DeepSeek request failed" },
        { status: 502 }
      );
    }
  }
};
