/** Application-renderer bridge for native viewport leases (see native-viewport.ts). */

import { ipcRenderer } from 'electron'
import { NATIVE_VIEWPORT_IPC } from './native-viewport-ipc.ts'

/** Desktop content coordinates of the placeholder rectangle a plugin renders into. */
export interface NativeViewportBounds { x: number; y: number; width: number; height: number }

export interface NativeViewportBridge {
  /** False on platforms without the Win32 container support (and in tests). */
  readonly supported: boolean
  /** Create a container window; resolves its lease id and HWND (decimal string). */
  acquire(bounds: NativeViewportBounds): Promise<{ lease: string; hwnd: string }>
  /** Move the container to a new placeholder rectangle. */
  setBounds(lease: string, bounds: NativeViewportBounds): Promise<void>
  /** Destroy the container; the plugin engine stops when its parent disappears. */
  release(lease: string): Promise<void>
}

/** Unsupported-platform stub: acquire explains, the rest no-op so callers can ignore the flag. */
function unsupported(): NativeViewportBridge {
  const fail = async (): Promise<never> => { throw new Error('Native viewport unsupported on this platform') }
  return { supported: false, acquire: fail, setBounds: async () => {}, release: async () => {} }
}

/** Real bridge over the private desktop channels; main-process handlers re-validate the sender. */
export function createNativeViewportBridge(): NativeViewportBridge {
  if (process.platform !== 'win32') return unsupported()
  return {
    supported: true,
    acquire: bounds => ipcRenderer.invoke(NATIVE_VIEWPORT_IPC.acquire, bounds) as Promise<{ lease: string; hwnd: string }>,
    setBounds: (lease, bounds) => ipcRenderer.invoke(NATIVE_VIEWPORT_IPC.setBounds, lease, bounds) as Promise<void>,
    release: lease => ipcRenderer.invoke(NATIVE_VIEWPORT_IPC.release, lease) as Promise<void>,
  }
}
