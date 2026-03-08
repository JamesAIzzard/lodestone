import { useState, useEffect } from 'react';
import { readSession, writeSession } from '@/lib/session-storage';

/**
 * Like `useState`, but persists the value to sessionStorage under `key`.
 * On mount, initialises from sessionStorage (falling back to `fallback`).
 * On every change, writes the new value back to sessionStorage.
 */
export function useSessionState<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readSession(key, fallback));

  useEffect(() => {
    writeSession(key, value);
  }, [key, value]);

  return [value, setValue];
}
