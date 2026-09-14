import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownBodyProps {
  /** Markdown source to render. */
  content: string;
}

/**
 * Chat markdown body — GFM prose with Cursor-style link chips (favicon + domain).
 */
export function MarkdownBody({ content }: MarkdownBodyProps) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

const components: Components = {
  a({ href, children }) {
    if (!href) {
      return <span>{children}</span>;
    }
    return <LinkChip href={href}>{children}</LinkChip>;
  },
};

/** Favicon + domain chip for an absolute http(s) link; other hrefs render as plain text. */
function LinkChip({
  href,
  children,
}: {
  href: string;
  children?: ReactNode;
}) {
  const domain = httpDomain(href);
  if (domain === null) {
    return <span>{children}</span>;
  }

  const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="chat-link-chip"
      title={href}
    >
      <img
        src={favicon}
        alt=""
        width={14}
        height={14}
        className="chat-link-chip__icon"
      />
      <span className="chat-link-chip__label">{domain}</span>
    </a>
  );
}

/**
 * Registrable host for an http(s) URL, without leading www.
 * Returns null when the href is not a parseable http(s) URL.
 */
function httpDomain(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return url.hostname.replace(/^www\./i, "");
}
