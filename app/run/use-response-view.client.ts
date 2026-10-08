"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { RunState } from "../../packages/core/src/run-kernel";
import { responseContentOf } from "./response-view";
import type { ResponseContent } from "./response-view";

const MARKDOWN_PREVIEW_STORAGE_KEY = "inference-lens:markdown-preview:v1";
/** How close to the bottom still counts as reading the latest output. */
const FOLLOW_THRESHOLD_PX = 56;

/**
 * How the single-run response is read: its content, the Markdown or Raw
 * preference, and whether the pane follows new output.
 *
 * The page calls this hook because Compose and Runs both mount the response
 * surface, and following must outlive either unmounting it. It owns no run
 * state; `runState` comes from the run session.
 */
export interface ResponseView extends ResponseContent {
  markdownPreview: boolean;
  setMarkdownPreview(markdown: boolean): void;
  following: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The scroll handler: following stops once the reader scrolls away. */
  updateFollowState(): void;
  /** Scrolls to the latest output now and resumes following. */
  jumpToLatest(): void;
  /** Resumes following; the next output change scrolls to it. */
  followLatest(): void;
}

export function useResponseView(runState: RunState | null): ResponseView {
  const [following, setFollowing] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [markdownPreviewLoaded, setMarkdownPreviewLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A scroll event from our own write can arrive after the next streamed
  // delta grows the document. That extra distance is not a reader scrolling
  // away. Remember the clamped position and ignore only that matching event.
  const automaticScrollRef = useRef<{ element: HTMLDivElement; top: number } | null>(null);
  const content = responseContentOf(runState);
  const { output, reasoning, completedToolCalls } = content;

  useEffect(() => {
    const previewId = window.setTimeout(() => {
      const saved = window.localStorage.getItem(MARKDOWN_PREVIEW_STORAGE_KEY);
      if (saved === "raw") setMarkdownPreview(false);
      setMarkdownPreviewLoaded(true);
    }, 0);
    return () => window.clearTimeout(previewId);
  }, []);

  useEffect(() => {
    if (!markdownPreviewLoaded) return;
    window.localStorage.setItem(
      MARKDOWN_PREVIEW_STORAGE_KEY,
      markdownPreview ? "markdown" : "raw",
    );
  }, [markdownPreview, markdownPreviewLoaded]);

  useEffect(() => {
    if (!following) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element && element.scrollTop !== element.scrollHeight - element.clientHeight) {
        element.scrollTop = element.scrollHeight;
        automaticScrollRef.current = { element, top: element.scrollTop };
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [completedToolCalls.length, output, following, reasoning]);

  function updateFollowState(): void {
    const element = scrollRef.current;
    if (!element) return;
    const automatic = automaticScrollRef.current;
    automaticScrollRef.current = null;
    if (automatic?.element === element && automatic.top === element.scrollTop) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distanceFromBottom < FOLLOW_THRESHOLD_PX);
  }

  function jumpToLatest(): void {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      automaticScrollRef.current = { element, top: element.scrollTop };
    }
    setFollowing(true);
  }

  return {
    ...content,
    markdownPreview,
    setMarkdownPreview,
    following,
    scrollRef,
    updateFollowState,
    jumpToLatest,
    followLatest: () => setFollowing(true),
  };
}
