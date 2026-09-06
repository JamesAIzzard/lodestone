export type MailLogDetails = Record<string, string | number | boolean>;
export type MailLogSink = (event: string, details: MailLogDetails) => void;

export function createMailLogger(
  accountHash: string,
  sink: MailLogSink = defaultSink,
): MailLogSink {
  return (event, details) => {
    rejectAddress(event);
    for (const value of Object.values(details)) {
      if (typeof value === 'string') rejectAddress(value);
    }
    sink(event, { ...details, account_hash: accountHash });
  };
}

function rejectAddress(value: string): void {
  if (value.includes('@')) throw new Error('Mail logs must not contain email addresses.');
}

function defaultSink(event: string, details: MailLogDetails): void {
  console.log(`[mail:${details.account_hash}] ${event}`, details);
}
