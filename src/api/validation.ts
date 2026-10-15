/** Runtime checks for the undocumented retailer API. Never include untrusted values in errors. */
export class ValidationError extends Error {
  constructor(label = "response") {
    super(`Invalid ${label}.`);
    this.name = "ValidationError";
  }
}

export function record(value: unknown, label = "response"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(label);
  return value as Record<string, unknown>;
}

export function array(value: unknown, label = "list"): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(label);
  return value;
}

export function string(value: unknown, label = "text"): string {
  if (typeof value !== "string") throw new ValidationError(label);
  return value;
}

export function finiteNumber(value: unknown, label = "number"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(label);
  return value;
}

export function boolean(value: unknown, label = "flag"): boolean {
  if (typeof value !== "boolean") throw new ValidationError(label);
  return value;
}

/** Preserve alphanumeric retailer IDs while normalizing observed numeric values to decimal strings. */
export function identifier(value: unknown, label = "identifier"): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError(label);
    return String(value);
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError(label);
  return value;
}

export function optional<T>(value: unknown, validate: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : validate(value);
}
