import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { isMeshOnline, nas } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";
import { renderBrandedQr } from "../../shared/lib/qr/brandedQr";

/**
 * Mint a single-use setup code for a new Hath node: name → Nas /provision →
 * branded QR + pasteable text for the joining device.
 */
export function ProvisionDevice() {
  const { state } = useConnection();
  const connected = isMeshOnline(state);
  const [nodeName, setNodeName] = useState("");
  const [bundle, setBundle] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mint = useMutation({
    mutationFn: (name: string) => nas.provision(name),
    onSuccess: (res) => {
      setBundle(res.bundle);
      setCopied(false);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const name = nodeName.trim();
    if (!name || mint.isPending) {
      return;
    }
    setBundle(null);
    mint.mutate(name);
  };

  const onCopy = async () => {
    if (!bundle) {
      return;
    }
    await navigator.clipboard.writeText(bundle);
    setCopied(true);
  };

  if (!connected) {
    return (
      <p className="py-6 text-center text-[13px] text-ink-ghost">
        Connect to create a setup code
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium tracking-[2px] text-ink-ghost">
            NODE NAME
          </span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="phone"
            className="rounded-[var(--radius)] border border-rule bg-bone/50 px-3 py-2 text-[14px] text-ink outline-none focus:border-sage"
            disabled={mint.isPending}
          />
        </label>
        <button
          type="submit"
          disabled={mint.isPending || !nodeName.trim()}
          className="rounded-[var(--radius)] bg-sage-fill px-3 py-2 text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-40"
        >
          {mint.isPending ? "CREATING…" : "CREATE SETUP CODE"}
        </button>
      </form>
      {mint.error instanceof Error ? (
        <p className="text-center text-[13px] text-[#b56b5c]">
          {mint.error.message}
        </p>
      ) : null}
      {bundle ? (
        <SetupCodeDisplay
          bundle={bundle}
          copied={copied}
          onCopy={() => {
            void onCopy();
          }}
        />
      ) : null}
    </div>
  );
}

function SetupCodeDisplay(props: {
  bundle: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [encodeError, setEncodeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEncodeError(null);
    setDataUrl(null);
    void renderBrandedQr(props.bundle, { size: 220 })
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDataUrl(null);
          setEncodeError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.bundle]);

  return (
    <div className="flex flex-col items-center gap-4">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="Setup code QR"
          className="h-[220px] w-[220px]"
        />
      ) : (
        <div className="flex h-[220px] w-[220px] items-center justify-center px-3 text-center text-[13px] text-ink-ghost">
          {encodeError ?? "Encoding…"}
        </div>
      )}
      <p className="text-center text-[13px] text-ink-ghost">
        Scan with the new Hath, or copy the code.
      </p>
      <button
        type="button"
        onClick={props.onCopy}
        className="text-[12px] font-medium tracking-[2px] text-sage-deep"
      >
        {props.copied ? "COPIED" : "COPY CODE"}
      </button>
      <textarea
        readOnly
        value={props.bundle}
        rows={3}
        className="w-full resize-none rounded-[var(--radius)] border border-rule bg-bone/40 px-3 py-2 font-mono text-[11px] text-ink-muted"
        onFocus={(e) => e.target.select()}
      />
    </div>
  );
}
