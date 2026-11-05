import { useEffect, useRef, useState } from "react";

import { Button, Modal } from "../components/ui";

import { loadMath, renderMath } from "./math";

import type { MathSource, RenderedMath } from "./math";

const COLORS = [
  "#1e1e1e",
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#9c36b5",
];

const SIZES = [
  { label: "S", fontSize: 20 },
  { label: "M", fontSize: 28 },
  { label: "L", fontSize: 40 },
  { label: "XL", fontSize: 56 },
];

/** [label, LaTeX inserted at the caret] */
const STRUCTURES: [string, string][] = [
  ["a⁄b", "\\frac{a}{b}"],
  ["x²", "^{2}"],
  ["xᵢ", "_{i}"],
  ["√x", "\\sqrt{x}"],
  ["ⁿ√x", "\\sqrt[n]{x}"],
  ["Σ", "\\sum_{i=1}^{n}"],
  ["∫", "\\int_{a}^{b}"],
  ["lim", "\\lim_{x \\to \\infty}"],
  ["( )", "\\left( x \\right)"],
  ["[▦]", "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"],
  ["{ ", "\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}"],
  ["v→", "\\vec{v}"],
  ["AB̅", "\\overline{AB}"],
  ["∠", "\\angle "],
  ["°", "^{\\circ}"],
  ["align", "\\begin{aligned} a &= b \\\\ &= c \\end{aligned}"],
];

const SYMBOLS: [string, string][] = [
  ["α", "\\alpha"],
  ["β", "\\beta"],
  ["γ", "\\gamma"],
  ["θ", "\\theta"],
  ["λ", "\\lambda"],
  ["μ", "\\mu"],
  ["π", "\\pi"],
  ["σ", "\\sigma"],
  ["ω", "\\omega"],
  ["Δ", "\\Delta"],
  ["±", "\\pm"],
  ["×", "\\times"],
  ["÷", "\\div"],
  ["·", "\\cdot"],
  ["≤", "\\le"],
  ["≥", "\\ge"],
  ["≠", "\\ne"],
  ["≈", "\\approx"],
  ["∞", "\\infty"],
  ["→", "\\rightarrow"],
  ["⇒", "\\Rightarrow"],
  ["∈", "\\in"],
  ["∴", "\\therefore"],
  ["%", "\\%"],
];

const EXAMPLE = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";

export const MathDialog = ({
  initial,
  onSubmit,
  onClose,
}: {
  /** set when editing an existing formula */
  initial: MathSource | null;
  onSubmit: (source: MathSource, rendered: RenderedMath) => void;
  onClose: () => void;
}) => {
  const [latex, setLatex] = useState(initial?.latex ?? "");
  const [color, setColor] = useState(initial?.color ?? COLORS[0]);
  const [fontSize, setFontSize] = useState(initial?.fontSize ?? 28);
  const [display, setDisplay] = useState(initial?.display ?? true);
  const [rendered, setRendered] = useState<RenderedMath | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadMath()
      .then(() => setLoading(false))
      .catch((error) => {
        setLoading(false);
        setError(`Couldn't load the math engine: ${error.message}`);
      });
  }, []);

  // live preview
  useEffect(() => {
    if (loading) {
      return;
    }
    if (!latex.trim()) {
      setRendered(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      renderMath({ latex, color, fontSize, display })
        .then((result) => {
          if (!cancelled) {
            setRendered(result);
            setError(null);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setRendered(null);
            setError(error.message);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [latex, color, fontSize, display, loading]);

  const insertAtCaret = (snippet: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = latex.slice(0, start) + snippet + latex.slice(end);
    setLatex(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + snippet.length,
        start + snippet.length,
      );
    });
  };

  const submit = () => {
    if (rendered && !error) {
      onSubmit({ latex, color, fontSize, display }, rendered);
    }
  };

  return (
    <Modal
      title={initial ? "Edit math" : "Insert math"}
      onClose={onClose}
      width={640}
    >
      <div className="wb-math">
        <div className="wb-math__palette" aria-label="Structures">
          {STRUCTURES.map(([label, snippet]) => (
            <button
              key={snippet}
              type="button"
              title={snippet}
              onClick={() => insertAtCaret(snippet)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="wb-math__palette" aria-label="Symbols">
          {SYMBOLS.map(([label, snippet]) => (
            <button
              key={snippet}
              type="button"
              title={snippet}
              onClick={() => insertAtCaret(`${snippet} `)}
            >
              {label}
            </button>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="wb-math__input"
          value={latex}
          rows={3}
          spellCheck={false}
          autoCapitalize="none"
          placeholder={`LaTeX, e.g. ${EXAMPLE}`}
          onChange={(event) => setLatex(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="wb-math__preview" aria-live="polite">
          {loading ? (
            <span className="wb-muted">Loading the math engine…</span>
          ) : error ? (
            <span className="wb-math__error">{error}</span>
          ) : rendered ? (
            <img src={rendered.dataURL} alt={latex} />
          ) : (
            <button
              type="button"
              className="wb-math__example"
              onClick={() => setLatex(EXAMPLE)}
            >
              Try an example
            </button>
          )}
        </div>
        <div className="wb-math__options">
          <div className="wb-math__colors" role="radiogroup" aria-label="Color">
            {COLORS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={color === value}
                aria-label={value}
                className={color === value ? "is-active" : ""}
                style={{ background: value }}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
          <div className="wb-segmented" role="radiogroup" aria-label="Size">
            {SIZES.map((size) => (
              <button
                key={size.label}
                type="button"
                role="radio"
                aria-checked={fontSize === size.fontSize}
                className={fontSize === size.fontSize ? "is-active" : ""}
                onClick={() => setFontSize(size.fontSize)}
              >
                {size.label}
              </button>
            ))}
          </div>
          <label className="wb-math__display">
            <input
              type="checkbox"
              checked={display}
              onChange={(event) => setDisplay(event.target.checked)}
            />
            Display style
          </label>
        </div>
      </div>
      <div className="wb-modal__actions">
        <span className="wb-muted wb-small wb-math__hint">
          Ctrl+Enter to {initial ? "update" : "insert"}
        </span>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!rendered || !!error}
          onClick={submit}
        >
          {initial ? "Update" : "Insert"}
        </Button>
      </div>
    </Modal>
  );
};
