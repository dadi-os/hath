import { describe, expect, it } from "vitest";
import {
  BundleDecodeError,
  decodeProvisioningBundle,
} from "./credentials";

const valid = {
  control_url: "http://headscale.dadi",
  auth_key: "hskey-test",
  node_name: "macbook",
};

function encode(payload: unknown): string {
  return btoa(JSON.stringify(payload));
}

describe("decodeProvisioningBundle", () => {
  it("decodes a base64 credentials bundle", () => {
    expect(decodeProvisioningBundle(`  ${encode(valid)}  \n`)).toEqual(valid);
  });

  it("rejects empty, truncated, and incomplete bundles", () => {
    expect(() => decodeProvisioningBundle("")).toThrow(BundleDecodeError);
    expect(() => decodeProvisioningBundle("%%%")).toThrow(BundleDecodeError);
    expect(() => decodeProvisioningBundle(btoa("not-json"))).toThrow(
      BundleDecodeError,
    );
    expect(() =>
      decodeProvisioningBundle(encode({ ...valid, auth_key: "" })),
    ).toThrow(BundleDecodeError);
  });
});
