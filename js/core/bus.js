// App-wide event bus. Detail objects are passed straight to listeners.
const target = new EventTarget();

export const bus = {
  /** Subscribe; returns an unsubscribe function. */
  on(type, fn) {
    const handler = (e) => fn(e.detail);
    target.addEventListener(type, handler);
    return () => target.removeEventListener(type, handler);
  },
  once(type, fn) {
    const off = bus.on(type, (d) => { off(); fn(d); });
    return off;
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
};

/** Small helper for classes that extend EventTarget. */
export function emit(targetObj, type, detail) {
  targetObj.dispatchEvent(new CustomEvent(type, { detail }));
}
