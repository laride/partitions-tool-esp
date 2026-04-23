export class EspPartitionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EspPartitionsError';
  }
}

export class ValidationError extends EspPartitionsError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ParseError extends EspPartitionsError {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export class InputError extends EspPartitionsError {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export class NotAlignedError extends EspPartitionsError {
  constructor(message: string) {
    super(message);
    this.name = 'NotAlignedError';
  }
}
