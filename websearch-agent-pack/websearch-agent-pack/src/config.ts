import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  /** "0" disables the forced web search on time-sensitive questions (see agent/run-turn.ts). */
  FORCE_SEARCH: z.string().default("1"),
  LLM_BASE_URL: z.string().default("https://integrate.api.nvidia.com/v1"),
  TAVILY_API_KEY: z.string().optional(),
  MODEL_MAIN: z.string().optional(),
  MODEL_FAST: z.string().optional(),
  /** Slower, higher-quality model for the "Smart" option (hard reasoning). */
  MODEL_SMART: z.string().optional(),
  /** Interface to bind. 127.0.0.1 for local dev; 0.0.0.0 in containers. */
  HOST: z.string().default("127.0.0.1"),
  /** If set, the whole app (except /health) sits behind HTTP Basic auth with this password. */
  ACCESS_TOKEN: z.string().optional(),
  ACCESS_USER: z.string().default("minimi"),
  /** Max chat requests per client IP per minute (0 = unlimited). */
  RATE_LIMIT_PER_MIN: z.coerce.number().default(30),
  /** "1" = trust X-Forwarded-For (only behind a reverse proxy you control). */
  TRUST_PROXY: z.string().default("0"),
  PORT: z.coerce.number().default(3000),
  DB_PATH: z.string().default("./data/agent.db"),
  DEFAULT_TZ: z.string().default("Asia/Kolkata"),
  CLOCK_OVERRIDE: z.string().optional(),
  NODE_ENV: z.string().optional(),
  MAX_STEPS: z.coerce.number().default(4),
  MAX_SEARCHES_PER_STEP: z.coerce.number().default(12),
  MAX_SEARCHES_PER_TURN: z.coerce.number().default(16),
  SEARCH_TIMEOUT_MS: z.coerce.number().default(6000),
  SEARCH_CACHE_TTL_SEC: z.coerce.number().default(600),
});

/** Empty values and untouched `.env.example` placeholders count as "not set". */
function realKey(v: string | undefined): string | undefined {
  const t = v?.trim();
  return !t || /REPLACE_ME/i.test(t) ? undefined : t;
}

export type AppConfig = Omit<z.infer<typeof envSchema>, "MODEL_MAIN" | "MODEL_FAST" | "MODEL_SMART"> & {
  MODEL_MAIN: string;
  MODEL_FAST: string;
  MODEL_SMART: string;
  hasLlm: boolean;
  hasSearch: boolean;
  isProduction: boolean;
};

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.format());
    process.exit(1);
  }
  const v = parsed.data;
  v.ANTHROPIC_API_KEY = realKey(v.ANTHROPIC_API_KEY);
  v.NVIDIA_API_KEY = realKey(v.NVIDIA_API_KEY);
  v.TAVILY_API_KEY = realKey(v.TAVILY_API_KEY);
  const anthropic = Boolean(v.ANTHROPIC_API_KEY?.trim());
  cached = {
    ...v,
    // Defaults follow the active provider; set MODEL_MAIN / MODEL_FAST to override.
    MODEL_MAIN: v.MODEL_MAIN?.trim() || (anthropic ? "claude-sonnet-5-5" : "poolside/laguna-xs-2.1"),
    MODEL_SMART: v.MODEL_SMART?.trim() || (anthropic ? "claude-opus-5-5" : "google/gemma-4-31b-it"),
    MODEL_FAST: v.MODEL_FAST?.trim() || (anthropic ? "claude-haiku-5-5" : "nvidia/nemotron-3.5-bolt-e4b"),
    hasLlm: Boolean(v.ANTHROPIC_API_KEY?.trim() || v.NVIDIA_API_KEY?.trim()),
    // Always available: falls back to keyless web search when no Tavily key is set.
    hasSearch: true,
    isProduction: v.NODE_ENV === "production",
  };
  return cached;
}

export function requireChatKeys(cfg: AppConfig): { ok: true } | { ok: false; message: string } {
  if (!cfg.hasLlm) return { ok: false, message: "No LLM API key configured — add NVIDIA_API_KEY or ANTHROPIC_API_KEY to .env and restart (see README → API keys)" };
  if (!cfg.hasSearch) return { ok: false, message: "Missing TAVILY_API_KEY — copy .env.example to .env" };
  return { ok: true };
}
