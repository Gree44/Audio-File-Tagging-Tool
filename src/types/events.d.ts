// Make TS aware of our custom 'seekrel' event carrying a number detail
declare global {
  interface WindowEventMap {
    seekrel: CustomEvent<number>;
  }
}
export {};
