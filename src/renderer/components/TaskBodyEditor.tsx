/**
 * TaskBodyEditor
 *
 * An embedded rich-text editor for task bodies.
 * Built on the TipTap Simple Editor template (adapted):
 *   - toolbar from @tiptap-ui / @tiptap-ui-primitive
 *   - tiptap-markdown for markdown round-trip storage
 *   - No theme toggle, no mobile view, no image upload
 */

import { useEffect, useRef } from 'react';
import { EditorContent, EditorContext, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TextAlign } from '@tiptap/extension-text-align';
import { Highlight } from '@tiptap/extension-highlight';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { Typography } from '@tiptap/extension-typography';
import { Selection } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';

// ── Tiptap UI components (installed as source) ─────────────────────────────
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from '@/components/tiptap-ui-primitive/toolbar';
import { HeadingDropdownMenu } from '@/components/tiptap-ui/heading-dropdown-menu';
import { ListDropdownMenu } from '@/components/tiptap-ui/list-dropdown-menu';
import { BlockquoteButton } from '@/components/tiptap-ui/blockquote-button';
import { CodeBlockButton } from '@/components/tiptap-ui/code-block-button';
import { ColorHighlightPopover } from '@/components/tiptap-ui/color-highlight-popover';
import { LinkPopover } from '@/components/tiptap-ui/link-popover';
import { MarkButton } from '@/components/tiptap-ui/mark-button';
import { TextAlignButton } from '@/components/tiptap-ui/text-align-button';
import { UndoRedoButton } from '@/components/tiptap-ui/undo-redo-button';

// ── Node styles ────────────────────────────────────────────────────────────
import '@/components/tiptap-node/blockquote-node/blockquote-node.scss';
import '@/components/tiptap-node/code-block-node/code-block-node.scss';
import '@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node.scss';
import '@/components/tiptap-node/list-node/list-node.scss';
import '@/components/tiptap-node/heading-node/heading-node.scss';
import '@/components/tiptap-node/paragraph-node/paragraph-node.scss';

// ── Editor shell styles (scoped — no global body overrides) ───────────────
import '@/components/task-body-editor.scss';

// ── Component ──────────────────────────────────────────────────────────────

interface TaskBodyEditorProps {
  /** Initial markdown content */
  initialContent: string;
  /** Called (debounced) when content changes; receives serialised markdown */
  onChange: (markdown: string) => void;
  /** Debounce delay in ms (default 800) */
  debounceMs?: number;
}

export function TaskBodyEditor({
  initialContent,
  onChange,
  debounceMs = 800,
}: TaskBodyEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const dirtyRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  // Periodic flush: saves every debounceMs while there are unsaved changes
  const lastContentRef = useRef(initialContent);
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      if (!dirtyRef.current || !editorRef.current) return;
      dirtyRef.current = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md: string = (editorRef.current.storage as any).markdown.getMarkdown();
      lastContentRef.current = md;
      onChangeRef.current(md);
    }, debounceMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [debounceMs]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, enableClickSelection: true },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      Typography,
      Selection,
      Markdown.configure({
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
        'aria-label': 'Task body',
        class: 'task-body-prose',
      },
    },
    onUpdate() {
      dirtyRef.current = true;
    },
  });
  editorRef.current = editor;

  // Re-populate if the task changes (e.g. navigating between tasks)
  useEffect(() => {
    if (editor && initialContent !== lastContentRef.current) {
      lastContentRef.current = initialContent;
      editor.commands.setContent(initialContent);
    }
  }, [editor, initialContent]);

  return (
    <div className="task-body-editor-shell">
    <EditorContext.Provider value={{ editor }}>
      {/* Toolbar */}
      <Toolbar className="task-body-toolbar">
        <ToolbarGroup>
          <UndoRedoButton action="undo" />
          <UndoRedoButton action="redo" />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <HeadingDropdownMenu levels={[1, 2, 3]} />
          <ListDropdownMenu types={['bulletList', 'orderedList', 'taskList']} />
          <BlockquoteButton />
          <CodeBlockButton />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <MarkButton type="bold" />
          <MarkButton type="italic" />
          <MarkButton type="strike" />
          <MarkButton type="code" />
          <MarkButton type="underline" />
          <ColorHighlightPopover />
          <LinkPopover />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <MarkButton type="superscript" />
          <MarkButton type="subscript" />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <TextAlignButton align="left" />
          <TextAlignButton align="center" />
          <TextAlignButton align="right" />
        </ToolbarGroup>

      </Toolbar>

      {/* Editor content */}
      <EditorContent
        editor={editor}
        role="presentation"
        className="task-body-content"
      />
    </EditorContext.Provider>
    </div>
  );
}
