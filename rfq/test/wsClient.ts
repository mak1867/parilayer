import type { RfqClientMsg, RfqServerMsg } from "@parilayer/sdk";
import WebSocket from "ws";

/** A WebSocket client that remembers what it received and can wait for a message type. */
export class Client {
  readonly inbox: RfqServerMsg[] = [];
  private waiters: { t: string; resolve: (m: RfqServerMsg) => void }[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as RfqServerMsg;
      this.inbox.push(msg);
      const i = this.waiters.findIndex((w) => w.t === msg.t);
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
    });
  }

  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new Client(ws);
  }

  send(msg: RfqClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  next<T extends RfqServerMsg["t"]>(t: T, timeoutMs = 4000): Promise<Extract<RfqServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}; got ${this.inbox.map((m) => m.t).join(",")}`)), timeoutMs);
      this.waiters.push({
        t,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<RfqServerMsg, { t: T }>);
        },
      });
    });
  }
}

