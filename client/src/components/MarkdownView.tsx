/**
 * react-markdown 包装：暗色、小字号排版，供输出节点渲染最终文本。
 * 默认不渲染原始 HTML（未启用 rehype-raw），无 XSS 注入面。
 */
import ReactMarkdown, { type Components } from 'react-markdown';

const components: Components = {
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-sm font-semibold text-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 text-sm font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-xs font-semibold text-ink">{children}</h3>,
  p: ({ children }) => <p className="my-1 text-[11px] leading-relaxed text-ink-muted">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-ink-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-ink-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-ink underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-line pl-2 text-ink-muted">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-base bg-elevated p-2 font-mono text-[10px] leading-relaxed text-ink-muted">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[10px] text-ink">{children}</code>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  hr: () => <hr className="my-2 border-line" />,
  table: ({ children }) => (
    <table className="my-1 w-full border-collapse text-[10px]">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-elevated px-1.5 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-1.5 py-1">{children}</td>,
};

interface MarkdownViewProps {
  text: string;
  className?: string;
}

export function MarkdownView({ text, className }: MarkdownViewProps) {
  return (
    <div className={`break-words ${className ?? ''}`}>
      <ReactMarkdown components={components}>{text}</ReactMarkdown>
    </div>
  );
}
