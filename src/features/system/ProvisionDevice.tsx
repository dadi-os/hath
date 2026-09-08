import { useMutation } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { nas } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";

/**
 * Mint a single-use setup code for a new Hath node: name → Nas /provision →
 * QR + pasteable text for the joining device.
 */
export function ProvisionDevice() {
  const { state } = useConnection();
  const connected = state === "connected";
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
      <p className="text-sm text-ink/60">
        Connect to the mesh to create a setup code.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-xs text-ink/50">
        Name the new device, then show the QR (or paste the code) on that
        install. Single-use, expires in about an hour.
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium tracking-[1.5px] text-sage-deep">
            NODE NAME
          </span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="ankur-phone"
            className="rounded-[var(--radius)] border border-sage-line bg-bone/60 px-2 py-1.5 text-sm text-ink outline-none focus:border-sage"
            disabled={mint.isPending}
          />
        </label>
        <button
          type="submit"
          disabled={mint.isPending || !nodeName.trim()}
          className="rounded-[var(--radius)] border border-sage-line px-2.5 py-1.5 text-[11px] font-medium tracking-[1.5px] text-ink/80 hover:border-sage-deep disabled:opacity-50"
        >
          {mint.isPending ? "CREATING…" : "CREATE SETUP CODE"}
        </button>
      </form>
      {mint.error instanceof Error ? (
        <p className="text-xs text-terracotta">{mint.error.message}</p>
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

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(props.bundle, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
      color: { dark: "#2c302a", light: "#fafaf7" },
    }).then((url) => {
      if (!cancelled) {
        setDataUrl(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.bundle]);

  return (
    <div className="flex flex-col gap-3 border-t border-dashed border-sage-line pt-3">
      <div className="flex flex-col items-center gap-2">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="Setup code QR"
            className="h-[220px] w-[220px] rounded-[var(--radius)] border border-sage-line bg-bone"
          />
        ) : (
          <div className="flex h-[220px] w-[220px] items-center justify-center text-xs text-ink/50">
            Encoding…
          </div>
        )}
        <p className="text-center text-xs text-ink/50">
          Scan with the new Hath, or paste the code below.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
            SETUP CODE
          </span>
          <button
            type="button"
            onClick={props.onCopy}
            className="rounded-[var(--radius)] border border-sage-line px-2 py-0.5 text-[11px] tracking-[1px] text-ink/80 hover:border-sage-deep"
          >
            {props.copied ? "Copied" : "Copy"}
          </button>
        </div>
        <textarea
          readOnly
          value={props.bundle}
          rows={4}
          className="w-full resize-y rounded-[var(--radius)] border border-sage-line bg-bone/60 px-2 py-1.5 font-mono text-xs text-ink"
          onFocus={(e) => e.target.select()}
        />
      </div>
    </div>
  );
}
