import { getConfig } from "../config.js";
import type {
  AssistantBlock,
  LLM,
  LLMEvent,
  LLMJsonRequest,
  LLMStreamRequest,
  TokenUsage,
} from "./types.js";

/**
 * OpenAI-compatible chat-completions adapter (NVIDIA NIM, OpenRouter, etc.).
 * The agent loop speaks Anthropic-style content blocks; this translates at the boundary.
 */

type OAMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type AnyBlock = Record<string, unknown> & { type?: string };

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as AnyBlock[])
    .map((b) => (b.type === "text" ? String(b.text ?? "") : ""))
    .join("");
}

export function toOpenAIMessages(system: { text: string }[], messages: unknown[]): OAMessage[] {
  const out: OAMessage[] = [];
  const sys = system.map((s) => s.text).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });

  for (const m of messages as { role: string; content: unknown }[]) {
    if (m.role === "assistant") {
      const text = blocksText(m.content);
      const toolCalls = Array.isArray(m.content)
        ? (m.content as AnyBlock[])
            .filter((b) => b.type === "tool_use")
            .map((b) => ({
              id: String(b.id),
              type: "function" as const,
              function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
            }))
        : [];
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (Array.isArray(m.content)) {
      const blocks = m.content as AnyBlock[];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const c = b.content;
          out.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id),
            content: typeof c === "string" ? c : blocksText(c),
          });
        }
      }
      const text = blocksText(blocks);
      if (text) out.push({ role: "user", content: text });
    } else {
      out.push({ role: "user", content: String(m.content ?? "") });
    }
  }
  return out;
}

function headers(key: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

export function createOpenAILlm(apiKey?: string): LLM {
  const cfg = getConfig();
  const key = apiKey ?? cfg.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY not set");
  const url = `${cfg.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  /** Set once the provider rejected `stream_options`: later calls on this client do not send it. */
  let usageUnsupported = false;

  /** POST with up to 3 tries on network errors / 429 / 5xx. Returns the last response (ok or not). */
  const post = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Response | undefined> => {
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headers(key),
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal?.aborted || attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
    return res;
  };

  return {
    async *stream(req: LLMStreamRequest): AsyncIterable<LLMEvent> {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens ?? cfg.MAX_OUTPUT_TOKENS,
        stream: true,
        messages: toOpenAIMessages(req.system, req.messages as unknown[]),
      };
      // Ask for token usage in the final chunk; providers that reject the parameter get one retry without it.
      if (!usageUnsupported) body.stream_options = { include_usage: true };
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description ?? "",
            parameters: (t as { input_schema: unknown }).input_schema,
          },
        }));
        body.tool_choice =
          req.forceTool && req.forceToolName
            ? { type: "function", function: { name: req.forceToolName } }
            : req.forceTool
              ? "required"
              : "auto";
      }

      let res = await post(body, req.signal);
      if (res?.status === 400 && "stream_options" in body) {
        const detail = await res.text();
        if (!/stream_options|include_usage/i.test(detail)) {
          throw new Error(`LLM request failed (400): ${detail.slice(0, 300)}`);
        }
        usageUnsupported = true;
        delete body.stream_options;
        res = await post(body, req.signal);
      }
      if (!res || !res.ok || !res.body) {
        throw new Error(`LLM request failed (${res?.status ?? "no response"}): ${res ? (await res.text()).slice(0, 300) : ""}`);
      }

      let text = "";
      let finish: string | null = null;
      let usage: TokenUsage | undefined;
      const tools = new Map<number, { id: string; name: string; args: string }>();

      const decoder = new TextDecoder();
      let buf = "";
      const reader = res.body.getReader();
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break outer;
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          // With include_usage the totals arrive in a last chunk with no choices (other chunks carry usage: null).
          if (json.usage && typeof json.usage === "object") {
            const inT = Number(json.usage.prompt_tokens ?? json.usage.input_tokens);
            const outT = Number(json.usage.completion_tokens ?? json.usage.output_tokens);
            if (Number.isFinite(inT) && Number.isFinite(outT)) usage = { inputTokens: inT, outputTokens: outT };
          }
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            yield { type: "text_delta", text: delta.content };
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx: number = tc.index ?? 0;
            const cur = tools.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            tools.set(idx, cur);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }

      const content: Exclude<AssistantBlock, string> = [];
      if (text) content.push({ type: "text", text });
      let n = 0;
      for (const t of tools.values()) {
        let input: unknown = {};
        try {
          input = t.args ? JSON.parse(t.args) : {};
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: t.id || `call_${Date.now()}_${n++}`, name: t.name, input });
      }

      yield {
        type: "done",
        // "length" wins over tool calls: a call cut off mid-arguments must not be executed (agent/loop.ts retries).
        stopReason: finish === "length" ? "max_tokens" : tools.size > 0 ? "tool_use" : "end_turn",
        content,
        ...(usage ? { usage } : {}),
      };
    },

    async json<T>(req: LLMJsonRequest): Promise<T> {
      const res = await fetch(url, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({
          model: req.model,
          max_tokens: 2048,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`LLM request failed (${res.status})`);
      const data = (await res.json()) as any;
      const text: string = data.choices?.[0]?.message?.content?.trim() ?? "";
      const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      return JSON.parse(cleaned) as T;
    },
  };
}
