export type ClaudexorRuntimeErrorCode =
  | "RUNTIME_BUSY"
  | "RELEASE_MANIFEST_INVALID"
  | "RELEASE_SIGNATURE_INVALID"
  | "CHECKSUM_MISMATCH"
  | "ARCHIVE_INVALID"
  | "INSTALL_CONFLICT"
  | "RUNTIME_NOT_INSTALLED"
  | "RUNTIME_INTEGRITY_FAILED"
  | "COMPATIBILITY_BLOCKED"
  | "CREDENTIAL_ROUTE_BLOCKED"
  | "NO_ROLLBACK_TARGET"
  | "EXTERNAL_RUNTIME_INVALID"
  | "ACTIVATION_WRITE_FAILED";

export class ClaudexorRuntimeError extends Error {
  readonly code: ClaudexorRuntimeErrorCode;

  constructor(code: ClaudexorRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudexorRuntimeError";
    this.code = code;
  }
}
