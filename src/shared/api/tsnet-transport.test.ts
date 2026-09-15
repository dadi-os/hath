import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { MeshTransport } from "./tsnet-transport";

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
