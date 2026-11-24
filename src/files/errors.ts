/** Rejection of an uploaded file. `status` is the HTTP status the upload route returns; `code` is machine-readable. */
export type RejectCode =
  | "bad_request"
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "signature_mismatch"
  | "not_text"
  | "encrypted"
  | "corrupt"
  | "no_text"
  | "zip_limits"
  | "timeout";

const STATUS: Record<RejectCode, 400 | 413 | 415 | 422> = {
  bad_request: 400,
  empty: 400,
  too_large: 413,
  unsupported_type: 415,
  signature_mismatch: 415,
  not_text: 415,
  encrypted: 422,
  corrupt: 422,
  no_text: 422,
  zip_limits: 422,
  timeout: 422,
};

export class FileRejected extends Error {
  readonly code: RejectCode;
  readonly status: 400 | 413 | 415 | 422;
  constructor(code: RejectCode, message: string) {
    super(message);
    this.name = "FileRejected";
    this.code = code;
    this.status = STATUS[code];
  }
}

/** XML/attribute escaping for everything that comes from a document and is shown to the model. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escaping for element text (quotes are harmless there, and stay readable for the model). */
export function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
