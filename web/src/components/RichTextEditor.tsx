import { useEffect, useRef, useState } from "react";
import { Bold, Code, Italic, Link2, List, RemoveFormatting, Underline } from "lucide-react";

/**
 * A small WYSIWYG editor for disclaimer text. It edits the HTML that goes into
 * the email, so formatting is written as inline styles (styleWithCSS), which
 * is what mail clients honour. The HTML toggle shows and edits that source.
 *
 * Pasting inserts plain text: rich paste from Word or a web page brings
 * classes and fonts that mail clients render unpredictably.
 */

const SIZES = [
  ["9px", "Tiny"],
  ["10px", "Small"],
  ["12px", "Normal"],
  ["14px", "Large"]
] as const;

function exec(command: string, value?: string): void {
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(command, false, value);
}

export function RichTextEditor({
  value,
  onChange,
  minHeight = 180
}: {
  value: string;
  onChange: (html: string) => void;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const [source, setSource] = useState(false);
  const [color, setColor] = useState("#4b5563");

  // Only replace the content for changes from outside, so typing keeps the caret.
  useEffect(() => {
    if (!source && ref.current && value !== emitted.current) {
      ref.current.innerHTML = value;
      emitted.current = value;
    }
  }, [value, source]);

  const emit = () => {
    if (!ref.current) return;
    const html = ref.current.innerHTML;
    emitted.current = html;
    onChange(html);
  };

  const run = (command: string, arg?: string) => {
    ref.current?.focus();
    exec(command, arg);
    emit();
  };

  /** execCommand only knows sizes 1-7; mark the selection with 7, then turn that into pixels. */
  const setSize = (px: string) => {
    if (!ref.current) return;
    ref.current.focus();
    exec("fontSize", "7");
    ref.current.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"]').forEach((el) => {
      el.removeAttribute("size");
      el.style.fontSize = px;
    });
    emit();
  };

  const link = () => {
    const url = prompt("Link address (https://… or mailto:…)", "https://");
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url.trim())) return alert("Use an https:// or mailto: link.");
    run("createLink", url.trim());
  };

  const tool = "h-8 w-8 grid place-items-center rounded-lg text-slate-600 hover:bg-sky hover:text-accent-2";
  // Keep the selection in the editor while a toolbar button is pressed.
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="rounded-xl border border-[#dfe5ee] bg-white overflow-hidden focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-[#f8fafc] px-2 py-1.5">
        {!source && (
          <>
            <button type="button" className={tool} title="Bold" onMouseDown={keep} onClick={() => run("bold")}>
              <Bold size={15} />
            </button>
            <button type="button" className={tool} title="Italic" onMouseDown={keep} onClick={() => run("italic")}>
              <Italic size={15} />
            </button>
            <button type="button" className={tool} title="Underline" onMouseDown={keep} onClick={() => run("underline")}>
              <Underline size={15} />
            </button>
            <span className="mx-1 h-5 w-px bg-line" />
            <select
              className="h-8 rounded-lg border-0 bg-transparent px-2 text-sm text-slate-600 hover:bg-sky focus:outline-none"
              title="Text size"
              value=""
              onChange={(e) => e.target.value && setSize(e.target.value)}
            >
              <option value="">Size</option>
              {SIZES.map(([px, label]) => (
                <option key={px} value={px}>
                  {label} ({px})
                </option>
              ))}
            </select>
            <label className={`${tool} relative cursor-pointer`} title="Text colour" onMouseDown={keep}>
              <span className="h-4 w-4 rounded-full border border-black/10" style={{ background: color }} />
              <input
                type="color"
                className="absolute inset-0 opacity-0 cursor-pointer"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  run("foreColor", e.target.value);
                }}
              />
            </label>
            <span className="mx-1 h-5 w-px bg-line" />
            <button type="button" className={tool} title="Link" onMouseDown={keep} onClick={link}>
              <Link2 size={15} />
            </button>
            <button type="button" className={tool} title="Bulleted list" onMouseDown={keep} onClick={() => run("insertUnorderedList")}>
              <List size={15} />
            </button>
            <button type="button" className={tool} title="Clear formatting" onMouseDown={keep} onClick={() => run("removeFormat")}>
              <RemoveFormatting size={15} />
            </button>
          </>
        )}
        <button
          type="button"
          className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 h-8 text-xs font-medium ${
            source ? "bg-sky text-accent-2" : "text-slate-500 hover:bg-sky hover:text-accent-2"
          }`}
          onClick={() => {
            if (source) emitted.current = null; // re-render the edited source in the visual view
            setSource(!source);
          }}
        >
          <Code size={14} />
          {source ? "Back to visual" : "HTML"}
        </button>
      </div>
      {source ? (
        <textarea
          className="block w-full p-4 font-mono text-xs leading-5 outline-none resize-y"
          style={{ minHeight }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          contentEditable
          suppressContentEditableWarning
          className="p-4 outline-none [&_a]:text-accent-2 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
          style={{ minHeight, fontFamily: "Arial, Helvetica, sans-serif", fontSize: 12, color: "#4b5563" }}
          onInput={emit}
          onBlur={emit}
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
            emit();
          }}
        />
      )}
    </div>
  );
}
