import {LogInterface, LogType} from '../interfaces/logger.interface';

export class Logger implements LogInterface {
  private maskConfig: Record<string, (value: string) => string>;

  constructor() {
    this.maskConfig = {
      password: this.maskAll,
      email: this.maskEmail,
      phoneNumber: this.maskPhoneNumber,
    };
  }

  public debug(msg: string, ...supportingDetails: any[]): void {
    this.emitLogMessage(LogType.DEBUG, msg, supportingDetails);
  }

  public info(msg: string, ...supportingDetails: any[]): void {
    this.emitLogMessage(LogType.INFO, msg, supportingDetails);
  }

  public warn(msg: string, ...supportingDetails: any[]): void {
    this.emitLogMessage(LogType.WARN, msg, supportingDetails);
  }

  public error(msg: string, ...supportingDetails: any[]): void {
    this.emitLogMessage(LogType.ERROR, msg, supportingDetails);
  }

  /**
   * Filters sensitive data from the provided details.
   *
   * This method iterates over each detail and checks if it's an object.
   * If it is, it reduces the object to a new one where each key-value pair is checked against the maskConfig.
   * If the key exists in the maskConfig, the corresponding mask function is applied to the value.
   * If the key does not exist in the maskConfig, the original value is kept.
   *
   * @param {any[]} details - The details to filter.
   * @returns {any[]} The filtered details.
   */
  private filterSensitiveData(details: any[]): any[] {
    return details?.map((detail) => {
      if (typeof detail === 'object') {
        return Object.keys(detail).reduce((acc, key) => {
          acc[key] = this.maskConfig[key] ? this.maskConfig[key](detail[key]) : detail[key];
          return acc;
        }, {} as any);
      }
      return detail;
    });
  }

  private maskAll(_value: string): string {
    return '***MASKED***';
  }

  /**
   * Masks an email address to protect sensitive information.
   *
   * This method splits the email address into the local part and the domain.
   * If the local part has more than 4 characters, it masks all characters except for the first 2 and the last 2.
   * If the local part has more than 2 but less than 5 characters, it masks all characters except for the first and the last.
   * If the local part has 2 or less characters, it masks the entire local part.
   *
   * @param {string} email - The email address to mask.
   * @returns {string} The masked email address.
   */
  private maskEmail(email: string): string {
    if (!email?.length) {
      return email;
    }
    const [localPart, domain] = email.split('@');
    if (localPart.length > 4) {
      return `${localPart.substring(0, 2)}*******${localPart.substring(localPart.length - 2)}@${domain}`;
    } else if (localPart.length > 2) {
      return `${localPart.substring(0, 1)}*******${localPart.substring(localPart.length - 1)}@${domain}`;
    }

    return `***@${domain}`;
  }

  private maskPhoneNumber(phoneNumber: string): string {
    if (phoneNumber?.length > 4) {
      return `****${phoneNumber.substring(phoneNumber.length - 4)}`;
    }
    return phoneNumber;
  }

  private emitLogMessage(msgType: LogType, msg: string, supportingDetails: any[]): void {
    if (supportingDetails.length > 0) {
      const filteredDetails = this.filterSensitiveData(supportingDetails);
      // eslint-disable-next-line no-console
      console[msgType](`${msgType.toUpperCase()} ${msg}`, filteredDetails);
    } else {
      // eslint-disable-next-line no-console
      console[msgType](`${msgType.toUpperCase()} ${msg}`);
    }
  }
}
