/**
 * Hath as Ghar's Bluetooth radio.
 * Ghar long-polls commands; this loop runs them on the local adapter and
 * posts advertisements and notifications back.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GharClient } from "../../shared/api/ghar";
import type { GharRadioCommand } from "../../shared/api/types";

/** Lifecycle of one attached radio session. */
export type HathRadioHandle = {
  /** Release the session and stop scanning. */
  stop: () => void;
};

/** Ready and failure signals for the commission sheet. */
export type HathRadioHooks = {
  onReady: () => void;
  onError: (message: string) => void;
};

type RadioPayload = {
  address: string;
  value_b64?: string;
};

/** Shown on the next attach when the previous detach failed. */
let pendingStopError: string | null = null;

/**
 * Attach this computer as Ghar's radio and serve commands until {@link HathRadioHandle.stop}.
 * `onReady` fires after the session is open. `onError` fires once, then the loop stops.
 */
export function startHathRadio(
  client: GharClient,
  hooks: HathRadioHooks,
): HathRadioHandle {
  let stopped = false;
  let session: string | null = null;
  const unlistens: UnlistenFn[] = [];
  const recentAds = new Map<string, number>();

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!stopped) {
      stopped = true;
      hooks.onError(message);
    }
  };

    const halt = async () => {
      for (const unlisten of unlistens.splice(0)) {
        unlisten();
      }
      const id = session;
      session = null;
      let scanError: unknown = null;
      try {
        await invoke("radio_stop_scan");
      } catch (err) {
        scanError = err;
      }
      if (id) {
        try {
          await client.detachRadio(id);
        } catch (detachErr) {
          if (scanError) {
            const scan =
              scanError instanceof Error ? scanError.message : String(scanError);
            const detach =
              detachErr instanceof Error ? detachErr.message : String(detachErr);
            throw new Error(`${scan}; ${detach}`);
          }
          throw detachErr;
        }
      }
      if (scanError) {
        throw scanError instanceof Error ? scanError : new Error(String(scanError));
      }
    };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    void halt().catch((err: unknown) => {
      pendingStopError = err instanceof Error ? err.message : String(err);
    });
  };

  void run();

  return { stop };

  async function run(): Promise<void> {
    if (pendingStopError) {
      const message = pendingStopError;
      pendingStopError = null;
      hooks.onError(message);
      return;
    }
    try {
      const attached = await client.attachRadio();
      if (stopped) {
        await client.detachRadio(attached.session_id);
        return;
      }
      session = attached.session_id;
      unlistens.push(
        await listen<RadioPayload>("radio-advertisement", (event) => {
          void forward("advertisement", event.payload);
        }),
        await listen<RadioPayload>("radio-notification", (event) => {
          void forward("notification", event.payload);
        }),
        await listen<RadioPayload>("radio-disconnected", (event) => {
          void forward("disconnected", event.payload);
        }),
        await listen<string>("radio-error", (event) => {
          fail(event.payload);
        }),
      );
      if (stopped) {
        return;
      }
      hooks.onReady();
      await loop();
    } catch (err) {
      fail(err);
      if (session) {
        const id = session;
        session = null;
        try {
          await client.detachRadio(id);
        } catch (detachErr) {
          pendingStopError =
            detachErr instanceof Error ? detachErr.message : String(detachErr);
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped && session) {
      const polled = await client.pollRadio(session, 20_000);
      if (stopped || !session || !polled.command) {
        continue;
      }
      const command = polled.command;
      try {
        await runRadioCommand(command);
        await client.replyRadio({
          session_id: session,
          id: command.id,
          ok: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await client.replyRadio({
          session_id: session,
          id: command.id,
          ok: false,
          error: message,
        });
      }
    }
  }

  async function forward(
    kind: "advertisement" | "notification" | "disconnected",
    payload: RadioPayload,
  ): Promise<void> {
    if (!session || stopped) {
      return;
    }
    if (kind === "advertisement") {
      if (!payload.value_b64) {
        fail("bluetooth advertisement was missing service data");
        return;
      }
      const key = `${payload.address}:${payload.value_b64}`;
      const now = Date.now();
      const prev = recentAds.get(key);
      if (prev !== undefined && now - prev < 400) {
        return;
      }
      recentAds.set(key, now);
    }
    try {
      await client.postRadioEvent({
        session_id: session,
        kind,
        address: payload.address,
        ...(payload.value_b64 !== undefined ? { value_b64: payload.value_b64 } : {}),
      });
    } catch (err) {
      fail(err);
    }
  }
}

/** Run one command from Ghar against the local Bluetooth adapter. */
async function runRadioCommand(command: GharRadioCommand): Promise<void> {
  const address = command.args.address;
  switch (command.name) {
    case "scan":
      await invoke("radio_start_scan");
      return;
    case "stop_scan":
      await invoke("radio_stop_scan");
      return;
    case "connect":
      requireAddress(address);
      await invoke("radio_connect", { address });
      return;
    case "disconnect":
      requireAddress(address);
      await invoke("radio_disconnect", { address });
      return;
    case "subscribe":
      requireAddress(address);
      await invoke("radio_subscribe", { address });
      return;
    case "write": {
      requireAddress(address);
      const valueB64 = command.args.value_b64;
      if (!valueB64) {
        throw new Error("radio write is missing bytes");
      }
      await invoke("radio_write", { address, valueB64 });
      return;
    }
  }
}

/** Reject a GATT command that arrived without a peripheral address. */
function requireAddress(address: string | undefined): asserts address is string {
  if (!address) {
    throw new Error("radio command is missing an address");
  }
}
