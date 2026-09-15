import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { nas } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";

const inputClass =
  "h-10 w-full rounded-[var(--radius)] border border-sage-line bg-bone/60 px-3 text-[13px] text-ink";

/** Prefer the latest save response; otherwise the last successful publish poll. */
function publishedAddresses(
  save: {
    isSuccess: boolean;
    data?: { wan_ip?: string; lan_ip?: string };
  },
  publish: {
    isSuccess: boolean;
    data?: { wan_ip?: string; lan_ip?: string };
  },
): { wan_ip?: string; lan_ip?: string } | undefined {
  if (save.isSuccess && save.data !== undefined) {
    return save.data;
  }
  if (publish.isSuccess && publish.data !== undefined) {
    return publish.data;
  }
  return undefined;
}

/**
 * Public Headscale URL on the box. Dwar keys live in dadiOS Preferences, not Hath.
 */
export function ModuleSettings() {
  const { state } = useConnection();
  const connected = state === "connected";
  const qc = useQueryClient();
  const urlQuery = useQuery({
    queryKey: ["nas", "control-url"],
    queryFn: () => nas.getControlUrl(),
    enabled: connected,
  });
  const publishQuery = useQuery({
    queryKey: ["nas", "headscale-publish"],
    queryFn: () => nas.getHeadscalePublish(),
    enabled: connected,
    retry: false,
  });
  const [controlUrl, setControlUrl] = useState("");

  useEffect(() => {
    if (urlQuery.data !== undefined) {
      setControlUrl(urlQuery.data.trim());
    }
  }, [urlQuery.data]);

  const saveUrl = useMutation({
    mutationFn: () => nas.putControlUrl(controlUrl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "control-url"] });
      qc.invalidateQueries({ queryKey: ["nas", "headscale-publish"] });
    },
  });

  if (!connected) {
    return (
      <p className="text-sm text-ink/60">Connect to the mesh to edit the control plane.</p>
    );
  }
  if (urlQuery.isLoading) {
    return <p className="text-sm text-ink/60">Loading…</p>;
  }
  if (urlQuery.isError) {
    return (
      <p className="text-sm text-[#9a5a4e]">
        {urlQuery.error instanceof Error
          ? urlQuery.error.message
          : String(urlQuery.error)}
      </p>
    );
  }

  const published = publishedAddresses(saveUrl, publishQuery);
  const wan = published?.wan_ip;
  const lan = published?.lan_ip;

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] text-ink">Control plane URL</span>
        <span className="text-xs text-ink/50">
          https hostname Hath dials. Saving publishes Headscale on 443 via
          UPnP. Point DNS at the WAN address.
        </span>
        <input
          className={inputClass}
          value={controlUrl}
          onChange={(e) => setControlUrl(e.target.value)}
          spellCheck={false}
        />
      </label>
      {publishQuery.isError ? (
        <p className="text-xs text-[#9a5a4e]">
          {publishQuery.error instanceof Error
            ? publishQuery.error.message
            : String(publishQuery.error)}
        </p>
      ) : null}
      {wan || lan ? (
        <p className="font-mono text-xs text-ink-muted">
          {wan ? `WAN ${wan}` : ""}
          {wan && lan ? "  ·  " : ""}
          {lan ? `LAN ${lan}` : ""}
        </p>
      ) : null}
      <button
        type="button"
        disabled={saveUrl.isPending}
        onClick={() => saveUrl.mutate()}
        className="h-10 w-fit rounded-[var(--radius)] border border-sage-line px-4 text-[13px] text-ink hover:border-sage-deep disabled:opacity-50"
      >
        {saveUrl.isPending ? "Publishing…" : "Save and publish"}
      </button>
      {saveUrl.isError ? (
        <p className="text-xs text-[#9a5a4e]">
          {saveUrl.error instanceof Error
            ? saveUrl.error.message
            : String(saveUrl.error)}
        </p>
      ) : null}
    </div>
  );
}
