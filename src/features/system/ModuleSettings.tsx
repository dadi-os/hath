import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { nas } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";

type ConfigTab = "dwar" | "cloudflared";

/**
 * Nas-owned dwar .env / config.toml / cloudflared token editors.
 * Yaad/Dimaag have no editable secrets (Postgres is baked into Nas).
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
        <ModuleEditor />
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

function ModuleEditor() {
  const qc = useQueryClient();
  const envQuery = useQuery({
    queryKey: ["nas", "env", "dwar"],
    queryFn: () => nas.getModuleEnv("dwar"),
  });
  const configQuery = useQuery({
    queryKey: ["nas", "dwar-config"],
    queryFn: () => nas.getDwarConfig(),
  });

  const [envText, setEnvText] = useState("");
  const [configText, setConfigText] = useState("");

  useEffect(() => {
    if (envQuery.data !== undefined) {
      setEnvText(envQuery.data);
    }
  }, [envQuery.data]);

  useEffect(() => {
    if (configQuery.data !== undefined) {
      setConfigText(configQuery.data);
    }
  }, [configQuery.data]);

  const saveEnv = useMutation({
    mutationFn: () => nas.putModuleEnv("dwar", envText),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nas", "env", "dwar"] }),
  });

  const saveConfig = useMutation({
    mutationFn: () => nas.putDwarConfig(configText),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nas", "dwar-config"] }),
  });

  if (envQuery.isLoading) {
    return <p className="text-sm text-ink/60">Loading…</p>;
  }
  if (envQuery.isError) {
    return (
      <p className="text-sm text-terracotta">
        {envQuery.error instanceof Error ? envQuery.error.message : "Failed to load"}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <FieldBlock
        title=".env"
        value={envText}
        onChange={setEnvText}
        onSave={() => saveEnv.mutate()}
        saving={saveEnv.isPending}
        error={saveEnv.error}
        ok={saveEnv.isSuccess}
      />
      <FieldBlock
        title="config.toml"
        value={configText}
        onChange={setConfigText}
        onSave={() => saveConfig.mutate()}
        saving={saveConfig.isPending}
        error={saveConfig.error}
        ok={saveConfig.isSuccess}
        rows={14}
      />
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
      <FieldBlock
        title="Control plane URL"
        hint="Public Headscale URL embedded in device provision codes (e.g. https://dadi.ardusa.dev)."
        value={controlUrl}
        onChange={setControlUrl}
        onSave={() => saveUrl.mutate()}
        saving={saveUrl.isPending}
        error={saveUrl.error}
        ok={saveUrl.isSuccess}
        rows={2}
      />
      <FieldBlock
        title="Cloudflare tunnel token"
        hint="Routes the control plane URL → Headscale on this box."
        value={token}
        onChange={setToken}
        onSave={() => saveToken.mutate()}
        saving={saveToken.isPending}
        error={saveToken.error}
        ok={saveToken.isSuccess}
        rows={4}
      />
    </div>
  );
}

function FieldBlock(props: {
  title: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  error: unknown;
  ok: boolean;
  rows?: number;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
          {props.title}
        </span>
        <button
          type="button"
          disabled={props.saving}
          onClick={props.onSave}
          className="rounded-[var(--radius)] border border-sage-line px-2 py-0.5 text-[11px] tracking-[1px] text-ink/80 hover:border-sage-deep disabled:opacity-50"
        >
          {props.saving ? "Saving…" : "Save"}
        </button>
      </div>
      {props.hint ? (
        <p className="text-xs text-ink/50">{props.hint}</p>
      ) : null}
      <textarea
        className="min-h-[120px] w-full resize-y rounded-[var(--radius)] border border-sage-line bg-bone/60 px-2 py-1.5 font-mono text-xs text-ink"
        rows={props.rows ?? 8}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
      />
      {props.error instanceof Error ? (
        <p className="text-xs text-terracotta">{props.error.message}</p>
      ) : null}
      {props.ok && !props.saving ? (
        <p className="text-xs text-sage-deep">Saved (module restarted).</p>
      ) : null}
    </div>
  );
}
