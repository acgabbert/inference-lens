"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export type WorkbenchView = "request" | "response";

type WorkbenchShellProps = {
  request: ReactNode;
  response: ReactNode;
  view: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  responseStatus?: string;
};

const SPLIT_STORAGE_KEY = "inference-lens:workbench-split:v1";
const TRACE_HEIGHT_STORAGE_KEY = "inference-lens:trace-height:v1";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function WorkbenchShell({
  request,
  response,
  view,
  onViewChange,
  responseStatus,
}: WorkbenchShellProps) {
  const shellRef = useRef<HTMLElement>(null);
  const [requestWidth, setRequestWidth] = useState(48);

  useEffect(() => {
    const restoreId = window.setTimeout(() => {
      const saved = Number(window.localStorage.getItem(SPLIT_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= 34 && saved <= 66) {
        setRequestWidth(saved);
      }
    }, 0);
    return () => window.clearTimeout(restoreId);
  }, []);

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    const bounds = shell.getBoundingClientRect();
    const cursor = document.body.style.cursor;
    const selection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (pointerEvent: PointerEvent) => {
      const next = ((pointerEvent.clientX - bounds.left) / bounds.width) * 100;
      setRequestWidth(clamp(next, 34, 66));
    };
    const finish = (pointerEvent: PointerEvent) => {
      const next = clamp(
        ((pointerEvent.clientX - bounds.left) / bounds.width) * 100,
        34,
        66,
      );
      setRequestWidth(next);
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(next));
      document.body.style.cursor = cursor;
      document.body.style.userSelect = selection;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  return (
    <>
      <nav className="mobile-workbench-tabs" aria-label="Workbench view">
        <button
          className={view === "request" ? "active" : undefined}
          type="button"
          onClick={() => onViewChange("request")}
        >
          Request
        </button>
        <button
          className={view === "response" ? "active" : undefined}
          type="button"
          onClick={() => onViewChange("response")}
        >
          Response
          {responseStatus && (
            <span className={`mobile-status-dot ${responseStatus}`} />
          )}
        </button>
      </nav>
      <section
        className="workspace"
        ref={shellRef}
        style={
          {
            "--request-pane-width": `${requestWidth}%`,
          } as CSSProperties
        }
      >
        <div
          className={
            view === "request"
              ? "workbench-pane request-pane"
              : "workbench-pane request-pane mobile-pane-hidden"
          }
        >
          {request}
        </div>
        <button
          aria-label="Resize request and response panes"
          className="workbench-divider"
          type="button"
          onPointerDown={beginResize}
        >
          <span />
        </button>
        <div
          className={
            view === "response"
              ? "workbench-pane response-pane"
              : "workbench-pane response-pane mobile-pane-hidden"
          }
        >
          {response}
        </div>
      </section>
    </>
  );
}

type SideDrawerProps = {
  open: boolean;
  eyebrow?: string;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

export function SideDrawer({
  open,
  eyebrow = "Local configuration",
  title,
  description,
  onClose,
  children,
}: SideDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <aside
      aria-label={title}
      className="side-drawer"
      role="dialog"
    >
      <header className="side-drawer-header">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button
          aria-label={`Close ${title}`}
          className="icon-button"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="side-drawer-content">{children}</div>
    </aside>
  );
}

type PaneTab = {
  id: string;
  label: string;
  count?: number;
};

type PaneTabsProps = {
  label: string;
  tabs: PaneTab[];
  value: string;
  onChange: (value: string) => void;
  idPrefix?: string;
};

export function PaneTabs({
  label,
  tabs,
  value,
  onChange,
  idPrefix,
}: PaneTabsProps) {
  function moveSelection(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    onChange(tabs[nextIndex]!.id);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      );
    buttons?.[nextIndex]?.focus();
  }

  return (
    <div className="pane-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          aria-controls={idPrefix ? `${idPrefix}-${tab.id}-panel` : undefined}
          aria-selected={value === tab.id}
          className={value === tab.id ? "active" : undefined}
          id={idPrefix ? `${idPrefix}-${tab.id}-tab` : undefined}
          key={tab.id}
          role="tab"
          tabIndex={value === tab.id ? 0 : -1}
          type="button"
          onKeyDown={(event) => moveSelection(event, index)}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="tab-count">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

type ResizableTracePanelProps = {
  open: boolean;
  canOpen?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional view switcher, rendered between the toggle and the meta line. */
  tabs?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
};

export function ResizableTracePanel({
  open,
  canOpen = true,
  onOpenChange,
  tabs,
  summary,
  children,
}: ResizableTracePanelProps) {
  const [height, setHeight] = useState(265);

  useEffect(() => {
    const restoreId = window.setTimeout(() => {
      const saved = Number(
        window.localStorage.getItem(TRACE_HEIGHT_STORAGE_KEY),
      );
      if (Number.isFinite(saved) && saved >= 140 && saved <= 520) {
        setHeight(saved);
      }
    }, 0);
    return () => window.clearTimeout(restoreId);
  }, []);

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const cursor = document.body.style.cursor;
    const selection = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const move = (pointerEvent: PointerEvent) => {
      setHeight(clamp(startHeight + startY - pointerEvent.clientY, 140, 520));
    };
    const finish = (pointerEvent: PointerEvent) => {
      const next = clamp(
        startHeight + startY - pointerEvent.clientY,
        140,
        520,
      );
      setHeight(next);
      window.localStorage.setItem(TRACE_HEIGHT_STORAGE_KEY, String(next));
      document.body.style.cursor = cursor;
      document.body.style.userSelect = selection;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  return (
    <section
      className={[
        "trace-panel",
        open ? "open" : "",
        summary ? "has-summary" : "",
      ].filter(Boolean).join(" ")}
      style={{ "--trace-panel-height": `${height}px` } as CSSProperties}
    >
      {open && (
        <button
          aria-label="Resize run details"
          className="trace-resize-handle"
          type="button"
          onPointerDown={beginResize}
        >
          <span />
        </button>
      )}
      <header className="trace-header">
        <button
          aria-expanded={open}
          className="trace-toggle"
          disabled={!canOpen}
          type="button"
          onClick={() => onOpenChange(!open)}
        >
          <span className="trace-chevron" aria-hidden="true">
            {open ? "⌄" : "⌃"}
          </span>
          Run details
        </button>
        {tabs}
      </header>
      {summary && (
        <div className="trace-summary-row" aria-live="polite">
          {summary}
        </div>
      )}
      {open && <div className="trace-panel-content">{children}</div>}
    </section>
  );
}
