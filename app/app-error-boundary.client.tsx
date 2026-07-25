"use client";

import { Component, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Keeps an unexpected render error from leaving the native webview blank.
 * Stream protocol errors are handled in the run flow; this is the final UI
 * safety net for every other rendering failure.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false };

  componentDidMount(): void {
    window.addEventListener("keydown", this.reloadWithShortcut);
  }

  componentWillUnmount(): void {
    window.removeEventListener("keydown", this.reloadWithShortcut);
  }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  private readonly reloadWithShortcut = (event: KeyboardEvent): void => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "r"
    ) {
      event.preventDefault();
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="app-error" role="alert">
          <div className="app-error-card">
            <span className="app-error-mark" aria-hidden="true">
              TL
            </span>
            <p className="eyebrow">Display recovery</p>
            <h1>Trace Lens needs to reload</h1>
            <p>
              An unexpected display error interrupted this view. Your saved
              profiles and secure credentials are still available.
            </p>
            <button
              className="button primary"
              onClick={() => window.location.reload()}
            >
              Reload Trace Lens
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
