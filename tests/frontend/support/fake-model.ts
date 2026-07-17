import type { AnyModel } from "@anywidget/types";

type MessageHandler = (message: unknown, buffers: DataView[]) => void;

export class FakeModel implements AnyModel {
  comm_live = true;
  current_frame = 0;
  readonly order: string[] = [];
  readonly sent: unknown[] = [];
  readonly widget_manager = {
    async get_model<T extends Record<string, unknown>>(_modelId: string): Promise<AnyModel<T>> {
      throw new Error("No child widgets are available in this test.");
    },
  };
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly changeHandlers = new Map<string, Set<(...args: any[]) => void>>();

  constructor(private readonly sessionId = "session-1") {}

  get(key: string): unknown {
    if (key === "session_id") {
      return this.sessionId;
    }
    if (key === "comm_live") {
      return this.comm_live;
    }
    if (key === "current_frame") {
      return this.current_frame;
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
      this.messageHandlers.add(callback as MessageHandler);
    } else {
      const handlers = this.changeHandlers.get(eventName) ?? new Set();
      handlers.add(callback);
      this.changeHandlers.set(eventName, handlers);
    }
  }

  off(eventName?: string | null, callback?: ((...args: any[]) => void) | null): void {
    if (eventName === undefined || eventName === null) {
      return;
    }
    this.order.push(`off:${eventName}`);
    if (eventName === "msg:custom") {
      if (callback === undefined || callback === null) {
        this.messageHandlers.clear();
      } else {
        this.messageHandlers.delete(callback as MessageHandler);
      }
    } else {
      const handlers = this.changeHandlers.get(eventName);
      if (callback === undefined || callback === null) {
        handlers?.clear();
      } else {
        handlers?.delete(callback);
      }
    }
  }

  save_changes(): void {}

  send(message: unknown, _callbacks?: unknown, _buffers?: ArrayBuffer[] | ArrayBufferView[]): void {
    this.order.push("send:ready");
    this.sent.push(message);
  }

  emit(message: unknown, buffers: DataView[] = []): void {
    for (const handler of this.messageHandlers) {
      handler(message, buffers);
    }
  }

  proxy(): AnyModel {
    return {
      get: this.get.bind(this),
      set: this.set.bind(this),
      save_changes: this.save_changes.bind(this),
      send: this.send.bind(this),
      on: this.on.bind(this),
      off: this.off.bind(this),
      widget_manager: this.widget_manager,
    };
  }

  emitEvent(eventName: string): void {
    for (const handler of this.changeHandlers.get(eventName) ?? []) {
      handler();
    }
  }

  setCommLive(commLive: boolean): void {
    this.comm_live = commLive;
    this.emitEvent("change:comm_live");
    this.emitEvent("comm_live_update");
  }
}
