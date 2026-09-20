import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { fetch } from "@tauri-apps/plugin-http";
import { MeshTransport } from "./tsnet-transport";
import { DIMAAG } from "./constants";

const creds = {
  control_url: "http://headscale.dadi",
  auth_key: "hskey-test",
  node_name: "macbook",
};

describe("MeshTransport.connect onboarding", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mesh_load_credentials") {
        return null;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
  });

  it("does not drop onboarding while mesh_start is in flight or after it fails", async () => {
    const transport = new MeshTransport();
    const flips: boolean[] = [];
    transport.onProvisioningNeeded((needed) => {
      flips.push(needed);
    });
    await transport.prepareProvisioning();
    expect(transport.needsProvisioningKey()).toBe(true);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mesh_start") {
        expect(transport.needsProvisioningKey()).toBe(true);
        throw new Error("UAC cancelled");
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });

    await expect(transport.connect(creds)).rejects.toThrow(/UAC cancelled/);
    expect(transport.needsProvisioningKey()).toBe(true);
    expect(transport.connectionState()).toBe("disconnected");
    expect(flips).toEqual([true]);
  });

  it("clears onboarding only after mesh_start succeeds", async () => {
    const transport = new MeshTransport();
    await transport.prepareProvisioning();

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mesh_start") {
        expect(transport.needsProvisioningKey()).toBe(true);
        return 0;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });

    await transport.connect(creds);
    expect(transport.needsProvisioningKey()).toBe(false);
    expect(transport.connectionState()).toBe("connected");
  });
});

describe("MeshTransport.request", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(fetch).mockReset();
  });

  it("uses the /@host proxy on a real port and keeps the mesh up if HTTP fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mesh_start") {
        return 4242;
      }
      if (cmd === "mesh_status") {
        return 1;
      }
      if (cmd === "mesh_load_credentials") {
        return creds;
      }
      if (cmd === "mesh_stop") {
        return;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    vi.mocked(fetch).mockRejectedValue(new Error("connect failed"));

    const transport = new MeshTransport();
    await transport.connect(creds);
    await expect(
      transport.request({
        baseUrl: DIMAAG,
        path: "/agents",
        method: "GET",
      }),
    ).rejects.toThrow(/connect failed/);

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4242/@dimaag.dadi/agents",
    );
    expect(transport.isActive()).toBe(true);
    expect(transport.connectionState()).toBe("connected");
    await transport.disconnect();
  });
});

describe("MeshTransport tunnel recover", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(fetch).mockReset();
  });

  it("re-runs mesh_start after a transport error while still joined", async () => {
    let starts = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mesh_start") {
        starts += 1;
        return 4242;
      }
      if (cmd === "mesh_status") {
        return 1;
      }
      if (cmd === "mesh_load_credentials") {
        return creds;
      }
      if (cmd === "mesh_stop") {
        return;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    vi.mocked(fetch).mockRejectedValue(new Error("connect failed"));

    const transport = new MeshTransport();
    await transport.connect(creds);
    expect(starts).toBe(1);

    await expect(
      transport.request({
        baseUrl: DIMAAG,
        path: "/agents",
        method: "GET",
      }),
    ).rejects.toThrow(/connect failed/);

    await waitMs(500);

    expect(starts).toBe(2);
    expect(transport.isActive()).toBe(true);
    expect(transport.connectionState()).toBe("connected");
    await transport.disconnect();
  });

  it("does not recover on application HTTP errors", async () => {
    let starts = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mesh_start") {
        starts += 1;
        return 4242;
      }
      if (cmd === "mesh_status") {
        return 1;
      }
      if (cmd === "mesh_load_credentials") {
        return creds;
      }
      if (cmd === "mesh_stop") {
        return;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "dimaag down",
    } as Response);

    const transport = new MeshTransport();
    await transport.connect(creds);
    await expect(
      transport.request({
        baseUrl: DIMAAG,
        path: "/health",
        method: "GET",
      }),
    ).rejects.toThrow(/HTTP 503/);

    await waitMs(500);
    expect(starts).toBe(1);
    expect(transport.connectionState()).toBe("connected");
    await transport.disconnect();
  });
});

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
