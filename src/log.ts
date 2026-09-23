export type Fields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

export function formatLine(level: string, event: string, fields: Fields, now: Date): string {
  const parts = [now.toISOString(), level, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = String(value);
    parts.push(`${key}=${text === '' || /[\s"=]/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(' ');
}

export function createLogger(
  write: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Logger {
  const at =
    (level: string) =>
    (event: string, fields: Fields = {}) =>
      write(formatLine(level, event, fields, now()));
  return { info: at('info'), warn: at('warn'), error: at('error') };
}
