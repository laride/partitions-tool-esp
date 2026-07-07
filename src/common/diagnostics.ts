export interface ParseWarning {
  fs: string;
  subject: string;
  reason: string;
  message: string;
}

export interface WarningOptions {
  onWarning?: (warning: ParseWarning) => void;
}

export interface WarningResult {
  warnings: ParseWarning[];
}

export interface WarningSink {
  warnings: ParseWarning[];
  onWarning?: (warning: ParseWarning) => void;
}

export function createWarningSink(onWarning?: (warning: ParseWarning) => void): WarningSink {
  return { warnings: [], onWarning };
}

export function emitWarning(
  sink: Pick<WarningSink, 'warnings' | 'onWarning'> | undefined,
  warning: ParseWarning,
): void {
  if (!sink) return;
  if (
    sink.warnings.some(
      (item) =>
        item.fs === warning.fs &&
        item.subject === warning.subject &&
        item.reason === warning.reason,
    )
  ) {
    return;
  }
  sink.warnings.push(warning);
  sink.onWarning?.(warning);
}

export function formatWarning(fs: string, subject: string, reason: string): ParseWarning {
  return {
    fs,
    subject,
    reason,
    message: `${fs}: ${subject}; ${reason}`,
  };
}
