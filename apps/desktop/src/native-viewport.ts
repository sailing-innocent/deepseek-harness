/**
 * Native viewport leases: bare Win32 container windows a plugin renders into.
 *
 * The shell never touches rendering. It creates an empty `STATIC` child window
 * at a renderer-supplied rectangle and hands the container HWND to the caller,
 * which passes it (through its own Host channel) to a native engine that
 * parents its swapchain viewport into the container — the same embedding
 * contract as the RoboCute Electron sample, where the engine viewport layer is
 * designed for cross-process borrowed HWNDs and polls its parent client rect
 * to rebuild the swapchain on resize.
 *
 * Windows-only. The container must stay above Chromium's compositor
 * ("Intermediate D3D Window") sibling, so every geometry change re-asserts
 * `HWND_TOP` and a slow timer keeps re-asserting while any lease is alive —
 * mirroring the engine-side re-assert the sample runs every 60 frames.
 *
 * The module loads on every platform like the repo's other win32 modules:
 * koffi itself is imported lazily inside the loader, so non-Windows processes
 * never load it.
 */
import { randomUUID } from 'node:crypto'
import { screen, type BrowserWindow } from 'electron'
import { platformBounds, type PlatformBounds } from './platform-view.ts'

/** Synchronous Win32 surface the lease manager needs; real impl via koffi, fakes in tests. */
export interface NativeViewportBindings {
  /** Create a child container window; returns 0n on failure. */
  createContainer(parent: bigint, bounds: PlatformBounds): bigint
  /** Move (in physical pixels) and repaint. */
  move(hwnd: bigint, bounds: PlatformBounds): void
  /** Keep the container above the Chromium compositor sibling. */
  raise(hwnd: bigint): void
  /** Destroy the container; engine children observe parent death and stop themselves. */
  destroy(hwnd: bigint): void
  isAlive(hwnd: bigint): boolean
}

/** A container lease handed to the application renderer. */
export interface NativeViewportLease { lease: string; hwnd: string }

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary { func(convention: string, name: string, result: string, args: string[]): KoffiFunction }
interface Koffi {
  load(path: string): KoffiLibrary
}

const WS_CHILD = 0x4000_0000
const WS_VISIBLE = 0x1000_0000
const WS_CLIPSIBLINGS = 0x0400_0000
/** `HWND_TOP`: raise above sibling children without activating. */
const SWP_NOMOVE = 0x0001
const SWP_NOSIZE = 0x0002
const SWP_NOACTIVATE = 0x0010
/** Re-assert z-order at 2 Hz; Chromium re-creates its compositor window on moves. */
const RAISE_INTERVAL_MS = 500
const MIN_CONTAINER_SIZE = 8

let cachedBindings: NativeViewportBindings | null | undefined

/** Load the user32 bindings once; null off Windows or when koffi is unavailable. */
export async function loadNativeViewportBindings(): Promise<NativeViewportBindings | null> {
  if (process.platform !== 'win32') return null
  if (cachedBindings !== undefined) return cachedBindings
  try {
    const koffi = ((await import('koffi')) as { default: Koffi }).default
    const user32 = koffi.load('user32.dll')
    const createWindowExA = user32.func('__stdcall', 'CreateWindowExA', 'void *', [
      'uint32', 'str', 'str', 'uint32', 'int', 'int', 'int', 'int', 'void *', 'void *', 'void *', 'void *',
    ])
    const setWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int', ['void *', 'void *', 'int', 'int', 'int', 'int', 'uint32'])
    const moveWindow = user32.func('__stdcall', 'MoveWindow', 'int', ['void *', 'int', 'int', 'int', 'int', 'int'])
    const destroyWindow = user32.func('__stdcall', 'DestroyWindow', 'int', ['void *'])
    const isWindow = user32.func('__stdcall', 'IsWindow', 'int', ['void *'])
    const toBigInt = (value: unknown): bigint => BigInt(value as bigint | number)
    cachedBindings = {
      createContainer: (parent, bounds) => toBigInt(createWindowExA(
        0, 'STATIC', null, WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        bounds.x, bounds.y, bounds.width, bounds.height,
        parent, null, null, null,
      )),
      move: (hwnd, bounds) => {
        moveWindow(hwnd, bounds.x, bounds.y, bounds.width, bounds.height, 1)
      },
      raise: (hwnd) => { setWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) },
      destroy: (hwnd) => { destroyWindow(hwnd) },
      isAlive: hwnd => isWindow(hwnd) !== 0,
    }
  } catch {
    cachedBindings = null
  }
  return cachedBindings
}

/** Read an HWND out of an Electron native window handle buffer. */
function readHwnd(owner: BrowserWindow): bigint {
  return owner.getNativeWindowHandle().readBigUInt64LE(0)
}

/**
 * Owns the live containers of one shell process.
 * Geometry arrives in desktop content coordinates and is scaled to physical
 * pixels per call: `webContents.zoomFactor × display.scaleFactor`.
 */
export class DesktopNativeViewport {
  private readonly leases = new Map<string, {
    hwnd: bigint
    owner: BrowserWindow
    /** Last known placeholder rectangle in content coordinates. */
    dip: PlatformBounds
    detachOwner: () => void
  }>()
  private raiseTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly bindings: NativeViewportBindings | null) {}

  /** Create the manager with real Win32 bindings; null bindings report unsupported. */
  static async load(): Promise<DesktopNativeViewport> {
    return new DesktopNativeViewport(await loadNativeViewportBindings())
  }

  /** Whether this shell can lease native viewport containers on this platform. */
  get supported(): boolean { return this.bindings !== null }

  /**
   * Create a container child window in the owner client area.
   * @param owner - application window hosting the container.
   * @param bounds - renderer rectangle in desktop content coordinates.
   * @returns the lease and the container HWND as a decimal string (JS number safety).
   */
  acquire(owner: BrowserWindow, bounds: PlatformBounds): NativeViewportLease {
    const bindings = this.bindings
    if (bindings === null || this.disposed) throw new Error('Native viewport unsupported on this platform')
    if (owner.isDestroyed()) throw new Error('Native viewport owner destroyed')
    bounds = platformBounds(bounds)
    const physical = physicalBounds(bounds, this.scale(owner, bounds))
    const hwnd = bindings.createContainer(readHwnd(owner), physical)
    if (hwnd === 0n) throw new Error('Native viewport container creation failed')
    const lease = randomUUID()
    const drop = (): void => { this.release(lease) }
    owner.once('closed', drop)
    owner.webContents.once('render-process-gone', drop)
    owner.webContents.once('destroyed', drop)
    this.leases.set(lease, {
      hwnd, owner, dip: bounds,
      detachOwner: () => {
        owner.removeListener('closed', drop)
        owner.webContents.removeListener('render-process-gone', drop)
        owner.webContents.removeListener('destroyed', drop)
      },
    })
    bindings.raise(hwnd)
    this.startRaiseTimer()
    return { lease, hwnd: hwnd.toString() }
  }

  /** Move one lease to a new renderer rectangle; re-asserts z-order above the compositor. */
  setBounds(lease: string, bounds: PlatformBounds): void {
    bounds = platformBounds(bounds)
    const record = this.leases.get(lease)
    if (record === undefined || this.bindings === null) throw new Error('Unknown native viewport lease')
    if (!this.bindings.isAlive(record.hwnd)) return
    record.dip = bounds
    this.bindings.move(record.hwnd, physicalBounds(bounds, this.scale(record.owner, record.dip)))
    this.bindings.raise(record.hwnd)
  }

  /** Destroy one container; the plugin engine observes its parent dying and stops. */
  release(lease: string): void {
    const record = this.leases.get(lease)
    if (record === undefined || this.bindings === null) return
    this.leases.delete(lease)
    record.detachOwner()
    if (this.bindings.isAlive(record.hwnd)) this.bindings.destroy(record.hwnd)
    if (this.leases.size === 0) this.stopRaiseTimer()
  }

  /** Destroy every container; called from the quit path. */
  dispose(): void {
    this.disposed = true
    for (const lease of [...this.leases.keys()]) this.release(lease)
    this.stopRaiseTimer()
  }

  /** @returns live lease count; tests and diagnostics read it. */
  get activeCount(): number { return this.leases.size }

  /** Content-to-physical scale for the rectangle's current display: zoom × DPI. */
  private scale(owner: BrowserWindow, dip: PlatformBounds): number {
    if (owner.isDestroyed()) return 1
    const display = screen.getDisplayMatching(dip)
    return owner.webContents.zoomFactor * display.scaleFactor
  }

  private startRaiseTimer(): void {
    if (this.raiseTimer !== undefined || this.bindings === null) return
    this.raiseTimer = setInterval(() => {
      for (const record of this.leases.values()) {
        if (this.bindings !== null && this.bindings.isAlive(record.hwnd)) this.bindings.raise(record.hwnd)
      }
    }, RAISE_INTERVAL_MS)
    this.raiseTimer.unref()
  }

  private stopRaiseTimer(): void {
    if (this.raiseTimer === undefined) return
    clearInterval(this.raiseTimer)
    this.raiseTimer = undefined
  }
}

/** Scale content coordinates to physical pixels and clamp degenerate sizes. */
function physicalBounds(bounds: PlatformBounds, scale: number): PlatformBounds {
  const round = (n: number): number => Math.round(n * scale)
  const size = (n: number): number => Math.max(MIN_CONTAINER_SIZE, round(n))
  return { x: round(bounds.x), y: round(bounds.y), width: size(bounds.width), height: size(bounds.height) }
}
