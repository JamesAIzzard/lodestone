import { useCallback } from 'react';
import { useTiptapEditor } from '@/hooks/use-tiptap-editor';
import { Button } from '@/components/tiptap-ui-primitive/button';
import {
  isInTable,
  selectedRect,
  moveTableRow,
  moveTableColumn,
} from 'prosemirror-tables';

// ── Icons ────────────────────────────────────────────────────────────────────

function TableIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

function AddColumnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="12" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="20" y1="9" x2="20" y2="15" />
      <line x1="17" y1="12" x2="23" y2="12" />
    </svg>
  );
}

function RemoveColumnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="12" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="17" y1="12" x2="23" y2="12" />
    </svg>
  );
}

function AddRowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="12" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="17" x2="12" y2="23" />
    </svg>
  );
}

function RemoveRowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="12" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </svg>
  );
}

function DeleteTableIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  );
}

function MoveRowUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <polyline points="8,11 12,7 16,11" />
    </svg>
  );
}

function MoveRowDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <polyline points="8,13 12,17 16,13" />
    </svg>
  );
}

function MoveColumnLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <polyline points="11,8 7,12 11,16" />
    </svg>
  );
}

function MoveColumnRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <polyline points="13,8 17,12 13,16" />
    </svg>
  );
}

// ── Insert Table Button ──────────────────────────────────────────────────────

export function TableButton() {
  const { editor } = useTiptapEditor();

  const handleClick = useCallback(() => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  }, [editor]);

  return (
    <Button
      type="button"
      variant="ghost"
      tabIndex={-1}
      aria-label="Insert table"
      tooltip="Insert table"
      onClick={handleClick}
      disabled={!editor?.isEditable}
    >
      <TableIcon className="tiptap-button-icon" />
    </Button>
  );
}

// ── Table editing buttons (visible only when cursor is in a table) ────────────

export function AddColumnButton() {
  const { editor } = useTiptapEditor();
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Add column" tooltip="Add column after"
      onClick={() => editor?.chain().focus().addColumnAfter().run()}
      disabled={!editor?.can().addColumnAfter()}>
      <AddColumnIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function RemoveColumnButton() {
  const { editor } = useTiptapEditor();
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Remove column" tooltip="Delete column"
      onClick={() => editor?.chain().focus().deleteColumn().run()}
      disabled={!editor?.can().deleteColumn()}>
      <RemoveColumnIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function AddRowButton() {
  const { editor } = useTiptapEditor();
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Add row" tooltip="Add row after"
      onClick={() => editor?.chain().focus().addRowAfter().run()}
      disabled={!editor?.can().addRowAfter()}>
      <AddRowIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function RemoveRowButton() {
  const { editor } = useTiptapEditor();
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Remove row" tooltip="Delete row"
      onClick={() => editor?.chain().focus().deleteRow().run()}
      disabled={!editor?.can().deleteRow()}>
      <RemoveRowIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function DeleteTableButton() {
  const { editor } = useTiptapEditor();
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Delete table" tooltip="Delete table"
      onClick={() => editor?.chain().focus().deleteTable().run()}
      disabled={!editor?.can().deleteTable()}>
      <DeleteTableIcon className="tiptap-button-icon" />
    </Button>
  );
}

// ── Move row / column buttons ─────────────────────────────────────────────────

/** Returns { row, col, totalRows, totalCols } for the cursor's cell, or null */
function getCellPosition(editor: ReturnType<typeof useTiptapEditor>['editor']) {
  if (!editor) return null;
  const state = editor.view.state;
  try {
    if (!isInTable(state)) return null;
    const rect = selectedRect(state);
    return {
      row: rect.top,
      col: rect.left,
      totalRows: rect.map.height,
      totalCols: rect.map.width,
    };
  } catch {
    return null;
  }
}

export function MoveRowUpButton() {
  const { editor } = useTiptapEditor();
  const pos = getCellPosition(editor);
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Move row up" tooltip="Move row up"
      onClick={() => {
        if (!editor || !pos) return;
        moveTableRow({ from: pos.row, to: pos.row - 1 })(
          editor.view.state, editor.view.dispatch,
        );
      }}
      disabled={!pos || pos.row <= 0}>
      <MoveRowUpIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function MoveRowDownButton() {
  const { editor } = useTiptapEditor();
  const pos = getCellPosition(editor);
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Move row down" tooltip="Move row down"
      onClick={() => {
        if (!editor || !pos) return;
        moveTableRow({ from: pos.row, to: pos.row + 1 })(
          editor.view.state, editor.view.dispatch,
        );
      }}
      disabled={!pos || pos.row >= pos.totalRows - 1}>
      <MoveRowDownIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function MoveColumnLeftButton() {
  const { editor } = useTiptapEditor();
  const pos = getCellPosition(editor);
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Move column left" tooltip="Move column left"
      onClick={() => {
        if (!editor || !pos) return;
        moveTableColumn({ from: pos.col, to: pos.col - 1 })(
          editor.view.state, editor.view.dispatch,
        );
      }}
      disabled={!pos || pos.col <= 0}>
      <MoveColumnLeftIcon className="tiptap-button-icon" />
    </Button>
  );
}

export function MoveColumnRightButton() {
  const { editor } = useTiptapEditor();
  const pos = getCellPosition(editor);
  return (
    <Button type="button" variant="ghost" tabIndex={-1}
      aria-label="Move column right" tooltip="Move column right"
      onClick={() => {
        if (!editor || !pos) return;
        moveTableColumn({ from: pos.col, to: pos.col + 1 })(
          editor.view.state, editor.view.dispatch,
        );
      }}
      disabled={!pos || pos.col >= pos.totalCols - 1}>
      <MoveColumnRightIcon className="tiptap-button-icon" />
    </Button>
  );
}
