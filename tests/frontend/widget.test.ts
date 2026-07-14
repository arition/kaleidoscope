import type { AnyModel } from "@anywidget/types";
import { describe, expect, it } from "vitest";

import { render } from "../../frontend/index.js";

type MessageHandler = (message: unknown, buffers: DataView[]) => void;

class FakeModel implements AnyModel {
  readonly order: string[] = [];
  readonly sent: unknown[] = [];
  readonly widget_manager = {
    async get_model<T extends Record<string, unknown>>(
      _modelId: string,
    ): Promise<AnyModel<T>> {
      throw new Error("No child widgets are available in this test.");
    },
  };
  private messageHandler: MessageHandler | undefined;

  get(key: string): unknown {
    if (key === "session_id") {
      return "session-1";
    }
    return undefined;
  }

  set(_key: string, _value: unknown): void {}

  on(eventName: "msg:custom", callback: MessageHandler): void;
  on(eventName: `change:${string}`, callback: () => void): void;
  on(eventName: string, callback: (...args: any[]) => void): void;
  on(eventName: string, callback: (...args: any[]) => void): void {
    this.order.push(`on:${eventName}`);
    if (eventName === "msg:custom") {
      this.messageHandler = callback as MessageHandler;
    }
  }

  off(
    eventName?: string | null,
    callback?: ((...args: any[]) => void) | null,
  ): void {
    if (eventName === undefined || eventName === null) {
      return;
    }
    this.order.push(`off:${eventName}`);
    if (eventName === "msg:custom" && this.messageHandler === callback) {
      this.messageHandler = undefined;
    }
  }

  save_changes(): void {}

  send(
    message: unknown,
    _callbacks?: unknown,
    _buffers?: ArrayBuffer[] | ArrayBufferView[],
  ): void {
    this.order.push("send:ready");
    this.sent.push(message);
  }

  emit(message: unknown): void {
    this.messageHandler?.(message, []);
  }
}

describe("widget render", () => {
  it("registers the custom message listener before sending ready", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });

    expect(model.order.slice(0, 2)).toEqual(["on:msg:custom", "send:ready"]);
    expect(model.sent).toEqual([
      {
        protocol: 1,
        type: "ready",
        session_id: "session-1",
        capabilities: {
          image_bitmap: false,
          webp: false,
        },
      },
    ]);
  });

  it("renders an initialized placeholder after metadata", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    expect(element.textContent).toContain("Initializing Kaleidoscope");

    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
    });

    expect(element.textContent).toContain("Kaleidoscope is ready");
    expect(element.querySelector("[role='status']")).not.toBeNull();
  });

  it("renders a terminal protocol error for invalid metadata", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 2,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
    });

    expect(element.textContent).toContain("Protocol error");
  });

  it("removes the model listener when the view is aborted", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    controller.abort();

    expect(model.order).toContain("off:msg:custom");
  });
});
