export declare const logger: {
    debug: (...args: any[]) => void;
    log(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    count(_label: string): void;
    countReset(_label: string): void;
};
export default logger;
