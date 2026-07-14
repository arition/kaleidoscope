import type { AnyModel } from "@anywidget/types";

type MessageHandler = (message: unknown, buffers: DataView[]) => void;

export class FakeModel implements AnyModel {
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

  emit(message: unknown, buffers: DataView[] = []): void {
    this.messageHandler?.(message, buffers);
  }
}
