const PREFIX = '[mongoose-cache]';

function noop(..._args: any[]): void {}

export const logger = {
  debug: noop as (...args: any[]) => void,

  log(...args: any[]): void {
    console.log(PREFIX, ...args);
  },

  warn(...args: any[]): void {
    console.warn(PREFIX, ...args);
  },

  error(...args: any[]): void {
    console.error(PREFIX, ...args);
  },

  count(_label: string): void {},

  countReset(_label: string): void {}
};

export default logger;
