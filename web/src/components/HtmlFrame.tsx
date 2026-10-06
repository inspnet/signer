/** Render signature HTML without letting it run script in the portal. */
export function HtmlFrame({ html, className }: { html: string; className?: string }) {
  return (
    <iframe
      sandbox=""
      referrerPolicy="no-referrer"
      title="Preview"
      srcDoc={html || ""}
      className={className ?? "w-full border-0 bg-white"}
    />
  );
}
