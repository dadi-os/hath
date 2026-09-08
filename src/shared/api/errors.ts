/** Thrown when no provisioning credentials are stored (or override missing). */
export class NotProvisionedError extends Error {
  constructor(message = "Provisioning required") {
    super(message);
    this.name = "NotProvisionedError";
  }
}
