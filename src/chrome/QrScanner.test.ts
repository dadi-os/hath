import { describe, expect, it } from "vitest";
import { cameraFailureMessage, qrVideoConstraint } from "./QrScanner";

describe("qrVideoConstraint", () => {
  it("does not demand a rear camera on desktop", () => {
    expect(qrVideoConstraint("desktop")).toBe(true);
  });

  it("prefers the rear camera on mobile", () => {
    expect(qrVideoConstraint("mobile")).toEqual({
      facingMode: { ideal: "environment" },
    });
  });
});

describe("cameraFailureMessage", () => {
  it("distinguishes permission, missing camera, and in-use failures", () => {
    expect(cameraFailureMessage(new DOMException("denied", "NotAllowedError"))).toMatch(
      /permission denied/i,
    );
    expect(
      cameraFailureMessage(new DOMException("overconstrained", "OverconstrainedError")),
    ).toMatch(/No camera matched/);
    expect(
      cameraFailureMessage(new DOMException("busy", "NotReadableError")),
    ).toMatch(/in use/);
  });
});
