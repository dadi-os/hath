import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { nas } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";

const inputClass =
  "h-10 w-full rounded-[var(--radius)] border border-sage-line bg-bone/60 px-3 text-[13px] text-ink";

/**
 * Control-plane URL and Cloudflare tunnel token on the box.
 * Dwar keys live in dadiOS Preferences, not Hath.
 */
export function ModuleSettings() {
  const { state } = useConnection();
  const connected = state === "connected";
  const qc = useQueryClient();
  const tokenQuery = useQuery({
    queryKey: ["nas", "cloudflared-token"],
    queryFn: () => nas.getCloudflaredToken(),
    enabled: connected,
  });
  const urlQuery = useQuery({
    queryKey: ["nas", "control-url"],
    queryFn: () => nas.getControlUrl(),
    enabled: connected,
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

  if (!connected) {
    return (
      <p className="text-sm text-ink/60">Connect to the mesh to edit the tunnel.</p>
    );
  }
  if (tokenQuery.isLoading || urlQuery.isLoading) {
    return <p className="text-sm text-ink/60">Loading…</p>;
  }
  if (tokenQuery.isError || urlQuery.isError) {
    const err = tokenQuery.error ?? urlQuery.error;
    return (
      <p className="text-sm text-[#9a5a4e]">
        {err instanceof Error ? err.message : "Failed to load tunnel"}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] text-ink">Control plane URL</span>
        <span className="text-xs text-ink/50">
          Public Headscale URL embedded in device provision codes.
        </span>
        <input
          className={inputClass}
          value={controlUrl}
          onChange={(e) => setControlUrl(e.target.value)}
          spellCheck={false}
        />
      </label>
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

      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] text-ink">Cloudflare tunnel token</span>
        <span className="text-xs text-ink/50">
          Routes the control plane URL → Headscale on this box.
        </span>
        <input
          className={inputClass}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
        />
      </label>
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
