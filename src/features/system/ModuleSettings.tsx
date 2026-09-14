import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { nas } from "../../shared/api";
import type { DwarSettings } from "../../shared/api/nas";
import { useConnection } from "../../hooks/useConnection";

type ConfigTab = "dwar" | "cloudflared";

const inputClass =
  "h-10 w-full rounded-[var(--radius)] border border-sage-line bg-bone/60 px-3 text-[13px] text-ink";

/**
 * Nas-owned dwar keys/config and tunnel editors.
 * Saves restart the affected unit on the box.
 */
export function ModuleSettings() {
  const { state } = useConnection();
  const connected = state === "connected";
  const [tab, setTab] = useState<ConfigTab>("dwar");

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <TabButton
          active={tab === "dwar"}
          onClick={() => setTab("dwar")}
          label="dwar"
        />
        <TabButton
          active={tab === "cloudflared"}
          onClick={() => setTab("cloudflared")}
          label="tunnel"
        />
      </div>

      {!connected ? (
        <p className="text-sm text-ink/60">Connect to the mesh to edit box config.</p>
      ) : tab === "cloudflared" ? (
        <CloudflaredEditor />
      ) : (
        <DwarEditor />
      )}
    </div>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`rounded-[var(--radius)] border px-2.5 py-1 text-[11px] font-medium tracking-[1.5px] uppercase ${
        props.active
          ? "border-sage-deep bg-sage-deep/10 text-sage-deep"
          : "border-sage-line text-ink/70 hover:border-sage-deep/40"
      }`}
    >
      {props.label}
    </button>
  );
}

function DwarEditor() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["nas", "dwar-settings"],
    queryFn: () => nas.getDwarSettings(),
  });
  const [draft, setDraft] = useState<DwarSettings | null>(null);

  useEffect(() => {
    if (query.data) {
      setDraft(structuredClone(query.data));
    }
  }, [query.data]);

  const save = useMutation({
    mutationFn: (next: DwarSettings) => nas.putDwarSettings(next),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["nas", "dwar-settings"] }),
  });

  if (query.isLoading) {
    return <p className="text-sm text-ink/60">Loading…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-sm text-[#9a5a4e]">
        {query.error instanceof Error ? query.error.message : "Failed to load"}
      </p>
    );
  }
  if (!draft) {
    return <p className="text-sm text-ink/60">Loading…</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <Section title="Keys">
        <Field
          label="Anthropic"
          secret
          value={draft.env.ANTHROPIC_API_KEY}
          onChange={(v) =>
            setDraft({ ...draft, env: { ...draft.env, ANTHROPIC_API_KEY: v } })
          }
        />
        <Field
          label="Gemini"
          secret
          value={draft.env.GEMINI_API_KEY}
          onChange={(v) =>
            setDraft({ ...draft, env: { ...draft.env, GEMINI_API_KEY: v } })
          }
        />
        <Field
          label="OpenAI"
          secret
          value={draft.env.OPENAI_API_KEY}
          onChange={(v) =>
            setDraft({ ...draft, env: { ...draft.env, OPENAI_API_KEY: v } })
          }
        />
        <Field
          label="Deepgram"
          secret
          value={draft.env.DEEPGRAM_API_KEY}
          onChange={(v) =>
            setDraft({ ...draft, env: { ...draft.env, DEEPGRAM_API_KEY: v } })
          }
        />
      </Section>

      <Section title="Reasoning">
        <Field
          label="Provider"
          value={draft.config.chat.reasoning.provider}
          onChange={(v) => setChat(draft, setDraft, "reasoning", "provider", v)}
        />
        <Field
          label="Model"
          value={draft.config.chat.reasoning.model}
          onChange={(v) => setChat(draft, setDraft, "reasoning", "model", v)}
        />
        <Field
          label="Max tokens"
          value={String(draft.config.chat.reasoning.max_tokens)}
          onChange={(v) =>
            setChat(draft, setDraft, "reasoning", "max_tokens", Number(v))
          }
        />
        <Field
          label="Thinking budget"
          value={String(draft.config.chat.reasoning.thinking_budget)}
          onChange={(v) =>
            setChat(draft, setDraft, "reasoning", "thinking_budget", Number(v))
          }
        />
      </Section>

      <Section title="Conversation">
        <Field
          label="Provider"
          value={draft.config.chat.conversation.provider}
          onChange={(v) =>
            setChat(draft, setDraft, "conversation", "provider", v)
          }
        />
        <Field
          label="Model"
          value={draft.config.chat.conversation.model}
          onChange={(v) => setChat(draft, setDraft, "conversation", "model", v)}
        />
        <Field
          label="Max tokens"
          value={String(draft.config.chat.conversation.max_tokens)}
          onChange={(v) =>
            setChat(draft, setDraft, "conversation", "max_tokens", Number(v))
          }
        />
      </Section>

      <Section title="Embed">
        <Field
          label="Provider"
          value={draft.config.embed.provider}
          onChange={(v) => setEmbed(draft, setDraft, "provider", v)}
        />
        <Field
          label="Model"
          value={draft.config.embed.model}
          onChange={(v) => setEmbed(draft, setDraft, "model", v)}
        />
        <Field
          label="Dimensions"
          value={String(draft.config.embed.dimensions)}
          onChange={(v) => setEmbed(draft, setDraft, "dimensions", Number(v))}
        />
        <Field
          label="Max batch size"
          value={String(draft.config.embed.max_batch_size)}
          onChange={(v) =>
            setEmbed(draft, setDraft, "max_batch_size", Number(v))
          }
        />
        <Field
          label="Max text length"
          value={String(draft.config.embed.max_text_length)}
          onChange={(v) =>
            setEmbed(draft, setDraft, "max_text_length", Number(v))
          }
        />
      </Section>

      <Section title="Image describe">
        <Field
          label="Provider"
          value={draft.config.image.describe.provider}
          onChange={(v) => setDescribe(draft, setDraft, "provider", v)}
        />
        <Field
          label="Model"
          value={draft.config.image.describe.model}
          onChange={(v) => setDescribe(draft, setDraft, "model", v)}
        />
        <Field
          label="Max tokens"
          value={String(draft.config.image.describe.max_tokens)}
          onChange={(v) =>
            setDescribe(draft, setDraft, "max_tokens", Number(v))
          }
        />
        <Field
          label="Max bytes"
          value={String(draft.config.image.describe.max_bytes)}
          onChange={(v) => setDescribe(draft, setDraft, "max_bytes", Number(v))}
        />
        <Field
          label="Max prompt length"
          value={String(draft.config.image.describe.max_prompt_length)}
          onChange={(v) =>
            setDescribe(draft, setDraft, "max_prompt_length", Number(v))
          }
        />
        <Field
          label="Allowed media types"
          hint="Comma-separated MIME types"
          value={draft.config.image.describe.allowed_media_types.join(", ")}
          onChange={(v) =>
            setDescribe(draft, setDraft, "allowed_media_types", csv(v))
          }
        />
      </Section>

      <Section title="Image create">
        <Field
          label="Provider"
          value={draft.config.image.create.provider}
          onChange={(v) => setCreate(draft, setDraft, "provider", v)}
        />
        <Field
          label="Model"
          value={draft.config.image.create.model}
          onChange={(v) => setCreate(draft, setDraft, "model", v)}
        />
        <Field
          label="Max prompt length"
          value={String(draft.config.image.create.max_prompt_length)}
          onChange={(v) =>
            setCreate(draft, setDraft, "max_prompt_length", Number(v))
          }
        />
      </Section>

      <Section title="Speech">
        <Field
          label="Provider"
          value={draft.config.speech.transcribe.provider}
          onChange={(v) => setSpeech(draft, setDraft, "provider", v)}
        />
        <Field
          label="Model"
          value={draft.config.speech.transcribe.model}
          onChange={(v) => setSpeech(draft, setDraft, "model", v)}
        />
        <Field
          label="Language"
          value={draft.config.speech.transcribe.language}
          onChange={(v) => setSpeech(draft, setDraft, "language", v)}
        />
        <Field
          label="Max bytes"
          value={String(draft.config.speech.transcribe.max_bytes)}
          onChange={(v) => setSpeech(draft, setDraft, "max_bytes", Number(v))}
        />
        <Field
          label="Allowed media types"
          hint="Comma-separated MIME types"
          value={draft.config.speech.transcribe.allowed_media_types.join(", ")}
          onChange={(v) =>
            setSpeech(draft, setDraft, "allowed_media_types", csv(v))
          }
        />
      </Section>

      <Section title="Retry">
        <Field
          label="Attempts"
          value={String(draft.config.retry.attempts)}
          onChange={(v) => setRetry(draft, setDraft, "attempts", Number(v))}
        />
        <Field
          label="Backoff seconds"
          hint="Comma-separated"
          value={draft.config.retry.backoff_seconds.join(", ")}
          onChange={(v) =>
            setRetry(
              draft,
              setDraft,
              "backoff_seconds",
              csv(v).map((n) => Number(n)).filter((n) => !Number.isNaN(n)),
            )
          }
        />
        <Field
          label="Timeout seconds"
          value={String(draft.config.retry.timeout_seconds)}
          onChange={(v) =>
            setRetry(draft, setDraft, "timeout_seconds", Number(v))
          }
        />
      </Section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate(draft)}
          className="h-10 rounded-[var(--radius)] border border-sage-line px-4 text-[13px] text-ink hover:border-sage-deep disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.error instanceof Error ? (
          <p className="text-xs text-[#9a5a4e]">{save.error.message}</p>
        ) : null}
        {save.isSuccess && !save.isPending ? (
          <p className="text-xs text-sage-deep">Saved (module restarted).</p>
        ) : null}
      </div>
    </div>
  );
}

function CloudflaredEditor() {
  const qc = useQueryClient();
  const tokenQuery = useQuery({
    queryKey: ["nas", "cloudflared-token"],
    queryFn: () => nas.getCloudflaredToken(),
  });
  const urlQuery = useQuery({
    queryKey: ["nas", "control-url"],
    queryFn: () => nas.getControlUrl(),
  });
  const [token, setToken] = useState("");
  const [controlUrl, setControlUrl] = useState("");
  useEffect(() => {
    if (tokenQuery.data !== undefined) {
      setToken(tokenQuery.data.trim());
    }
  }, [tokenQuery.data]);
  useEffect(() => {
    if (urlQuery.data !== undefined) {
      setControlUrl(urlQuery.data.trim());
    }
  }, [urlQuery.data]);

  const saveToken = useMutation({
    mutationFn: () => nas.putCloudflaredToken(token),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["nas", "cloudflared-token"] }),
  });
  const saveUrl = useMutation({
    mutationFn: () => nas.putControlUrl(controlUrl),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nas", "control-url"] }),
  });

  if (tokenQuery.isLoading || urlQuery.isLoading) {
    return <p className="text-sm text-ink/60">Loading…</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Field
        label="Control plane URL"
        hint="Public Headscale URL embedded in device provision codes."
        value={controlUrl}
        onChange={setControlUrl}
      />
      <button
        type="button"
        disabled={saveUrl.isPending}
        onClick={() => saveUrl.mutate()}
        className="h-10 w-fit rounded-[var(--radius)] border border-sage-line px-4 text-[13px] text-ink hover:border-sage-deep disabled:opacity-50"
      >
        {saveUrl.isPending ? "Saving…" : "Save control URL"}
      </button>
      {saveUrl.error instanceof Error ? (
        <p className="text-xs text-[#9a5a4e]">{saveUrl.error.message}</p>
      ) : null}
      <Field
        label="Cloudflare tunnel token"
        hint="Routes the control plane URL → Headscale on this box."
        value={token}
        onChange={setToken}
      />
      <button
        type="button"
        disabled={saveToken.isPending}
        onClick={() => saveToken.mutate()}
        className="h-10 w-fit rounded-[var(--radius)] border border-sage-line px-4 text-[13px] text-ink hover:border-sage-deep disabled:opacity-50"
      >
        {saveToken.isPending ? "Saving…" : "Save token"}
      </button>
      {saveToken.error instanceof Error ? (
        <p className="text-xs text-[#9a5a4e]">{saveToken.error.message}</p>
      ) : null}
      {saveToken.isSuccess && !saveToken.isPending ? (
        <p className="text-xs text-sage-deep">Saved (module restarted).</p>
      ) : null}
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
        {props.title.toUpperCase()}
      </span>
      {props.children}
    </div>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] text-ink">{props.label}</span>
      {props.hint ? <span className="text-xs text-ink/50">{props.hint}</span> : null}
      <input
        className={inputClass}
        type={props.secret ? "password" : "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

function csv(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function setChat(
  draft: DwarSettings,
  setDraft: (s: DwarSettings) => void,
  lane: "reasoning" | "conversation",
  key: string,
  value: string | number,
) {
  setDraft({
    ...draft,
    config: {
      ...draft.config,
      chat: {
        ...draft.config.chat,
        [lane]: { ...draft.config.chat[lane], [key]: value },
      },
    },
  });
}

function setEmbed(
  draft: DwarSettings,
  setDraft: (s: DwarSettings) => void,
  key: string,
  value: string | number,
) {
  setDraft({
    ...draft,
    config: { ...draft.config, embed: { ...draft.config.embed, [key]: value } },
  });
}

function setDescribe(
  draft: DwarSettings,
  setDraft: (s: DwarSettings) => void,
  key: string,
  value: string | number | string[],
) {
  setDraft({
    ...draft,
    config: {
      ...draft.config,
      image: {
        ...draft.config.image,
        describe: { ...draft.config.image.describe, [key]: value },
      },
    },
  });
}

function setCreate(
  draft: DwarSettings,
  setDraft: (s: DwarSettings) => void,
  key: string,
  value: string | number,
) {
  setDraft({
    ...draft,
    config: {
      ...draft.config,
      image: {
        ...draft.config.image,
        create: { ...draft.config.image.create, [key]: value },
      },
    },
  });
}

function setSpeech(
  draft: DwarSettings,
  setDraft: (s: DwarSettings) => void,
  key: string,
  value: string | number | string[],
) {
  setDraft({
    ...draft,
    config: {
      ...draft.config,
      speech: {
        ...draft.config.speech,
        transcribe: { ...draft.config.speech.transcribe, [key]: value },
      },
    },
  });
}

function setRetry(
  draft: DwarSettings,
  setDraft: (s: DwarSettings) => void,
  key: string,
  value: number | number[],
) {
  setDraft({
    ...draft,
    config: {
      ...draft.config,
      retry: { ...draft.config.retry, [key]: value },
    },
  });
}
