import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ content, className = "", fallback = "Nothing here yet." }: { content: string | null | undefined; className?: string; fallback?: string }) {
  if (!content?.trim()) return <p className="faint small">{fallback}</p>;
  return <div className={`md ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        img: () => null,
      }}
    >{content}</ReactMarkdown>
  </div>;
}
