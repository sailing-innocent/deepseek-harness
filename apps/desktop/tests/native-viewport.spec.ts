import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  getDisplayMatching: vi.fn<(rect: { x: number; y: number; width: number; height: number }) => { scaleFactor: number }>(),
}))
vi.mock('electron', () => ({ screen: { getDisplayMatching: electron.getDisplayMatching } }))

import { DesktopNativeViewport, type NativeViewportBindings } from '../src/native-viewport.ts'
import type { BrowserWindow } from 'electron'

interface FakeBindings extends NativeViewportBindings {
  created: { parent: bigint; bounds: { x: number; y: number; width: number; height: number } }[]
  moved: { hwnd: bigint; bounds: { x: number; y: number; width: number; height: number } }[]
  raised: bigint[]
  destroyed: bigint[]
  alive: Set<bigint>
  next: bigint
}

function fakeBindings(): FakeBindings {
  const bindings = {
    created: [] as FakeBindings['created'],
    moved: [] as FakeBindings['moved'],
    raised: [] as bigint[],
    destroyed: [] as bigint[],
    alive: new Set<bigint>(),
    next: 0x1000n,
    createContainer(parent: bigint, bounds: { x: number; y: number; width: number; height: number }): bigint {
      bindings.created.push({ parent, bounds })
      const hwnd = bindings.next++
      bindings.alive.add(hwnd)
      return hwnd
    },
    move(hwnd: bigint, bounds: { x: number; y: number; width: number; height: number }): void {
      bindings.moved.push({ hwnd, bounds })
    },
    raise(hwnd: bigint): void { bindings.raised.push(hwnd) },
    destroy(hwnd: bigint): void { bindings.destroyed.push(hwnd); bindings.alive.delete(hwnd) },
    isAlive: (hwnd: bigint): boolean => bindings.alive.has(hwnd),
  }
  return bindings
}

type FakeOwner = EventEmitter & {
  webContents: EventEmitter & { zoomFactor: number }
  getNativeWindowHandle(): Buffer
  isDestroyed(): boolean
}

function fakeOwner(): FakeOwner {
  const owner = new EventEmitter() as FakeOwner
  owner.webContents = new EventEmitter() as FakeOwner['webContents']
  owner.webContents.zoomFactor = 1
  owner.getNativeWindowHandle = () => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(0xabcn, 0)
    return buffer
  }
  owner.isDestroyed = () => false
  return owner
}

beforeEach(() => {
  vi.useFakeTimers()
  electron.getDisplayMatching.mockReturnValue({ scaleFactor: 2 })
})

afterEach(() => { vi.useRealTimers() })

describe('DesktopNativeViewport', () => {
  it('reports unsupported with null bindings and rejects acquisitions', () => {
    const manager = new DesktopNativeViewport(null)
    expect(manager.supported).toBe(false)
    expect(() => manager.acquire(fakeOwner() as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 }))
      .toThrow(/unsupported/)
  })

  it('creates a container scaled to physical pixels and hands out a decimal hwnd', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    const owner = fakeOwner()
    const lease = manager.acquire(owner as unknown as BrowserWindow, { x: 10, y: 20, width: 300, height: 200 })
    expect(lease.hwnd).toBe('4096')
    expect(bindings.created).toEqual([{ parent: 0xabcn, bounds: { x: 20, y: 40, width: 600, height: 400 } }])
    expect(bindings.raised).toContain(4096n)
    expect(manager.activeCount).toBe(1)
  })

  it('moves and raises on setBounds with the lease scale', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    const owner = fakeOwner()
    const { lease } = manager.acquire(owner as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 })
    manager.setBounds(lease, { x: 5, y: 6, width: 50, height: 40 })
    expect(bindings.moved.at(-1)).toEqual({ hwnd: 4096n, bounds: { x: 10, y: 12, width: 100, height: 80 } })
    expect(bindings.raised.at(-1)).toBe(4096n)
    expect(() => manager.setBounds('unknown', { x: 0, y: 0, width: 1, height: 1 })).toThrow(/Unknown native viewport lease/)
  })

  it('clamps degenerate sizes so the engine never sees a zero-area parent', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    manager.acquire(fakeOwner() as unknown as BrowserWindow, { x: 0, y: 0, width: 1, height: 1 })
    expect(bindings.created[0]!.bounds).toEqual({ x: 0, y: 0, width: 8, height: 8 })
  })

  it('validates renderer bounds through the shared platform rules', () => {
    const manager = new DesktopNativeViewport(fakeBindings())
    expect(() => manager.acquire(fakeOwner() as unknown as BrowserWindow, { x: -1, y: 0, width: 10, height: 10 }))
      .toThrow(/Invalid Platform bounds/)
  })

  it('re-asserts z-order on the timer while a lease is alive and stops after release', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    const owner = fakeOwner()
    const { lease } = manager.acquire(owner as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 })
    const raisesAfterAcquire = bindings.raised.length
    vi.advanceTimersByTime(1500)
    expect(bindings.raised.length).toBeGreaterThan(raisesAfterAcquire)
    manager.release(lease)
    const raisesAfterRelease = bindings.raised.length
    vi.advanceTimersByTime(1500)
    expect(bindings.raised.length).toBe(raisesAfterRelease)
    expect(manager.activeCount).toBe(0)
  })

  it('destroys the container when the owner window closes', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    const owner = fakeOwner()
    manager.acquire(owner as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 })
    owner.emit('closed')
    expect(bindings.destroyed).toEqual([4096n])
    expect(manager.activeCount).toBe(0)
  })

  it('keeps an explicit release idempotent and detaches owner listeners', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    const owner = fakeOwner()
    const listenerCount = (): number => owner.listenerCount('closed') + owner.webContents.listenerCount('destroyed')
    const { lease } = manager.acquire(owner as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 })
    expect(listenerCount()).toBe(2)
    manager.release(lease)
    manager.release(lease)
    expect(bindings.destroyed).toEqual([4096n])
    expect(listenerCount()).toBe(0)
    owner.emit('closed')
    expect(bindings.destroyed).toEqual([4096n])
  })

  it('dispose destroys every lease and rejects further acquisitions', () => {
    const bindings = fakeBindings()
    const manager = new DesktopNativeViewport(bindings)
    const first = manager.acquire(fakeOwner() as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 })
    const second = manager.acquire(fakeOwner() as unknown as BrowserWindow, { x: 0, y: 0, width: 100, height: 100 })
    manager.dispose()
    expect(bindings.destroyed.sort()).toEqual([first.hwnd, second.hwnd].map(BigInt).sort())
    expect(() => manager.setBounds(first.lease, { x: 0, y: 0, width: 100, height: 100 })).toThrow(/Unknown/)
  })
})
