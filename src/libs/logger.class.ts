import {LogInterface, LogType} from '../interfaces/logger.interface';

// ─── Internal constants ───────────────────────────────────────────────────────

/**
 * Maximum byte size of a serialised log detail string before it is truncated.
 * Keeps individual log lines manageable in CloudWatch and avoids hitting the
 * 256 KB CloudWatch Logs event size limit.
 */
const MAX_LOG_DETAIL_BYTES = 10_000;

// ─── Logger ───────────────────────────────────────────────────────────────────

export class Logger implements LogInterface {
  /**
   * Maps field names to their masking function.  Any key present in this map
   * will have its value replaced before the log is emitted.
   * Add new entries here to protect additional sensitive fields.
   */
  private readonly maskConfig: Record<string, (value: string) => string>;

  constructor() {
    this.maskConfig = {
      password: this.maskAll,
      email: this.maskEmail,
      phoneNumber: this.maskPhoneNumber,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  public debug(msg: string, ...supportingDetails: unknown[]): void {
    this.emitLogMessage(LogType.DEBUG, msg, supportingDetails);
  }

  public info(msg: string, ...supportingDetails: unknown[]): void {
    this.emitLogMessage(LogType.INFO, msg, supportingDetails);
  }

  public warn(msg: string, ...supportingDetails: unknown[]): void {
    this.emitLogMessage(LogType.WARN, msg, supportingDetails);
  }

  public error(msg: string, ...supportingDetails: unknown[]): void {
    this.emitLogMessage(LogType.ERROR, msg, supportingDetails);
  }

  // ── Core emission ──────────────────────────────────────────────────────────

  /**
   * Filters sensitive fields, serialises the detail payload to a bounded JSON
   * string, and emits the log line via the appropriate `console` method.
   *
   * Serialising to JSON ourselves (rather than passing objects directly to
   * `console`) ensures:
   * - Nested objects appear in full instead of being collapsed to `[Object]`.
   * - `Error` instances include `name`, `message`, and `stack`.
   * - Payloads that exceed `MAX_LOG_DETAIL_BYTES` are truncated with a clear
   *   notice so CloudWatch lines stay within the 256 KB event limit.
   */
  private emitLogMessage(msgType: LogType, msg: string, supportingDetails: unknown[]): void {
    const logPrefix = `${msgType.toUpperCase()} ${msg}`;

    if (supportingDetails.length === 0) {
      // eslint-disable-next-line no-console
      console[msgType](logPrefix);
      return;
    }

    const maskedDetails = this.filterSensitiveData(supportingDetails);
    const serialisedDetail = this.serialiseLogDetail(maskedDetails);

    // eslint-disable-next-line no-console
    console[msgType](logPrefix, serialisedDetail);
  }

  // ── Serialisation ──────────────────────────────────────────────────────────

  /**
   * Serialises the masked detail array to a JSON string.
   *
   * - When the array has a single element, the element itself (not wrapped in
   *   an array) is serialised for cleaner output.
   * - If the JSON representation exceeds `MAX_LOG_DETAIL_BYTES`, the string is
   *   truncated and a suffix records the number of omitted bytes.
   * - Circular references and non-serialisable values are caught and replaced
   *   with a fallback message.
   */
  private serialiseLogDetail(maskedDetails: unknown[]): string {
    const payload = maskedDetails.length === 1 ? maskedDetails[0] : maskedDetails;

    try {
      const fullJson = JSON.stringify(payload, this.jsonReplacer.bind(this));

      if (fullJson.length <= MAX_LOG_DETAIL_BYTES) {
        return fullJson;
      }

      const omittedBytes = fullJson.length - MAX_LOG_DETAIL_BYTES;
      return (
        fullJson.substring(0, MAX_LOG_DETAIL_BYTES) +
        ` … [truncated — ${omittedBytes} additional bytes omitted, adjust MAX_LOG_DETAIL_BYTES to see more]`
      );
    } catch {
      return '[Logger: unable to serialise log detail — possible circular reference]';
    }
  }

  /**
   * Custom `JSON.stringify` replacer that converts non-plain-object types that
   * the default serialiser would otherwise lose or misrepresent.
   *
   * - `Error` → `{ name, message, stack }` (Error own-properties are not enumerable)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jsonReplacer(_key: string, value: unknown): any {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    return value;
  }

  // ── Sensitive data filtering ───────────────────────────────────────────────

  /**
   * Recursively walks every detail in the supporting-details array and applies
   * `maskSensitiveFields()` to each one.
   */
  private filterSensitiveData(details: unknown[]): unknown[] {
    return details.map((detail) => this.maskSensitiveFields(detail));
  }

  /**
   * Recursively replaces values whose key matches a `maskConfig` entry.
   *
   * Handles:
   * - `null` / primitives — returned as-is.
   * - `Error` instances   — returned as-is (the `jsonReplacer` handles them).
   * - Arrays              — each element is masked recursively.
   * - Plain objects       — each key is checked against `maskConfig`; nested
   *                         objects are masked recursively so sensitive fields
   *                         are protected regardless of nesting depth.
   */
  private maskSensitiveFields(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) return value;
    if (Array.isArray(value)) return value.map((item) => this.maskSensitiveFields(item));

    const maskedObject: Record<string, unknown> = {};
    for (const [fieldKey, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      maskedObject[fieldKey] = this.maskConfig[fieldKey]
        ? this.maskConfig[fieldKey](fieldValue as string)
        : this.maskSensitiveFields(fieldValue);
    }
    return maskedObject;
  }

  // ── Masking functions ──────────────────────────────────────────────────────

  /** Replaces the entire value with a fixed mask token. */
  private maskAll(_value: string): string {
    return '***MASKED***';
  }

  /**
   * Masks an email address while preserving enough characters to identify the
   * account without exposing the full address.
   *
   * | Local part length | Result example              |
   * |-------------------|-----------------------------|
   * | > 4 chars         | `jo*******os@example.com`   |
   * | 3–4 chars         | `j*******e@example.com`     |
   * | ≤ 2 chars         | `***@example.com`           |
   */
  private maskEmail(email: string): string {
    if (!email?.length) return email;

    const [localPart, domain] = email.split('@');

    if (localPart.length > 4) {
      return `${localPart.substring(0, 2)}*******${localPart.substring(localPart.length - 2)}@${domain}`;
    }
    if (localPart.length > 2) {
      return `${localPart.substring(0, 1)}*******${localPart.substring(localPart.length - 1)}@${domain}`;
    }

    return `***@${domain}`;
  }

  /**
   * Masks a phone number, retaining only the last four digits.
   *
   * @example `+34612345678` → `****5678`
   */
  private maskPhoneNumber(phoneNumber: string): string {
    if (phoneNumber?.length > 4) {
      return `****${phoneNumber.substring(phoneNumber.length - 4)}`;
    }
    return phoneNumber;
  }
}
