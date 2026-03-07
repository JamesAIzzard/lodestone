import { useCallback } from 'react';
import { useTiptapEditor } from '@/hooks/use-tiptap-editor';
import { Button } from '@/components/tiptap-ui-primitive/button';
import type { Editor } from '@tiptap/core';

// ── Icons (inline SVGs) ─────────────────────────────────────────────────────

/** Σ with a baseline — inline math */
function InlineMathIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 5H6l6 7-6 7h12" />
    </svg>
  );
}

/** Σ framed — block/display math */
function BlockMathIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M16 7H8l4 5-4 5h8" />
    </svg>
  );
}

// ── Shared helper ───────────────────────────────────────────────────────────

function getSelectedText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  if (from === to) return '';
  return editor.state.doc.textBetween(from, to, ' ');
}

// ── Inline Math Button ──────────────────────────────────────────────────────

export function InlineMathButton() {
  const { editor } = useTiptapEditor();

  const handleClick = useCallback(() => {
    if (!editor) return;
    const latex = getSelectedText(editor) || '\\LaTeX';
    editor.chain().focus().deleteSelection().insertInlineMath({ latex }).run();
  }, [editor]);

  return (
    <Button
      type="button"
      variant="ghost"
      tabIndex={-1}
      aria-label="Inline math"
      tooltip="Inline math ($...$)"
      onClick={handleClick}
      disabled={!editor?.isEditable}
    >
      <InlineMathIcon className="tiptap-button-icon" />
    </Button>
  );
}

// ── Block Math Button ───────────────────────────────────────────────────────

export function BlockMathButton() {
  const { editor } = useTiptapEditor();

  const handleClick = useCallback(() => {
    if (!editor) return;
    const latex = getSelectedText(editor) || '\\LaTeX';
    editor.chain().focus().deleteSelection().insertBlockMath({ latex }).run();
  }, [editor]);

  return (
    <Button
      type="button"
      variant="ghost"
      tabIndex={-1}
      aria-label="Block math"
      tooltip="Block math ($$...$$)"
      onClick={handleClick}
      disabled={!editor?.isEditable}
    >
      <BlockMathIcon className="tiptap-button-icon" />
    </Button>
  );
}
