export type Logger = (msg: string) => void;

export const consoleLogger: Logger = (msg) => console.error(msg);
export const silentLogger: Logger = () => {};
